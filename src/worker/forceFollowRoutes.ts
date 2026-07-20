/**
 * Host-only force-follow toggle.
 *
 * PATCH /api/whiteboard/boards/:uuid/force-follow
 * Auth: host secret (Authorization: Bearer / X-Board-Host / ?hostSecret=)
 * Body: { "forceFollow": boolean }
 */

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
		'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Board-Host',
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

function extractHostSecret(request: Request, url: URL): string | null {
	const header = request.headers.get('X-Board-Host')?.trim()
	if (header) return header
	const auth = request.headers.get('Authorization')
	if (auth?.toLowerCase().startsWith('bearer ')) {
		const token = auth.slice(7).trim()
		if (token) return token
	}
	const query = url.searchParams.get('hostSecret')?.trim()
	return query || null
}

/**
 * Returns a Response if this is a force-follow route; otherwise null.
 */
export async function handleForceFollowRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)

	const match = url.pathname.match(
		/^\/api\/whiteboard\/boards\/([^/]+)\/force-follow\/?$/i,
	)
	if (!match) return null

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		})
	}

	if (request.method !== 'PATCH') {
		return json(405, { error: 'Method not allowed' }, request)
	}

	const boardId = decodeURIComponent(match[1]!)
	if (!isBoardUuid(boardId)) {
		return json(400, { error: 'Invalid board id' }, request)
	}

	const hostSecret = extractHostSecret(request, url)
	if (!hostSecret) {
		return json(401, { error: 'Host secret required' }, request)
	}

	let forceFollow: boolean
	try {
		const body = (await request.json()) as { forceFollow?: unknown }
		if (typeof body.forceFollow !== 'boolean') {
			return json(
				400,
				{ error: 'Body must include boolean forceFollow' },
				request,
			)
		}
		forceFollow = body.forceFollow
	} catch {
		return json(400, { error: 'Invalid JSON body' }, request)
	}

	const id = env.WHITEBOARDS.idFromName(boardId)
	const stub = env.WHITEBOARDS.get(id)
	const forwardUrl = new URL(request.url)
	forwardUrl.searchParams.set('boardId', boardId)
	forwardUrl.searchParams.set('hostSecret', hostSecret)
	forwardUrl.searchParams.set('forceFollow', forceFollow ? '1' : '0')

	const response = await stub.fetch(
		new Request(forwardUrl.toString(), {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
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
