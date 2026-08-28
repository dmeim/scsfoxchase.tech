/**
 * One-shot admin wipe for leftover Durable Object SQLite (tldraw era).
 *
 * POST /api/whiteboard/admin/wipe-storage
 * Authorization: Bearer <WHITEBOARD_ADMIN_SECRET>
 * Body: { "objectIds": ["<64-char hex>", ...] }
 *
 * Resolves each ID with idFromString (list-API hex, not board UUID) and RPC
 * wipeStoredData() → storage.deleteAll() + empty excalidraw_scene table.
 */
import type { WhiteboardBoard, WipeStoredDataResult } from './WhiteboardBoard'
import { handleAdminLibraryRequest } from './adminLibraryRoutes'
import {
	bearerMatchesSecret,
	isAllowedOrigin,
	JsonBodyError,
	jsonHeaders,
	jsonResponse,
	readBoundedJsonBody,
} from './httpSecurity'

const DO_OBJECT_ID_RE = /^[0-9a-f]{64}$/i
const MAX_OBJECT_IDS = 100

function json(status: number, body: unknown, request: Request): Response {
	return jsonResponse(request, status, body, {
		methods: 'POST, OPTIONS',
	})
}

export function adminAuthorized(request: Request, env: Env): boolean {
	return bearerMatchesSecret(request, env.WHITEBOARD_ADMIN_SECRET)
}

export async function handleAdminRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	const libraryResponse = await handleAdminLibraryRequest(request, env)
	if (libraryResponse) return libraryResponse
	if (url.pathname !== '/api/whiteboard/admin/wipe-storage') {
		if (url.pathname.startsWith('/api/whiteboard/admin/')) {
			return json(404, { error: 'Not found' }, request)
		}
		return null
	}
	const origin = request.headers.get('Origin')?.trim()
	if (origin && !isAllowedOrigin(origin)) {
		return json(403, { error: 'Origin not allowed' }, request)
	}

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: jsonHeaders(request, {
				methods: 'POST, OPTIONS',
				maxAge: 86400,
			}),
		})
	}

	if (request.method !== 'POST') {
		return json(405, { error: 'Method not allowed' }, request)
	}

	const secret = env.WHITEBOARD_ADMIN_SECRET?.trim()
	if (!secret) {
		return json(503, { error: 'Admin wipe is not configured' }, request)
	}
	if (!adminAuthorized(request, env)) {
		return json(401, { error: 'Unauthorized' }, request)
	}

	let body: { objectIds?: unknown }
	try {
		const parsed = await readBoundedJsonBody(request)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return json(400, { error: 'Invalid JSON body' }, request)
		}
		body = parsed as { objectIds?: unknown }
	} catch (error) {
		if (error instanceof JsonBodyError) {
			return json(error.status, { error: error.message }, request)
		}
		return json(400, { error: 'Invalid JSON body' }, request)
	}

	if (!Array.isArray(body.objectIds) || body.objectIds.length === 0) {
		return json(400, { error: 'objectIds must be a non-empty array' }, request)
	}
	if (body.objectIds.length > MAX_OBJECT_IDS) {
		return json(
			400,
			{ error: `At most ${MAX_OBJECT_IDS} objectIds per request` },
			request,
		)
	}

	const objectIds: string[] = []
	for (const value of body.objectIds) {
		if (typeof value !== 'string' || !DO_OBJECT_ID_RE.test(value)) {
			return json(
				400,
				{ error: 'Each objectId must be a 64-char hex Durable Object id' },
				request,
			)
		}
		objectIds.push(value.toLowerCase())
	}

	const wiped: WipeStoredDataResult[] = []
	const errors: { objectId: string; error: string }[] = []

	for (const objectId of objectIds) {
		try {
			const id = env.WHITEBOARDS.idFromString(objectId)
			const stub = env.WHITEBOARDS.get(id) as DurableObjectStub<WhiteboardBoard>
			wiped.push(await stub.wipeStoredData())
		} catch {
			errors.push({
				objectId,
				error: 'Wipe failed',
			})
		}
	}

	return json(
		errors.length && !wiped.length ? 500 : 200,
		{
			wiped,
			errors,
		},
		request,
	)
}
