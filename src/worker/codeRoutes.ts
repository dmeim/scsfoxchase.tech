/**
 * Share code HTTP routes (Phase 5).
 *
 * - GET  /api/whiteboard/join/:code              → KV lookup → { id }
 * - GET  /api/whiteboard/boards/:uuid/code       → DO current code state
 * - POST /api/whiteboard/boards/:uuid/code       → mint / keep / rotate
 * - DELETE /api/whiteboard/boards/:uuid/code     → revoke (Closed)
 *
 * Auth: board UUID is the capability (same as opening /board/{uuid}).
 * Any collaborator who knows the UUID can open/close/copy codes — no host secret.
 * Mint/rotate is rate-limited inside the Durable Object.
 */
import {
	isExpiredIso,
	kvCodeKey,
	normalizeShareCode,
	parseShareCodeRecord,
} from './shareCode'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isBoardUuid(value: string): boolean {
	return UUID_RE.test(value)
}

function corsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get('Origin')
	if (!origin) return {}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		Vary: 'Origin',
	}
}

function json(status: number, body: unknown, request: Request): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
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
		const id = env.WHITEBOARDS.idFromName(boardId)
		const stub = env.WHITEBOARDS.get(id)
		// Forward to DO; include boardId in query for KV payload / mint.
		const forwardUrl = new URL(request.url)
		forwardUrl.searchParams.set('boardId', boardId)
		return stub.fetch(
			new Request(forwardUrl.toString(), {
				method: request.method,
				headers: { Accept: 'application/json' },
			}),
		)
	}

	return null
}

async function handleJoin(
	request: Request,
	env: Env,
	rawCode: string,
): Promise<Response> {
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
		return joinUnavailable(request)
	}

	return json(200, { id: record.boardId }, request)
}
