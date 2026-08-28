/**
 * Owner/Manager force-follow (Phase 3.3).
 *
 * PATCH /api/whiteboard/boards/:uuid/force-follow
 * Auth: host secret (Owner scratch) or live session token (Owner / Manager)
 * Body: { "forceFollow": boolean, "targetUserId"?: string, "subjectUserId"?: string }
 */

import {
	copyProofHeaders,
	forwardLegacyProofHeaders,
	jsonHeaders,
	jsonResponse,
	logWhiteboardEvent,
	readBoundedJsonBody,
	JsonBodyError,
	readHostProof,
	withJsonHeaders,
} from './httpSecurity'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isBoardUuid(value: string): boolean {
	return UUID_RE.test(value)
}

function json(status: number, body: unknown, request: Request): Response {
	if (status >= 400) {
		logWhiteboardEvent('api_error', { method: request.method, status })
	}
	return jsonResponse(request, status, body, { methods: 'PATCH, OPTIONS' })
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
			headers: jsonHeaders(request, {
				methods: 'PATCH, OPTIONS',
				maxAge: 86400,
			}),
		})
	}

	if (request.method !== 'PATCH') {
		return json(405, { error: 'Method not allowed' }, request)
	}

	const boardId = decodeURIComponent(match[1]!)
	if (!isBoardUuid(boardId)) {
		return json(400, { error: 'Invalid board id' }, request)
	}

	const hostProof = readHostProof(request, url)
	const hostSecret = hostProof.value
	const headerActorSessionId =
		request.headers.get('X-Board-Session')?.trim() || ''
	const headerActorAuth = request.headers.get('X-Board-Auth')?.trim() || ''
	const legacyActorSessionId = url.searchParams.get('actorSessionId')?.trim() || ''
	const legacyActorAuth = url.searchParams.get('actorAuth')?.trim() || ''
	const actorSessionId =
		headerActorSessionId ||
		legacyActorSessionId ||
		''
	const actorAuth =
		headerActorAuth ||
		legacyActorAuth ||
		''
	if (!hostSecret && !(actorSessionId && actorAuth)) {
		return json(401, { error: 'Owner or Manager proof required' }, request)
	}

	let forceFollow: boolean
	let targetUserId = ''
	let subjectUserId = ''
	try {
		const body = (await readBoundedJsonBody(request)) as {
			forceFollow?: unknown
			targetUserId?: unknown
			subjectUserId?: unknown
		}
		if (typeof body.forceFollow !== 'boolean') {
			return json(
				400,
				{ error: 'Body must include boolean forceFollow' },
				request,
			)
		}
		forceFollow = body.forceFollow
		if (typeof body.targetUserId === 'string') {
			targetUserId = body.targetUserId.trim().slice(0, 128)
		}
		if (typeof body.subjectUserId === 'string') {
			subjectUserId = body.subjectUserId.trim().slice(0, 128)
		}
	} catch (error) {
		if (error instanceof JsonBodyError) {
			return json(error.status, { error: error.message }, request)
		}
		return json(400, { error: 'Invalid JSON body' }, request)
	}

	const id = env.WHITEBOARDS.idFromName(boardId)
	const stub = env.WHITEBOARDS.get(id)
	const forwardUrl = new URL(request.url)
	const headers = copyProofHeaders(request)
	forwardLegacyProofHeaders(request, forwardUrl, headers)
	forwardUrl.searchParams.set('boardId', boardId)
	forwardUrl.searchParams.set('forceFollow', forceFollow ? '1' : '0')
	if (targetUserId) forwardUrl.searchParams.set('targetUserId', targetUserId)
	if (subjectUserId) forwardUrl.searchParams.set('subjectUserId', subjectUserId)
	headers.set('Content-Type', 'application/json')
	if (hostSecret && !headers.has('X-Board-Host')) {
		headers.set('X-Board-Host', hostSecret)
	}

	const response = await stub.fetch(
		new Request(forwardUrl.toString(), {
			method: 'PATCH',
			headers,
			body: JSON.stringify({
				forceFollow,
				...(targetUserId ? { targetUserId } : {}),
				...(subjectUserId ? { subjectUserId } : {}),
			}),
		}),
	)
	return withJsonHeaders(request, response, {
		methods: 'PATCH, OPTIONS',
	})
}
