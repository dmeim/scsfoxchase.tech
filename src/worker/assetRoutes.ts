/**
 * R2 asset upload / download / delete for whiteboard media.
 * Keys: assets/{ownerKey}/{assetId}
 * Routes: PUT|GET|DELETE /api/whiteboard/assets/{ownerKey}/{assetId}
 *
 * Phase 4b: google:* writes require a Clerk session whose ownerKey matches.
 * local:* keeps Phase 4a capability-URL behavior (unguessable UUIDs).
 */
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

/** Signed-out: local:{uuid}; signed-in (4b): google:{sub} */
const OWNER_KEY_RE = /^(local|google):[A-Za-z0-9_.:@-]{1,128}$/

function isAssetUuid(value: string): boolean {
	return UUID_RE.test(value)
}

function isOwnerKey(value: string): boolean {
	return OWNER_KEY_RE.test(value)
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
		'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			'Content-Type, Content-Length, Authorization',
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

export async function handleAssetRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
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
				'Unsupported media type. Use a common image (or mp4/webm video).',
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

		await env.WHITEBOARD_ASSETS.put(key, body, {
			httpMetadata: {
				contentType,
				cacheControl: 'public, max-age=31536000, immutable',
			},
			customMetadata: {
				ownerKey,
				assetId,
			},
		})

		return new Response(
			JSON.stringify({
				ok: true,
				ownerKey,
				assetId,
				r2Key: key,
				size: body.byteLength,
				mimeType: contentType,
			}),
			{
				status: 201,
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders(request),
				},
			},
		)
	}

	if (request.method === 'GET' || request.method === 'HEAD') {
		const object = await env.WHITEBOARD_ASSETS.get(key)
		if (!object) {
			return jsonError(404, 'Asset not found', request)
		}

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('Cache-Control', 'public, max-age=31536000, immutable')
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})

		if (request.method === 'HEAD') {
			return new Response(null, { status: 200, headers })
		}
		return new Response(object.body, { status: 200, headers })
	}

	if (request.method === 'DELETE') {
		const googleDenied = await assertGoogleOwnerWrite(request, env, ownerKey)
		if (googleDenied) return googleDenied

		await env.WHITEBOARD_ASSETS.delete(key)
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders(request),
			},
		})
	}

	return jsonError(405, 'Method not allowed', request)
}
