import { requireClerkWhiteboardAuth } from './clerkAuth'
import {
	claimNotifications,
	clearNotifications,
	createStoredNotification,
	dismissNotification,
	isNotificationId,
	listNotifications,
	markAllNotificationsRead,
	markNotificationRead,
	NotificationStoreError,
} from './notificationStore'
import {
	jsonHeaders,
	jsonResponse,
	JsonBodyError,
	readBoundedJsonBody,
	withJsonHeaders,
} from './httpSecurity'

const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

function json(request: Request, status: number, body: unknown): Response {
	return jsonResponse(request, status, body, { methods: METHODS })
}

function storageError(request: Request, error: unknown): Response {
	if (error instanceof NotificationStoreError) {
		return json(request, 503, { error: error.message })
	}
	return json(request, 503, { error: 'Notification storage is temporarily unavailable' })
}

async function readJson(request: Request): Promise<unknown | Response> {
	try {
		return await readBoundedJsonBody(request, 64 * 1024)
	} catch (error) {
		if (error instanceof JsonBodyError) {
			return json(request, error.status, { error: error.message })
		}
		return json(request, 400, { error: 'Invalid JSON body' })
	}
}

export async function handleNotificationRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (!url.pathname.startsWith('/api/notifications')) return null

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: jsonHeaders(request, { methods: METHODS, maxAge: 86400 }),
		})
	}

	const authResult = await requireClerkWhiteboardAuth(request, env)
	if (!authResult.ok) {
		return withJsonHeaders(request, authResult.response, { methods: METHODS })
	}
	const { ownerKey } = authResult.auth

	const root = url.pathname.match(/^\/api\/notifications\/?$/i)
	const claim = url.pathname.match(/^\/api\/notifications\/claim\/?$/i)
	const readAll = url.pathname.match(/^\/api\/notifications\/read-all\/?$/i)
	const clear = url.pathname.match(/^\/api\/notifications\/clear\/?$/i)
	const one = url.pathname.match(/^\/api\/notifications\/([^/]+)\/?$/i)

	try {
		if (root && request.method === 'GET') {
			return json(request, 200, {
				notifications: await listNotifications(env, ownerKey),
			})
		}
		if (root && request.method === 'POST') {
			const body = await readJson(request)
			if (body instanceof Response) return body
			const notification = await createStoredNotification(env, ownerKey, body)
			if (!notification) {
				return json(request, 400, { error: 'Invalid notification' })
			}
			return json(request, 201, { notification })
		}
		if (claim && request.method === 'POST') {
			const body = await readJson(request)
			if (body instanceof Response) return body
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				return json(request, 400, { error: 'Invalid notification claim' })
			}
			const values = (body as Record<string, unknown>).notifications
			if (!Array.isArray(values) || values.length > 50) {
				return json(request, 400, { error: 'Invalid notification claim' })
			}
			return json(request, 200, {
				claimedIds: await claimNotifications(env, ownerKey, values),
			})
		}
		if (readAll && request.method === 'POST') {
			await markAllNotificationsRead(env, ownerKey)
			return json(request, 200, { ok: true })
		}
		if (clear && request.method === 'POST') {
			await clearNotifications(env, ownerKey)
			return json(request, 200, { ok: true })
		}
		if (one) {
			const notificationId = decodeURIComponent(one[1]!)
			if (!isNotificationId(notificationId)) {
				return json(request, 400, { error: 'Invalid notification id' })
			}
			if (request.method === 'PATCH') {
				const body = await readJson(request)
				if (body instanceof Response) return body
				if (!body || typeof body !== 'object' || Array.isArray(body)) {
					return json(request, 400, { error: 'Invalid notification update' })
				}
				const read = (body as Record<string, unknown>).read
				if (read !== true) {
					return json(request, 400, { error: 'Only read: true is supported' })
				}
				await markNotificationRead(env, ownerKey, notificationId)
				return json(request, 200, { ok: true })
			}
			if (request.method === 'DELETE') {
				await dismissNotification(env, ownerKey, notificationId)
				return json(request, 200, { ok: true })
			}
		}
		return json(request, 405, { error: 'Method not allowed' })
	} catch (error) {
		return storageError(request, error)
	}
}
