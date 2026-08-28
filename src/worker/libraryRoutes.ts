/**
 * Cloud Recents / Library / Assets indexes (Phase 3.1).
 *
 * Storage: normalized metadata in WHITEBOARD_LIBRARY (D1). Existing R2 JSON
 * indexes are imported lazily by libraryStore and are never mutated here.
 *
 * Signed-in Clerk sessions only. PUT on a board may include X-Board-Host so
 * we can lift the Phase 2 24h scratch TTL on the Durable Object. The index
 * write is not treated as durable success until DO `savedToLibrary` is true.
 */
import { parsePreviewAsset } from '../lib/whiteboard-preview-url'
import { r2ObjectKey } from './assetRoutes'
import { requireClerkWhiteboardAuth } from './clerkAuth'
import {
	deleteLibraryAsset,
	deleteLibraryBoard,
	getLibraryBoard,
	isLibraryAssetEntry,
	isLibraryBoardEntry,
	libraryContainsBoard,
	listLibraryAssets,
	listLibraryBoards,
	patchLibraryBoardPreview,
	upsertLibraryAsset,
	upsertLibraryBoard,
	LibraryStoreError,
	type LibraryAsset,
	type LibraryBoard,
} from './libraryStore'
import {
	JsonBodyError,
	jsonHeaders,
	jsonResponse,
	readBoundedJsonBody,
	withJsonHeaders,
} from './httpSecurity'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const META_SAVE_ATTEMPTS = 8
const META_SAVE_DELAY_MS = 250
const SHARE_CODE_REVOKE_ATTEMPTS = 3
const SHARE_CODE_REVOKE_DELAY_MS = 50

type BoardEntry = LibraryBoard
type AssetEntry = LibraryAsset

type MarkSavedResult =
	| { ok: true }
	| { ok: false; status: number; error: string }

function json(
	status: number,
	body: unknown,
	request: Request,
): Response {
	return jsonResponse(request, status, body, {
		methods: 'GET, PUT, PATCH, DELETE, OPTIONS',
	})
}

function isBoardEntry(value: unknown): value is BoardEntry {
	return isLibraryBoardEntry(value)
}

function isBoardPreviewPatch(
	value: unknown,
): value is { previewDataUrl: string } {
	if (!value || typeof value !== 'object') return false
	const previewDataUrl = (value as Record<string, unknown>).previewDataUrl
	return (
		typeof previewDataUrl === 'string' &&
		previewDataUrl.length > 0 &&
		previewDataUrl.length <= 1024
	)
}

function isAssetEntry(value: unknown): value is AssetEntry {
	return isLibraryAssetEntry(value)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
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

function libraryStoreError(request: Request, error: unknown): Response {
	if (error instanceof LibraryStoreError) {
		return json(503, { error: error.message }, request)
	}
	return json(503, { error: 'Library storage is temporarily unavailable' }, request)
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

/** Recents/Library membership for this Clerk ownerKey (D1, not DO Owner). */
export async function libraryIndexContainsBoard(
	env: Env,
	ownerKeys: string | string[],
	boardId: string,
): Promise<boolean> {
	if (!boardId || !env.WHITEBOARD_LIBRARY) return false
	try {
		return await libraryContainsBoard(env, ownerKeys, boardId)
	} catch {
		// Owner inference in the DO must fail closed if D1/import is unavailable.
		return false
	}
}

function boardMetaUrl(request: Request, boardId: string): URL {
	const url = new URL(request.url)
	url.pathname = `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`
	url.search = ''
	url.searchParams.set('boardId', boardId)
	return url
}

/** Drop the board's KV share-code mapping. UUID access is unchanged. */
export async function revokeBoardShareCode(
	env: Env,
	boardId: string,
): Promise<boolean> {
	if (!env.WHITEBOARDS) return false
	for (let attempt = 0; attempt < SHARE_CODE_REVOKE_ATTEMPTS; attempt += 1) {
		try {
			const id = env.WHITEBOARDS.idFromName(boardId)
			const stub = env.WHITEBOARDS.get(id) as unknown as {
				revokeShareCodeMapping(): Promise<void>
			}
			await stub.revokeShareCodeMapping()
			return true
		} catch {
			if (attempt < SHARE_CODE_REVOKE_ATTEMPTS - 1) {
				await sleep(SHARE_CODE_REVOKE_DELAY_MS)
			}
		}
	}
	return false
}

function patchHeaders(request: Request): Headers {
	const headers = new Headers({ 'Content-Type': 'application/json' })
	for (const name of [
		'Authorization',
		'Origin',
		'X-Board-Host',
		'X-Board-Session',
		'X-Board-Auth',
		'Cookie',
	]) {
		const value = request.headers.get(name)
		if (value) headers.set(name, value)
	}
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
	const headers = patchHeaders(request)
	// Keep normal host proof in the forwarded header. The DO accepts a
	// hostSecret query only for historical callers.
	headers.set('X-Board-Host', hostSecret)

	const fallbackError =
		'Could not mark this board as saved. Open the board and try again.'
	let lastStatus = 503
	let lastError = fallbackError

	for (let attempt = 0; attempt < META_SAVE_ATTEMPTS; attempt++) {
		try {
			const res = await stub.fetch(
				new Request(forwardUrl.toString(), {
					method: 'PATCH',
					headers,
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
			headers: jsonHeaders(request, {
				methods: 'GET, PUT, PATCH, DELETE, OPTIONS',
				maxAge: 86400,
			}),
		})
	}

	const authResult = await requireClerkWhiteboardAuth(request, env)
	if (!authResult.ok) {
		return withJsonHeaders(request, authResult.response, {
			methods: 'GET, PUT, PATCH, DELETE, OPTIONS',
		})
	}

	const { ownerKey } = authResult.auth
	const legacyOwnerKeys = candidateOwnerKeys(authResult.auth).slice(1)

	const boardsList = url.pathname.match(
		/^\/api\/whiteboard\/library\/boards\/?$/i,
	)
	const boardOne = url.pathname.match(
		/^\/api\/whiteboard\/library\/boards\/([^/]+)\/?$/i,
	)
	const boardPreview = url.pathname.match(
		/^\/api\/whiteboard\/library\/boards\/([^/]+)\/preview\/?$/i,
	)
	const assetsList = url.pathname.match(
		/^\/api\/whiteboard\/library\/assets\/?$/i,
	)
	const assetOne = url.pathname.match(
		/^\/api\/whiteboard\/library\/assets\/([^/]+)\/?$/i,
	)

	if (boardsList) {
		if (request.method === 'GET') {
			try {
				const entries = await listLibraryBoards(
					env,
					ownerKey,
					legacyOwnerKeys,
				)
				return json(200, { boards: sortByAccessed(entries), ownerKey }, request)
			} catch (error) {
				return libraryStoreError(request, error)
			}
		}
		if (request.method === 'PUT') {
			let body: unknown
			try {
				body = await readBoundedJsonBody(request)
			} catch (error) {
				if (error instanceof JsonBodyError) {
					return json(error.status, { error: error.message }, request)
				}
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
			try {
				await upsertLibraryBoard(env, ownerKey, next, legacyOwnerKeys)
			} catch (error) {
				return libraryStoreError(request, error)
			}
			return json(200, { board: next }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	if (boardPreview) {
		const boardId = decodeURIComponent(boardPreview[1])
		if (!UUID_RE.test(boardId)) {
			return json(400, { error: 'Invalid board id' }, request)
		}
		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' }, request)
		}

		let body: unknown
		try {
			body = await readBoundedJsonBody(request)
		} catch (error) {
			if (error instanceof JsonBodyError) {
				return json(error.status, { error: error.message }, request)
			}
			return json(400, { error: 'Invalid JSON' }, request)
		}
		if (!isBoardPreviewPatch(body)) {
			return json(400, { error: 'Invalid board preview' }, request)
		}
		const parsed = parsePreviewAsset(body.previewDataUrl)
		if (!parsed || !candidateOwnerKeys(authResult.auth).includes(parsed.ownerKey)) {
			return json(400, { error: 'Invalid board preview' }, request)
		}

		let board: BoardEntry | null
		try {
			board = await patchLibraryBoardPreview(
				env,
				ownerKey,
				boardId,
				body.previewDataUrl,
				legacyOwnerKeys,
			)
		} catch (error) {
			return libraryStoreError(request, error)
		}
		if (!board) {
			return json(404, { error: 'Board is no longer in your library' }, request)
		}
		return json(200, { board }, request)
	}

	if (boardOne) {
		const boardId = decodeURIComponent(boardOne[1])
		if (!UUID_RE.test(boardId)) {
			return json(400, { error: 'Invalid board id' }, request)
		}
		if (request.method === 'DELETE') {
			let existing: BoardEntry | null
			try {
				existing = await getLibraryBoard(
					env,
					ownerKey,
					boardId,
					legacyOwnerKeys,
				)
			} catch (error) {
				return libraryStoreError(request, error)
			}
			if (!existing) {
				// Ownership lookup is authoritative. Never revoke a board code when
				// this owner has no row (including another owner's board).
				return json(404, { error: 'Board is no longer in your library' }, request)
			}
			if (!(await revokeBoardShareCode(env, boardId))) {
				return json(
					503,
					{ error: 'Could not revoke this board share code. Please retry.' },
					request,
				)
			}
			const preview = parsePreviewAsset(existing?.previewDataUrl)
			if (preview && env.WHITEBOARD_ASSETS) {
				try {
					await env.WHITEBOARD_ASSETS.delete(
						r2ObjectKey(preview.ownerKey, preview.assetId),
					)
				} catch {
					// Still drop the D1 row; an orphaned JPEG is acceptable.
				}
			}
			try {
				await deleteLibraryBoard(env, ownerKey, boardId, legacyOwnerKeys)
			} catch (error) {
				return libraryStoreError(request, error)
			}
			return json(200, { ok: true }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	if (assetsList) {
		if (request.method === 'GET') {
			try {
				const entries = await listLibraryAssets(
					env,
					ownerKey,
					legacyOwnerKeys,
				)
				return json(200, { assets: sortByAccessed(entries), ownerKey }, request)
			} catch (error) {
				return libraryStoreError(request, error)
			}
		}
		if (request.method === 'PUT') {
			let body: unknown
			try {
				body = await readBoundedJsonBody(request)
			} catch (error) {
				if (error instanceof JsonBodyError) {
					return json(error.status, { error: error.message }, request)
				}
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
			try {
				await upsertLibraryAsset(env, ownerKey, next, legacyOwnerKeys)
			} catch (error) {
				return libraryStoreError(request, error)
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
			try {
				await deleteLibraryAsset(env, ownerKey, assetId, legacyOwnerKeys)
			} catch (error) {
				return libraryStoreError(request, error)
			}
			return json(200, { ok: true }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	return json(404, { error: 'Not found' }, request)
}
