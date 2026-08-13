/**
 * Cloud Recents / Library / Assets indexes (Phase 3.1).
 *
 * Storage: R2 JSON in the existing WHITEBOARD_ASSETS bucket
 *   library/{ownerKey}/boards.json
 *   library/{ownerKey}/assets.json
 *
 * Signed-in Clerk sessions only. PUT on a board may include X-Board-Host so
 * we can lift the Phase 2 24h scratch TTL on the Durable Object (best-effort;
 * the client also PATCHes /meta after the creating browser connects).
 */
import { requireClerkWhiteboardAuth } from './clerkAuth'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

async function readJsonArray<T>(
	bucket: R2Bucket,
	key: string,
	guard: (value: unknown) => value is T,
): Promise<T[]> {
	const object = await bucket.get(key)
	if (!object) return []
	try {
		const parsed = (await object.json()) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter(guard)
	} catch {
		return []
	}
}

async function writeJsonArray(
	bucket: R2Bucket,
	key: string,
	entries: unknown[],
): Promise<void> {
	await bucket.put(key, JSON.stringify(entries), {
		httpMetadata: {
			contentType: 'application/json',
			cacheControl: 'no-store',
		},
	})
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
 * Best-effort Phase 2 meta claim. Fails closed if the creating browser has
 * not connected yet (host hash missing → 403); the client retries PATCH.
 */
async function tryMarkSavedToLibrary(
	env: Env,
	request: Request,
	boardId: string,
	ownerKey: string,
): Promise<void> {
	const hostSecret = request.headers.get('X-Board-Host')?.trim()
	if (!hostSecret) return
	try {
		const id = env.WHITEBOARDS.idFromName(boardId)
		const stub = env.WHITEBOARDS.get(id)
		const forwardUrl = new URL(request.url)
		forwardUrl.pathname = `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`
		forwardUrl.search = ''
		forwardUrl.searchParams.set('boardId', boardId)
		forwardUrl.searchParams.set('hostSecret', hostSecret)
		await stub.fetch(
			new Request(forwardUrl.toString(), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					savedToLibrary: true,
					cloudOwnerKey: ownerKey,
				}),
			}),
		)
	} catch {
		// Index write already succeeded.
	}
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
			const boards = sortByAccessed(
				await readJsonArray(bucket, boardsObjectKey(ownerKey), isBoardEntry),
			)
			return json(200, { boards, ownerKey }, request)
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
			const boards = await readJsonArray(
				bucket,
				boardsObjectKey(ownerKey),
				isBoardEntry,
			)
			const index = boards.findIndex((entry) => entry.id === body.id)
			const next: BoardEntry = {
				id: body.id,
				title: body.title.trim() || 'Untitled board',
				lastAccessedAt: body.lastAccessedAt || new Date().toISOString(),
				previewDataUrl: body.previewDataUrl,
			}
			if (index >= 0) boards[index] = { ...boards[index], ...next }
			else boards.unshift(next)
			await writeJsonArray(bucket, boardsObjectKey(ownerKey), boards)
			await tryMarkSavedToLibrary(env, request, next.id, ownerKey)
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
			const boards = await readJsonArray(
				bucket,
				boardsObjectKey(ownerKey),
				isBoardEntry,
			)
			await writeJsonArray(
				bucket,
				boardsObjectKey(ownerKey),
				boards.filter((entry) => entry.id !== boardId),
			)
			return json(200, { ok: true }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	if (assetsList) {
		if (request.method === 'GET') {
			const assets = sortByAccessed(
				await readJsonArray(bucket, assetsObjectKey(ownerKey), isAssetEntry),
			)
			return json(200, { assets, ownerKey }, request)
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
			const assets = await readJsonArray(
				bucket,
				assetsObjectKey(ownerKey),
				isAssetEntry,
			)
			const index = assets.findIndex((entry) => entry.id === body.id)
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
			if (index >= 0) assets[index] = { ...assets[index], ...next }
			else assets.unshift(next)
			await writeJsonArray(bucket, assetsObjectKey(ownerKey), assets)
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
			const assets = await readJsonArray(
				bucket,
				assetsObjectKey(ownerKey),
				isAssetEntry,
			)
			await writeJsonArray(
				bucket,
				assetsObjectKey(ownerKey),
				assets.filter((entry) => entry.id !== assetId),
			)
			return json(200, { ok: true }, request)
		}
		return json(405, { error: 'Method not allowed' }, request)
	}

	return json(404, { error: 'Not found' }, request)
}
