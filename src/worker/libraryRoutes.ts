/**
 * Cloud Recents / Library / Assets indexes (Phase 3.1).
 *
 * Storage: R2 JSON in the existing WHITEBOARD_ASSETS bucket
 *   library/{ownerKey}/boards.json
 *   library/{ownerKey}/assets.json
 *
 * Signed-in Clerk sessions only. PUT on a board may include X-Board-Host so
 * we can lift the Phase 2 24h scratch TTL on the Durable Object. The index
 * write is not treated as durable success until DO `savedToLibrary` is true.
 * Index files use R2 etags (If-Match / If-None-Match) with retry.
 */
import { parsePreviewAsset } from '../lib/whiteboard-preview-url'
import { r2ObjectKey } from './assetRoutes'
import { requireClerkWhiteboardAuth } from './clerkAuth'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const INDEX_WRITE_ATTEMPTS = 8
const META_SAVE_ATTEMPTS = 8
const META_SAVE_DELAY_MS = 250

type BoardEntry = {
	id: string
	title: string
	lastAccessedAt: string
	previewDataUrl?: string
}

type AssetEntry = {
	id: string
	title: string
	createdAt: string
	lastAccessedAt: string
	mimeType: string
	size?: number
	r2Key: string
	ownerKey: string
	sourceBoardIds?: string[]
}

type MarkSavedResult =
	| { ok: true }
	| { ok: false; status: number; error: string }

function boardsObjectKey(ownerKey: string): string {
	return `library/${ownerKey}/boards.json`
}

function assetsObjectKey(ownerKey: string): string {
	return `library/${ownerKey}/assets.json`
}

function corsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get('Origin')
	if (!origin) return {}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			'Content-Type, Content-Length, Authorization, X-Board-Host',
		Vary: 'Origin',
	}
}

function json(
	status: number,
	body: unknown,
	request: Request,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
		},
	})
}

function isBoardEntry(value: unknown): value is BoardEntry {
	if (!value || typeof value !== 'object') return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.id === 'string' &&
		UUID_RE.test(entry.id) &&
		typeof entry.title === 'string' &&
		typeof entry.lastAccessedAt === 'string'
	)
}

function isAssetEntry(value: unknown): value is AssetEntry {
	if (!value || typeof value !== 'object') return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.id === 'string' &&
		UUID_RE.test(entry.id) &&
		typeof entry.title === 'string' &&
		typeof entry.createdAt === 'string' &&
		typeof entry.lastAccessedAt === 'string' &&
		typeof entry.mimeType === 'string' &&
		typeof entry.r2Key === 'string' &&
		typeof entry.ownerKey === 'string'
	)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function laterIso(a: string, b: string): string {
	return Date.parse(a) >= Date.parse(b) ? a : b
}

function r2PutOnlyIf(etag: string | null): R2Conditional {
	return etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' }
}

async function readJsonArray<T>(
	bucket: R2Bucket,
	key: string,
	guard: (value: unknown) => value is T,
): Promise<{ entries: T[]; etag: string | null }> {
	const object = await bucket.get(key)
	if (!object) return { entries: [], etag: null }
	try {
		const parsed = (await object.json()) as unknown
		if (!Array.isArray(parsed)) {
			return { entries: [], etag: object.etag }
		}
		return { entries: parsed.filter(guard), etag: object.etag }
	} catch {
		return { entries: [], etag: object.etag }
	}
}

async function writeJsonArray(
	bucket: R2Bucket,
	key: string,
	entries: unknown[],
	etag: string | null,
): Promise<boolean> {
	const stored = await bucket.put(key, JSON.stringify(entries), {
		httpMetadata: {
			contentType: 'application/json',
			cacheControl: 'no-store',
		},
		onlyIf: r2PutOnlyIf(etag),
	})
	return stored !== null
}

async function mutateJsonArray<T>(
	bucket: R2Bucket,
	key: string,
	guard: (value: unknown) => value is T,
	mutate: (entries: T[]) => T[],
): Promise<{ ok: true; entries: T[] } | { ok: false }> {
	for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
		const { entries, etag } = await readJsonArray(bucket, key, guard)
		const next = mutate(entries)
		if (await writeJsonArray(bucket, key, next, etag)) {
			return { ok: true, entries: next }
		}
	}
	return { ok: false }
}

function sortByAccessed<T extends { lastAccessedAt: string }>(
	entries: T[],
): T[] {
	return [...entries].sort(
		(a, b) =>
			new Date(b.lastAccessedAt).getTime() -
			new Date(a.lastAccessedAt).getTime(),
	)
}

/**
 * Index keys this Clerk session may have written under. When the Google sub
 * lookup failed in the past, entries were saved under `google:{clerkUserId}`
 * instead of `google:{sub}`. GET must merge both so boards do not "vanish"
 * when identity resolution flips; missing rows are migrated into the
 * canonical key.
 */
function candidateOwnerKeys(auth: {
	ownerKey: string
	clerkUserId: string
}): string[] {
	return [...new Set([auth.ownerKey, `google:${auth.clerkUserId}`])]
}

async function readMergedBoards(
	bucket: R2Bucket,
	auth: { ownerKey: string; clerkUserId: string },
): Promise<BoardEntry[]> {
	const [canonical, ...legacyKeys] = candidateOwnerKeys(auth)
	const { entries } = await readJsonArray(
		bucket,
		boardsObjectKey(canonical!),
		isBoardEntry,
	)
	let merged = entries
	for (const key of legacyKeys) {
		const legacy = await readJsonArray(
			bucket,
			boardsObjectKey(key),
			isBoardEntry,
		)
		if (legacy.entries.length === 0) continue
		const known = new Set(merged.map((entry) => entry.id))
		const missing = legacy.entries.filter((entry) => !known.has(entry.id))
		if (missing.length === 0) continue
		merged = [...merged, ...missing]
		// Best-effort migration into the canonical index; legacy file stays.
		await mutateJsonArray(
			bucket,
			boardsObjectKey(canonical!),
			isBoardEntry,
			(boards) => {
				let next = boards
				for (const entry of missing) next = upsertBoardEntry(next, entry)
				return next
			},
		)
	}
	return merged
}

async function readMergedAssets(
	bucket: R2Bucket,
	auth: { ownerKey: string; clerkUserId: string },
): Promise<AssetEntry[]> {
	const [canonical, ...legacyKeys] = candidateOwnerKeys(auth)
	const { entries } = await readJsonArray(
		bucket,
		assetsObjectKey(canonical!),
		isAssetEntry,
	)
	let merged = entries
	for (const key of legacyKeys) {
		const legacy = await readJsonArray(
			bucket,
			assetsObjectKey(key),
			isAssetEntry,
		)
		if (legacy.entries.length === 0) continue
		const known = new Set(merged.map((entry) => entry.id))
		merged = [
			...merged,
			...legacy.entries.filter((entry) => !known.has(entry.id)),
		]
	}
	return merged
}

/** Recents/Library membership for this Clerk ownerKey (R2 index, not DO Owner). */
export async function libraryIndexContainsBoard(
	env: Env,
	ownerKey: string,
	boardId: string,
): Promise<boolean> {
	if (!ownerKey || !boardId || !env.WHITEBOARD_ASSETS) return false
	const { entries } = await readJsonArray(
		env.WHITEBOARD_ASSETS,
		boardsObjectKey(ownerKey),
		isBoardEntry,
	)
	return entries.some((entry) => entry.id === boardId)
}

function boardMetaUrl(request: Request, boardId: string): URL {
	const url = new URL(request.url)
	url.pathname = `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`
	url.search = ''
	url.searchParams.set('boardId', boardId)
	return url
}

function patchHeaders(request: Request): Headers {
	const headers = new Headers({ 'Content-Type': 'application/json' })
	const authorization = request.headers.get('Authorization')
	if (authorization) headers.set('Authorization', authorization)
	return headers
}

async function readSavedToLibrary(
	env: Env,
	request: Request,
	boardId: string,
): Promise<boolean> {
	const id = env.WHITEBOARDS.idFromName(boardId)
	const stub = env.WHITEBOARDS.get(id)
	const res = await stub.fetch(
		new Request(boardMetaUrl(request, boardId).toString(), {
			method: 'GET',
		}),
	)
	if (!res.ok) return false
	try {
		const body = (await res.json()) as { savedToLibrary?: unknown }
		return body.savedToLibrary === true
	} catch {
		return false
	}
}

/**
 * Hub Recents PUT after host is cleared. GET meta reveals `cloudOwnerKey`
 * only to the matching Owner — so this is not "any signed-in user + UUID".
 */
async function clerkRequestOwnsSavedBoard(
	env: Env,
	request: Request,
	boardId: string,
	ownerKey: string,
): Promise<boolean> {
	const id = env.WHITEBOARDS.idFromName(boardId)
	const stub = env.WHITEBOARDS.get(id)
	const res = await stub.fetch(
		new Request(boardMetaUrl(request, boardId).toString(), {
			method: 'GET',
			headers: patchHeaders(request),
		}),
	)
	if (!res.ok) return false
	try {
		const body = (await res.json()) as {
			savedToLibrary?: unknown
			cloudOwnerKey?: unknown
		}
		if (body.savedToLibrary !== true) return false
		if (typeof body.cloudOwnerKey !== 'string' || !body.cloudOwnerKey) {
			return false
		}
		if (body.cloudOwnerKey === ownerKey) return true
		const suffix = body.cloudOwnerKey.startsWith('google:')
			? body.cloudOwnerKey.slice('google:'.length)
			: body.cloudOwnerKey
		return (
			ownerKey === `google:${suffix}` ||
			ownerKey === suffix ||
			`google:${ownerKey}` === body.cloudOwnerKey
		)
	} catch {
		return false
	}
}

/**
 * Lift the 24h scratch TTL on the Durable Object. Fails closed unless
 * `savedToLibrary` is true — the library PUT must not succeed as durable
 * while the unsaved alarm is still armed. PATCH 403s until the creating
 * browser’s first WebSocket stores `meta:hostSecretHash`; we retry.
 */
async function tryMarkSavedToLibrary(
	env: Env,
	request: Request,
	boardId: string,
	ownerKey: string,
): Promise<MarkSavedResult> {
	const hostSecret = request.headers.get('X-Board-Host')?.trim()
	if (!hostSecret) {
		try {
			if (await clerkRequestOwnsSavedBoard(env, request, boardId, ownerKey)) {
				return { ok: true }
			}
			if (await readSavedToLibrary(env, request, boardId)) {
				return {
					ok: false,
					status: 403,
					error: 'Only the Owner can add this saved board to your library.',
				}
			}
		} catch {
			// Fall through to fail closed.
		}
		return {
			ok: false,
			status: 409,
			error:
				'Board is not saved to the library yet. Open the board and try again.',
		}
	}

	const id = env.WHITEBOARDS.idFromName(boardId)
	const stub = env.WHITEBOARDS.get(id)
	const forwardUrl = boardMetaUrl(request, boardId)
	forwardUrl.searchParams.set('hostSecret', hostSecret)

	const fallbackError =
		'Could not mark this board as saved. Open the board and try again.'
	let lastStatus = 503
	let lastError = fallbackError

	for (let attempt = 0; attempt < META_SAVE_ATTEMPTS; attempt++) {
		try {
			const res = await stub.fetch(
				new Request(forwardUrl.toString(), {
					method: 'PATCH',
					headers: patchHeaders(request),
					body: JSON.stringify({
						savedToLibrary: true,
						cloudOwnerKey: ownerKey,
					}),
				}),
			)
			let saved = false
			try {
				const body = (await res.json()) as {
					savedToLibrary?: unknown
					error?: unknown
				}
				saved = body.savedToLibrary === true
				if (typeof body.error === 'string' && body.error.trim()) {
					lastError = body.error
				}
			} catch {
				saved = false
			}
			if (res.ok && saved) return { ok: true }
			lastStatus = res.ok ? 409 : res.status
			if (res.status === 403 && lastError === fallbackError) {
				lastError = 'Host secret required. Open the board and try again.'
			}
		} catch {
			lastStatus = 503
			lastError = fallbackError
		}
		if (attempt < META_SAVE_ATTEMPTS - 1) {
			await sleep(META_SAVE_DELAY_MS)
		}
	}

	return { ok: false, status: lastStatus, error: lastError }
}

function upsertBoardEntry(
	boards: BoardEntry[],
	next: BoardEntry,
): BoardEntry[] {
	const copy = [...boards]
	const index = copy.findIndex((entry) => entry.id === next.id)
	const prev = index >= 0 ? copy[index] : undefined
	if (prev) {
		copy[index] = {
			...prev,
			...next,
			lastAccessedAt: laterIso(prev.lastAccessedAt, next.lastAccessedAt),
			previewDataUrl: next.previewDataUrl ?? prev.previewDataUrl,
		}
		return copy
	}
	copy.unshift(next)
	return copy
}

function upsertAssetEntry(
	assets: AssetEntry[],
	next: AssetEntry,
): AssetEntry[] {
	const copy = [...assets]
	const index = copy.findIndex((entry) => entry.id === next.id)
	const prev = index >= 0 ? copy[index] : undefined
	if (prev) {
		copy[index] = {
			...prev,
			...next,
			lastAccessedAt: laterIso(prev.lastAccessedAt, next.lastAccessedAt),
		}
		return copy
	}
	copy.unshift(next)
	return copy
}

/**
 * Handle /api/whiteboard/library/*
 * Returns null if the path is not a library route.
 */
export async function handleLibraryRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (!url.pathname.startsWith('/api/whiteboard/library')) return null

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders(request),
				'Access-Control-Max-Age': '86400',
			},
		})
	}

	const authResult = await requireClerkWhiteboardAuth(request, env)
	if (!authResult.ok) {
		const headers = new Headers(authResult.response.headers)
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})
		return new Response(authResult.response.body, {
			status: authResult.response.status,
			headers,
		})
	}

	const { ownerKey } = authResult.auth
	const bucket = env.WHITEBOARD_ASSETS

	const boardsList = url.pathname.match(
		/^\/api\/whiteboard\/library\/boards\/?$/i,
	)
	const boardOne = url.pathname.match(
		/^\/api\/whiteboard\/library\/boards\/([^/]+)\/?$/i,
	)
	const assetsList = url.pathname.match(
		/^\/api\/whiteboard\/library\/assets\/?$/i,
	)
	const assetOne = url.pathname.match(
		/^\/api\/whiteboard\/library\/assets\/([^/]+)\/?$/i,
	)

	if (boardsList) {
		if (request.method === 'GET') {
			const entries = await readMergedBoards(bucket, authResult.auth)
			return json(200, { boards: sortByAccessed(entries), ownerKey }, request)
		}
		if (request.method === 'PUT') {
			let body: unknown
			try {
				body = await request.json()
			} catch {
				return json(400, { error: 'Invalid JSON' }, request)
			}
			if (!isBoardEntry(body)) {
				return json(400, { error: 'Invalid board entry' }, request)
			}
			const next: BoardEntry = {
				id: body.id,
				title: body.title.trim() || 'Untitled board',
				lastAccessedAt: body.lastAccessedAt || new Date().toISOString(),
				previewDataUrl: body.previewDataUrl,
			}
			const marked = await tryMarkSavedToLibrary(
				env,
				request,
				next.id,
				ownerKey,
			)
			if (!marked.ok) {
				return json(marked.status, { error: marked.error }, request)
			}
			const written = await mutateJsonArray(
				bucket,
				boardsObjectKey(ownerKey),
				isBoardEntry,
				(boards) => upsertBoardEntry(boards, next),
			)
			if (!written.ok) {
				return json(
					409,
					{ error: 'Library index conflict, retry' },
					request,
				)
			}
			return json(200, { board: next }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	if (boardOne) {
		const boardId = decodeURIComponent(boardOne[1])
		if (!UUID_RE.test(boardId)) {
			return json(400, { error: 'Invalid board id' }, request)
		}
		if (request.method === 'DELETE') {
			const existing = (await readMergedBoards(bucket, authResult.auth)).find(
				(entry) => entry.id === boardId,
			)
			const preview = parsePreviewAsset(existing?.previewDataUrl)
			if (preview) {
				try {
					await bucket.delete(r2ObjectKey(preview.ownerKey, preview.assetId))
				} catch {
					// Still drop the index row; an orphaned JPEG is acceptable.
				}
			}
			// Remove from every candidate key or a merged legacy row would
			// resurrect the board on the next GET.
			for (const key of candidateOwnerKeys(authResult.auth)) {
				const written = await mutateJsonArray(
					bucket,
					boardsObjectKey(key),
					isBoardEntry,
					(boards) => boards.filter((entry) => entry.id !== boardId),
				)
				if (!written.ok) {
					return json(
						409,
						{ error: 'Library index conflict, retry' },
						request,
					)
				}
			}
			return json(200, { ok: true }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	if (assetsList) {
		if (request.method === 'GET') {
			const entries = await readMergedAssets(bucket, authResult.auth)
			return json(200, { assets: sortByAccessed(entries), ownerKey }, request)
		}
		if (request.method === 'PUT') {
			let body: unknown
			try {
				body = await request.json()
			} catch {
				return json(400, { error: 'Invalid JSON' }, request)
			}
			if (!isAssetEntry(body)) {
				return json(400, { error: 'Invalid asset entry' }, request)
			}
			if (body.ownerKey !== ownerKey) {
				return json(403, { error: 'ownerKey mismatch' }, request)
			}
			const next: AssetEntry = {
				id: body.id,
				title: body.title.trim() || 'Untitled asset',
				createdAt: body.createdAt || new Date().toISOString(),
				lastAccessedAt: body.lastAccessedAt || new Date().toISOString(),
				mimeType: body.mimeType,
				size: body.size,
				r2Key: body.r2Key,
				ownerKey,
				sourceBoardIds: body.sourceBoardIds,
			}
			const written = await mutateJsonArray(
				bucket,
				assetsObjectKey(ownerKey),
				isAssetEntry,
				(assets) => upsertAssetEntry(assets, next),
			)
			if (!written.ok) {
				return json(
					409,
					{ error: 'Library index conflict, retry' },
					request,
				)
			}
			return json(200, { asset: next }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	if (assetOne) {
		const assetId = decodeURIComponent(assetOne[1])
		if (!UUID_RE.test(assetId)) {
			return json(400, { error: 'Invalid asset id' }, request)
		}
		if (request.method === 'DELETE') {
			for (const key of candidateOwnerKeys(authResult.auth)) {
				const written = await mutateJsonArray(
					bucket,
					assetsObjectKey(key),
					isAssetEntry,
					(assets) => assets.filter((entry) => entry.id !== assetId),
				)
				if (!written.ok) {
					return json(
						409,
						{ error: 'Library index conflict, retry' },
						request,
					)
				}
			}
			return json(200, { ok: true }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	return json(404, { error: 'Not found' }, request)
}
