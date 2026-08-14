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

const DO_OBJECT_ID_RE = /^[0-9a-f]{64}$/i
const MAX_OBJECT_IDS = 100

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function timingSafeEqualString(left: string, right: string): boolean {
	const encoder = new TextEncoder()
	const a = encoder.encode(left)
	const b = encoder.encode(right)
	if (a.byteLength !== b.byteLength) return false
	return crypto.subtle.timingSafeEqual(a, b)
}

function adminAuthorized(request: Request, env: Env): boolean {
	const secret = env.WHITEBOARD_ADMIN_SECRET?.trim()
	if (!secret) return false
	const auth = request.headers.get('Authorization')
	const token =
		auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
	if (!token) return false
	return timingSafeEqualString(token, secret)
}

export async function handleAdminRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (url.pathname !== '/api/whiteboard/admin/wipe-storage') {
		if (url.pathname.startsWith('/api/whiteboard/admin/')) {
			return json(404, { error: 'Not found' })
		}
		return null
	}

	if (request.method !== 'POST') {
		return json(405, { error: 'Method not allowed' })
	}

	const secret = env.WHITEBOARD_ADMIN_SECRET?.trim()
	if (!secret) {
		return json(503, { error: 'Admin wipe is not configured' })
	}
	if (!adminAuthorized(request, env)) {
		return json(401, { error: 'Unauthorized' })
	}

	let body: { objectIds?: unknown }
	try {
		body = (await request.json()) as { objectIds?: unknown }
	} catch {
		return json(400, { error: 'Invalid JSON body' })
	}

	if (!Array.isArray(body.objectIds) || body.objectIds.length === 0) {
		return json(400, { error: 'objectIds must be a non-empty array' })
	}
	if (body.objectIds.length > MAX_OBJECT_IDS) {
		return json(400, { error: `At most ${MAX_OBJECT_IDS} objectIds per request` })
	}

	const objectIds: string[] = []
	for (const value of body.objectIds) {
		if (typeof value !== 'string' || !DO_OBJECT_ID_RE.test(value)) {
			return json(400, { error: 'Each objectId must be a 64-char hex Durable Object id' })
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
		} catch (err) {
			errors.push({
				objectId,
				error: err instanceof Error ? err.message : 'Wipe failed',
			})
		}
	}

	return json(errors.length && !wiped.length ? 500 : 200, {
		wiped,
		errors,
	})
}
