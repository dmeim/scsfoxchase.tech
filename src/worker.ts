/**
 * Custom Worker entry for Astro assets + whiteboard sync / asset APIs.
 *
 * Cloudflare resource family: scsfoxchase-tech_whiteboards
 * - Binding WHITEBOARDS → Durable Object class WhiteboardBoard (SQLite)
 * - Binding WHITEBOARD_ASSETS → R2 bucket scsfoxchase-tech-whiteboards
 *   (R2 names disallow `_`; product family keeps the underscore spelling)
 * - Binding WHITEBOARD_CODES → KV share-code → boardId index (permanent per board)
 * - Cloud library metadata: D1, with historical R2 indexes kept read-only
 * - Auth: Clerk (CLERK_SECRET_KEY + PUBLIC_CLERK_PUBLISHABLE_KEY)
 */
import { handle } from '@astrojs/cloudflare/handler'
import {
	claimTempAssetsFromMetaResponse,
	handleAssetRequest,
	isBoardAssetPath,
} from './worker/assetRoutes'
import { handleCodeRequest } from './worker/codeRoutes'
import { handleLibraryRequest } from './worker/libraryRoutes'
import { handleForceFollowRequest } from './worker/forceFollowRoutes'
import { handleParticipantRequest } from './worker/participantRoutes'
import { handleAdminRequest } from './worker/adminRoutes'
import { handleNotificationRequest } from './worker/notificationRoutes'
import { cleanupExpiredNotifications } from './worker/notificationStore'
import { WhiteboardBoard } from './worker/WhiteboardBoard'
import {
	admitWhiteboardConnect,
	isValidConnectSessionId,
} from './worker/connectAdmission'
import {
	copyProofHeaders,
	forwardLegacyProofHeaders,
	jsonHeaders,
	jsonResponse,
	logWhiteboardEvent,
	JsonBodyError,
	readBoundedJsonBody,
	readHostProof,
	withJsonHeaders,
} from './worker/httpSecurity'

declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string

export { WhiteboardBoard }

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isBoardUuid(value: string): boolean {
	return UUID_RE.test(value)
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname.startsWith('/api/notifications')) {
			const notificationResponse = await handleNotificationRequest(request, env)
			if (notificationResponse) return notificationResponse
		}

		// Disambiguates the deployed Workers Build from a local preview upload.
		if (url.pathname === '/api/whiteboard/version') {
			return jsonResponse(
				request,
				200,
				{ sha: __BUILD_SHA__, builtAt: __BUILD_TIME__ },
				{ methods: 'GET, OPTIONS' },
			)
		}

		// Authenticated one-shot: wipe listed Durable Object SQLite (tldraw leftovers)
		if (url.pathname.startsWith('/api/whiteboard/admin/')) {
			const adminResponse = await handleAdminRequest(request, env)
			if (adminResponse) return adminResponse
		}

		// Cloud board / asset library indexes (Clerk session required)
		if (url.pathname.startsWith('/api/whiteboard/library')) {
			const libraryResponse = await handleLibraryRequest(request, env)
			if (libraryResponse) return libraryResponse
		}

		// Share codes: join lookup + mint (Phase 5); DELETE is internal revoke
		if (
			url.pathname.startsWith('/api/whiteboard/join') ||
			url.pathname.match(/^\/api\/whiteboard\/boards\/[^/]+\/code/i)
		) {
			const codeResponse = await handleCodeRequest(request, env)
			if (codeResponse) return codeResponse
		}

		// PHASE 3.3: participant roles
		if (
			url.pathname.match(
				/^\/api\/whiteboard\/boards\/[^/]+\/participants\/[^/]+/i,
			)
		) {
			const participantResponse = await handleParticipantRequest(request, env)
			if (participantResponse) return participantResponse
		}

		// PHASE 3.3: Owner/Manager force-follow
		if (
			url.pathname.match(/^\/api\/whiteboard\/boards\/[^/]+\/force-follow/i)
		) {
			const forceFollowResponse = await handleForceFollowRequest(request, env)
			if (forceFollowResponse) return forceFollowResponse
		}

		// R2 assets: legacy owner-key operations plus read-only board compatibility.
		if (
			url.pathname.startsWith('/api/whiteboard/assets') ||
			isBoardAssetPath(url.pathname)
		) {
			const assetResponse = await handleAssetRequest(request, env, ctx)
			if (assetResponse) return assetResponse
		}

		// WebSocket upgrade → board Durable Object (idFromName(uuid))
		// Excalidraw element diffs + persist (scene:update / scene:sync).
		const connectMatch = url.pathname.match(
			/^\/api\/whiteboard\/connect\/([^/]+)\/?$/i,
		)
		if (connectMatch) {
			const boardId = decodeURIComponent(connectMatch[1])
			if (!isBoardUuid(boardId)) {
				logWhiteboardEvent('connect_rejected')
				return new Response('Invalid board id', { status: 400 })
			}
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				logWhiteboardEvent('connect_rejected')
				return new Response('Expected WebSocket upgrade', { status: 426 })
			}
			const sessionId = url.searchParams.get('sessionId')
			if (!isValidConnectSessionId(sessionId)) {
				logWhiteboardEvent('connect_rejected')
				return new Response('Invalid session id', { status: 400 })
			}
			const admission = await admitWhiteboardConnect(request, env)
			if (admission) return admission
			const id = env.WHITEBOARDS.idFromName(boardId)
			const stub = env.WHITEBOARDS.get(id)
			return stub.fetch(request)
		}

		// Phase 2 owner / 24h TTL hook for Phase 3.1 save-to-library.
		const metaMatch = url.pathname.match(
			/^\/api\/whiteboard\/boards\/([^/]+)\/meta\/?$/i,
		)
		if (metaMatch) {
			const boardId = decodeURIComponent(metaMatch[1]!)
			if (!isBoardUuid(boardId)) {
				return jsonResponse(
					request,
					400,
					{ error: 'Invalid board id' },
					{ methods: 'GET, PATCH, OPTIONS' },
				)
			}
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					status: 204,
					headers: jsonHeaders(request, {
						methods: 'GET, PATCH, OPTIONS',
						maxAge: 86400,
					}),
				})
			}
			if (request.method !== 'GET' && request.method !== 'PATCH') {
				return jsonResponse(
					request,
					405,
					{ error: 'Method not allowed' },
					{ methods: 'GET, PATCH, OPTIONS' },
				)
			}
			const id = env.WHITEBOARDS.idFromName(boardId)
			const stub = env.WHITEBOARDS.get(id)
			const forwardUrl = new URL(request.url)
			const hostProof = readHostProof(request, forwardUrl)
			const headers = copyProofHeaders(request, { includeCookie: true })
			headers.set('Content-Type', 'application/json')
			forwardLegacyProofHeaders(request, forwardUrl, headers)
			forwardUrl.searchParams.set('boardId', boardId)
			if (hostProof.value && !headers.has('X-Board-Host')) {
				headers.set('X-Board-Host', hostProof.value)
			}
			let body: string | undefined
			if (request.method === 'PATCH') {
				try {
					body = JSON.stringify(await readBoundedJsonBody(request))
				} catch (error) {
					if (error instanceof JsonBodyError) {
						return jsonResponse(request, error.status, { error: error.message }, {
							methods: 'GET, PATCH, OPTIONS',
						})
					}
					return jsonResponse(request, 400, { error: 'Invalid JSON body' }, {
						methods: 'GET, PATCH, OPTIONS',
					})
				}
			}
			const metaResponse = await stub.fetch(
				new Request(forwardUrl.toString(), {
					method: request.method,
					headers,
					body,
				}),
			)
			// PHASE 3.2: Save/claim sets Google owner — move temp R2 objects.
			if (request.method === 'PATCH' && metaResponse.ok) {
				ctx.waitUntil(
					claimTempAssetsFromMetaResponse(
						env,
						boardId,
						metaResponse.clone(),
					),
				)
			}
			return withJsonHeaders(request, metaResponse, {
				methods: 'GET, PATCH, OPTIONS',
			})
		}

		// PHASE 3.2: same-origin video player must be frameable by the canvas.
		if (url.pathname === '/whiteboard-player') {
			const page = await handle(request, env, ctx)
			const headers = new Headers(page.headers)
			headers.set('X-Frame-Options', 'SAMEORIGIN')
			return new Response(page.body, {
				status: page.status,
				statusText: page.statusText,
				headers,
			})
		}

		// Prerendered pages + static assets via Astro Cloudflare handler
		return handle(request, env, ctx)
	},
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		try {
			await cleanupExpiredNotifications(env)
		} catch (error) {
			console.error(JSON.stringify({
				event: 'notification_cleanup_failed',
				error: error instanceof Error ? error.message : 'Unknown error',
			}))
		}
	},
} satisfies ExportedHandler<Env>
