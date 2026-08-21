/**
 * Share code HTTP routes (Phase 5).
 *
 * - GET  /api/whiteboard/join/:code              → KV lookup → { id }
 * - GET  /api/whiteboard/boards/:uuid/code       → DO current code state
 * - POST /api/whiteboard/boards/:uuid/code       → mint / keep / rotate
 * - DELETE /api/whiteboard/boards/:uuid/code     → revoke (Closed)
 *
 * Auth: join is unauthenticated (rate-limited). Board code GET/POST/DELETE
 * require Owner/Manager proof forwarded to the Durable Object (host secret,
 * live session token, or Clerk matching cloudOwnerKey). UUID access after
 * Closed remains a separate capability.
 * Mint/rotate is also rate-limited inside the Durable Object (`assertMintAllowed`).
 */
import {
	isExpiredIso,
	kvCodeKey,
	normalizeShareCode,
	parseShareCodeRecord,
} from './shareCode'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Class burst behind school NAT: ~60 joins/min per public IP. */
const JOIN_IP_LIMIT = 60
const JOIN_IP_WINDOW_MS = 60_000
/** Failed lookups of one code — tighter than per-IP to slow enumeration. */
const JOIN_CODE_FAIL_LIMIT = 10
const JOIN_CODE_FAIL_WINDOW_MS = 60_000
const JOIN_RATE_MAP_MAX = 4_000

type JoinRateHits = number[]

const joinHitsByIp = new Map<string, JoinRateHits>()
const joinFailsByCode = new Map<string, JoinRateHits>()

function isBoardUuid(value: string): boolean {
	return UUID_RE.test(value)
}

function looksLikeJwt(raw: string | null): boolean {
	if (!raw) return false
	const parts = raw.trim().split('.')
	return parts.length === 3 && raw.trim().length > 40
}

function extractHostSecret(request: Request, url: URL): string | null {
	const header = request.headers.get('X-Board-Host')?.trim()
	if (header && !looksLikeJwt(header)) return header
	const auth = request.headers.get('Authorization')
	if (auth?.toLowerCase().startsWith('bearer ')) {
		const token = auth.slice(7).trim()
		if (token && !looksLikeJwt(token)) return token
	}
	const query = url.searchParams.get('hostSecret')?.trim()
	if (query && !looksLikeJwt(query)) return query
	return null
}

function corsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get('Origin')
	if (!origin) return {}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			'Content-Type, Authorization, X-Board-Host, X-Board-Session, X-Board-Auth',
		Vary: 'Origin',
	}
}

function json(
	status: number,
	body: unknown,
	request: Request,
	extraHeaders?: HeadersInit,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
			...extraHeaders,
		},
	})
}

function joinUnavailable(request: Request): Response {
	return json(
		404,
		{
			error:
				"That code isn't available. Ask for a new code or open the board link.",
		},
		request,
	)
}

function joinRateLimited(request: Request, retryAfterSec: number): Response {
	return json(
		429,
		{
			error: 'Too many join attempts. Wait a moment and try again.',
		},
		request,
		{ 'Retry-After': String(retryAfterSec) },
	)
}

function clientIp(request: Request): string {
	const cf = request.headers.get('CF-Connecting-IP')?.trim()
	if (cf) return cf
	const forwarded = request.headers.get('X-Forwarded-For')
	const first = forwarded?.split(',')[0]?.trim()
	return first || 'unknown'
}

function pruneJoinRateMap(
	map: Map<string, JoinRateHits>,
	now: number,
	windowMs: number,
): void {
	if (map.size < JOIN_RATE_MAP_MAX) return
	const cutoff = now - windowMs
	for (const [key, hits] of map) {
		const kept = hits.filter((t) => t > cutoff)
		if (kept.length === 0) map.delete(key)
		else map.set(key, kept)
	}
}

/**
 * Sliding window. Isolate-local (not global): KV is a poor fit for a class
 * burst because a key can only be written about once per second.
 * Returns retry-after seconds when over limit.
 */
function consumeJoinRate(
	map: Map<string, JoinRateHits>,
	key: string,
	limit: number,
	windowMs: number,
	now = Date.now(),
): number | null {
	pruneJoinRateMap(map, now, windowMs)
	const cutoff = now - windowMs
	const hits = (map.get(key) ?? []).filter((t) => t > cutoff)
	if (hits.length >= limit) {
		map.set(key, hits)
		const retryAfterMs = hits[0]! + windowMs - now
		return Math.max(1, Math.ceil(retryAfterMs / 1000))
	}
	hits.push(now)
	map.set(key, hits)
	return null
}

/**
 * Returns a Response if this request is a share-code route; otherwise null.
 */
export async function handleCodeRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)

	if (request.method === 'OPTIONS') {
		if (
			url.pathname.match(/^\/api\/whiteboard\/join\//i) ||
			url.pathname.match(/^\/api\/whiteboard\/boards\/[^/]+\/code\/?$/i)
		) {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(request),
			})
		}
		return null
	}

	const joinMatch = url.pathname.match(
		/^\/api\/whiteboard\/join\/([^/]+)\/?$/i,
	)
	if (joinMatch) {
		if (request.method !== 'GET') {
			return json(405, { error: 'Method not allowed' }, request)
		}
		return handleJoin(request, env, decodeURIComponent(joinMatch[1]!))
	}

	const boardCodeMatch = url.pathname.match(
		/^\/api\/whiteboard\/boards\/([^/]+)\/code\/?$/i,
	)
	if (boardCodeMatch) {
		const boardId = decodeURIComponent(boardCodeMatch[1]!)
		if (!isBoardUuid(boardId)) {
			return json(400, { error: 'Invalid board id' }, request)
		}
		if (
			request.method !== 'GET' &&
			request.method !== 'POST' &&
			request.method !== 'DELETE'
		) {
			return json(405, { error: 'Method not allowed' }, request)
		}
		if (!env.WHITEBOARD_CODES) {
			return json(
				503,
				{ error: 'Share codes are not configured on this Worker.' },
				request,
			)
		}
		const hostSecret = extractHostSecret(request, url)
		const actorSessionId = request.headers.get('X-Board-Session')?.trim() || ''
		const actorAuth = request.headers.get('X-Board-Auth')?.trim() || ''
		const id = env.WHITEBOARDS.idFromName(boardId)
		const stub = env.WHITEBOARDS.get(id)
		const forwardUrl = new URL(request.url)
		forwardUrl.searchParams.set('boardId', boardId)
		if (hostSecret) forwardUrl.searchParams.set('hostSecret', hostSecret)
		if (actorSessionId) {
			forwardUrl.searchParams.set('actorSessionId', actorSessionId)
		}
		if (actorAuth) forwardUrl.searchParams.set('actorAuth', actorAuth)
		const headers = new Headers({ Accept: 'application/json' })
		const authorization = request.headers.get('Authorization')
		if (authorization) headers.set('Authorization', authorization)
		const cookie = request.headers.get('Cookie')
		if (cookie) headers.set('Cookie', cookie)
		const origin = request.headers.get('Origin')
		if (origin) headers.set('Origin', origin)
		const boardHost = request.headers.get('X-Board-Host')?.trim()
		if (boardHost) headers.set('X-Board-Host', boardHost)
		if (actorSessionId) headers.set('X-Board-Session', actorSessionId)
		if (actorAuth) headers.set('X-Board-Auth', actorAuth)
		const response = await stub.fetch(
			new Request(forwardUrl.toString(), {
				method: request.method,
				headers,
			}),
		)
		const text = await response.text()
		return new Response(text, {
			status: response.status,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders(request),
			},
		})
	}

	return null
}

async function handleJoin(
	request: Request,
	env: Env,
	rawCode: string,
): Promise<Response> {
	const ipRetry = consumeJoinRate(
		joinHitsByIp,
		clientIp(request),
		JOIN_IP_LIMIT,
		JOIN_IP_WINDOW_MS,
	)
	if (ipRetry !== null) {
		return joinRateLimited(request, ipRetry)
	}

	const code = normalizeShareCode(rawCode)
	if (!code) {
		return joinUnavailable(request)
	}
	if (!env.WHITEBOARD_CODES) {
		return json(
			503,
			{ error: 'Share codes are not configured on this Worker.' },
			request,
		)
	}

	const record = parseShareCodeRecord(
		await env.WHITEBOARD_CODES.get(kvCodeKey(code)),
	)
	if (!record || isExpiredIso(record.exp) || !isBoardUuid(record.boardId)) {
		const failRetry = consumeJoinRate(
			joinFailsByCode,
			code,
			JOIN_CODE_FAIL_LIMIT,
			JOIN_CODE_FAIL_WINDOW_MS,
		)
		if (failRetry !== null) {
			return joinRateLimited(request, failRetry)
		}
		return joinUnavailable(request)
	}

	return json(200, { id: record.boardId }, request)
}
