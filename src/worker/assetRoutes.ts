/**
 * R2 asset upload / download / delete for whiteboard media.
 * Keys: assets/{ownerKey}/{assetId}
 *   google:{accountId} — signed-in saved boards
 *   temp:{boardId}     — unsaved / signed-out scratch (24h TTL)
 *   local:{deviceId}   — legacy hub index (Phase 3.1 may drop)
 * Routes: PUT|GET|DELETE /api/whiteboard/assets/{ownerKey}/{assetId}
 *         POST /api/whiteboard/assets/claim
 *         POST /api/whiteboard/assets/expire-temp
 *
 * Phase 4b: google:* writes require a Clerk session whose ownerKey matches.
 * temp:* / local:* keep capability-URL behavior (unguessable file UUIDs).
 */
import { UNSAVED_BOARD_TTL_MS } from '../lib/whiteboard-sync'
import { requireClerkWhiteboardAuth } from './clerkAuth'

export const MAX_ASSET_BYTES = 8 * 1024 * 1024 // 8 MB — Chromebook-friendly

const ALLOWED_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	'video/mp4',
	'video/webm',
])

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Signed-out hub: local:{uuid}; saved: google:{sub}; scratch media: temp:{boardUuid} */
const OWNER_KEY_RE = /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/

function isAssetUuid(value: string): boolean {
	return UUID_RE.test(value)
}

function isOwnerKey(value: string): boolean {
	return OWNER_KEY_RE.test(value)
}

export function isTempOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith('temp:')
}

export function tempOwnerKey(boardId: string): string {
	return `temp:${boardId}`
}

export function r2TempPrefix(boardId: string): string {
	return `assets/${tempOwnerKey(boardId)}/`
}

export function r2ObjectKey(ownerKey: string, assetId: string): string {
	return `assets/${ownerKey}/${assetId}`
}

/**
 * Match /api/whiteboard/assets/{ownerKey}/{assetId}
 * ownerKey may contain `:` so we split on the last `/` after the prefix.
 */
export function parseAssetPath(
	pathname: string,
): { ownerKey: string; assetId: string } | null {
	const prefix = '/api/whiteboard/assets/'
	if (!pathname.startsWith(prefix)) return null
	const rest = pathname.slice(prefix.length).replace(/\/$/, '')
	const slash = rest.lastIndexOf('/')
	if (slash <= 0) return null
	const ownerKey = decodeURIComponent(rest.slice(0, slash))
	const assetId = decodeURIComponent(rest.slice(slash + 1))
	if (!isOwnerKey(ownerKey) || !isAssetUuid(assetId)) return null
	return { ownerKey, assetId }
}

function corsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get('Origin')
	// Same-origin capability URLs; allow null Origin for some Chromebook cases
	if (!origin) return {}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
		'Access-Control-Allow-Headers':
			'Content-Type, Content-Length, Authorization, X-Board-Host',
		Vary: 'Origin',
	}
}

async function assertGoogleOwnerWrite(
	request: Request,
	env: Env,
	ownerKey: string,
): Promise<Response | null> {
	if (!ownerKey.startsWith('google:')) return null
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
	if (authResult.auth.ownerKey !== ownerKey) {
		return jsonError(403, 'ownerKey does not match signed-in account', request)
	}
	return null
}

function jsonError(
	status: number,
	message: string,
	request: Request,
): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
		},
	})
}

function jsonOk(
	request: Request,
	body: unknown,
	status = 200,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
		},
	})
}

function isExpiredUpload(uploaded: Date, now = Date.now()): boolean {
	return now - uploaded.getTime() >= UNSAVED_BOARD_TTL_MS
}

/** Copy temp:{boardId}/* → google:{id}/* and delete the temp objects. */
export async function moveTempPrefixToOwner(
	env: Env,
	boardId: string,
	destOwnerKey: string,
): Promise<{ moved: string[] }> {
	if (!destOwnerKey.startsWith('google:')) {
		return { moved: [] }
	}
	const prefix = r2TempPrefix(boardId)
	const moved: string[] = []
	let cursor: string | undefined
	do {
		const listed = await env.WHITEBOARD_ASSETS.list({
			prefix,
			cursor,
			limit: 100,
		})
		for (const obj of listed.objects) {
			const fileId = obj.key.slice(prefix.length)
			if (!fileId || fileId.includes('/') || !isAssetUuid(fileId)) continue
			const source = await env.WHITEBOARD_ASSETS.get(obj.key)
			if (!source) continue
			const destKey = r2ObjectKey(destOwnerKey, fileId)
			await env.WHITEBOARD_ASSETS.put(destKey, source.body, {
				httpMetadata: source.httpMetadata,
				customMetadata: {
					...source.customMetadata,
					ownerKey: destOwnerKey,
					assetId: fileId,
					kind: 'persistent',
				},
			})
			await env.WHITEBOARD_ASSETS.delete(obj.key)
			moved.push(fileId)
		}
		cursor = listed.truncated ? listed.cursor : undefined
	} while (cursor)
	return { moved }
}

/**
 * Delete temp:* objects older than 24h. Called from expire-temp, temp PUT,
 * and (via DO alarm) prefix wipe when the unsaved board expires.
 */
export async function expireTempR2Objects(
	env: Env,
	now = Date.now(),
): Promise<number> {
	let deleted = 0
	let cursor: string | undefined
	do {
		const listed = await env.WHITEBOARD_ASSETS.list({
			prefix: 'assets/temp:',
			cursor,
			limit: 100,
		})
		const stale = listed.objects
			.filter((obj) => isExpiredUpload(obj.uploaded, now))
			.map((obj) => obj.key)
		if (stale.length > 0) {
			await env.WHITEBOARD_ASSETS.delete(stale)
			deleted += stale.length
		}
		cursor = listed.truncated ? listed.cursor : undefined
	} while (cursor)
	return deleted
}

/** PHASE 3.2: after hub Save/claim PATCHes board meta, move temp R2 objects. */
export async function claimTempAssetsFromMetaResponse(
	env: Env,
	boardId: string,
	response: Response,
): Promise<void> {
	try {
		const meta = (await response.json()) as {
			savedToLibrary?: unknown
			cloudOwnerKey?: unknown
		}
		if (meta.savedToLibrary !== true) return
		if (
			typeof meta.cloudOwnerKey !== 'string' ||
			!meta.cloudOwnerKey.startsWith('google:')
		) {
			return
		}
		await moveTempPrefixToOwner(env, boardId, meta.cloudOwnerKey)
	} catch {
		// best-effort; canvas hook also claims
	}
}

async function handleClaim(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		})
	}
	if (request.method !== 'POST') {
		return jsonError(405, 'Method not allowed', request)
	}

	let body: { boardId?: unknown }
	try {
		body = (await request.json()) as typeof body
	} catch {
		return jsonError(400, 'Invalid JSON body', request)
	}
	const boardId = typeof body.boardId === 'string' ? body.boardId.trim() : ''
	if (!UUID_RE.test(boardId)) {
		return jsonError(400, 'Invalid boardId', request)
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

	const destOwnerKey = authResult.auth.ownerKey
	const { moved } = await moveTempPrefixToOwner(env, boardId, destOwnerKey)
	return jsonOk(request, {
		ok: true,
		boardId,
		ownerKey: destOwnerKey,
		moved,
	})
}

async function handleExpireTemp(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		})
	}
	if (request.method !== 'POST') {
		return jsonError(405, 'Method not allowed', request)
	}
	const deleted = await expireTempR2Objects(env)
	return jsonOk(request, { ok: true, deleted })
}

export async function handleAssetRequest(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
): Promise<Response | null> {
	const url = new URL(request.url)

	if (url.pathname === '/api/whiteboard/assets/claim') {
		return handleClaim(request, env)
	}
	if (url.pathname === '/api/whiteboard/assets/expire-temp') {
		return handleExpireTemp(request, env)
	}

	const parsed = parseAssetPath(url.pathname)
	if (!parsed) {
		// Only claim this path family — let caller 404 invalid shapes under /assets/
		if (url.pathname.startsWith('/api/whiteboard/assets')) {
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					status: 204,
					headers: corsHeaders(request),
				})
			}
			return jsonError(400, 'Invalid asset path', request)
		}
		return null
	}

	const { ownerKey, assetId } = parsed
	const key = r2ObjectKey(ownerKey, assetId)

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders(request),
				'Access-Control-Max-Age': '86400',
			},
		})
	}

	if (request.method === 'PUT') {
		const googleDenied = await assertGoogleOwnerWrite(request, env, ownerKey)
		if (googleDenied) return googleDenied

		const contentType = (
			request.headers.get('Content-Type') || ''
		)
			.split(';')[0]
			.trim()
			.toLowerCase()
		if (!contentType || !ALLOWED_MIME.has(contentType)) {
			return jsonError(
				415,
				'Unsupported media type. Use JPEG, PNG, GIF, WebP, SVG, or MP4/WebM.',
				request,
			)
		}

		const contentLength = Number(request.headers.get('Content-Length') || '0')
		if (contentLength > MAX_ASSET_BYTES) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}

		if (!request.body) {
			return jsonError(400, 'Missing body', request)
		}

		// Stream into R2; also enforce size if Content-Length was omitted
		const body = await request.arrayBuffer()
		if (body.byteLength === 0) {
			return jsonError(400, 'Empty body', request)
		}
		if (body.byteLength > MAX_ASSET_BYTES) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}

		const kind = isTempOwnerKey(ownerKey) ? 'temp' : 'persistent'
		await env.WHITEBOARD_ASSETS.put(key, body, {
			httpMetadata: {
				contentType,
				cacheControl:
					kind === 'temp'
						? 'private, max-age=3600'
						: 'public, max-age=31536000, immutable',
			},
			customMetadata: {
				ownerKey,
				assetId,
				kind,
				createdAt: new Date().toISOString(),
			},
		})

		if (kind === 'temp' && ctx) {
			ctx.waitUntil(expireTempR2Objects(env).then(() => undefined))
		}

		return jsonOk(
			request,
			{
				ok: true,
				ownerKey,
				assetId,
				r2Key: key,
				size: body.byteLength,
				mimeType: contentType,
			},
			201,
		)
	}

	if (request.method === 'GET' || request.method === 'HEAD') {
		const object = await env.WHITEBOARD_ASSETS.get(key, {
			range: request.headers,
			onlyIf: request.headers,
		})
		if (object === null) {
			return jsonError(404, 'Asset not found', request)
		}

		if (isTempOwnerKey(ownerKey) && isExpiredUpload(object.uploaded)) {
			await env.WHITEBOARD_ASSETS.delete(key)
			return jsonError(404, 'Asset expired', request)
		}

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('Accept-Ranges', 'bytes')
		if (isTempOwnerKey(ownerKey)) {
			headers.set('Cache-Control', 'private, max-age=3600')
		} else {
			headers.set('Cache-Control', 'public, max-age=31536000, immutable')
		}
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})

		if (!('body' in object) || !object.body) {
			return new Response(null, { status: 304, headers })
		}

		if (request.method === 'HEAD') {
			return new Response(null, { status: 200, headers })
		}

		const range = object.range
		if (range && ('offset' in range || 'length' in range)) {
			const offset = 'offset' in range && range.offset != null ? range.offset : 0
			const length =
				'length' in range && range.length != null
					? range.length
					: object.size - offset
			const end = offset + length - 1
			headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`)
			headers.set('Content-Length', String(length))
			return new Response(object.body, { status: 206, headers })
		}

		return new Response(object.body, { status: 200, headers })
	}

	if (request.method === 'DELETE') {
		const googleDenied = await assertGoogleOwnerWrite(request, env, ownerKey)
		if (googleDenied) return googleDenied

		await env.WHITEBOARD_ASSETS.delete(key)
		return jsonOk(request, { ok: true })
	}

	return jsonError(405, 'Method not allowed', request)
}
