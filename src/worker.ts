/**
 * Custom Worker entry for Astro assets + whiteboard sync / asset APIs.
 *
 * Cloudflare resource family: scsfoxchase-tech_whiteboards
 * - Binding WHITEBOARDS → Durable Object class WhiteboardBoard (SQLite)
 * - Binding WHITEBOARD_ASSETS → R2 bucket scsfoxchase-tech-whiteboards
 *   (R2 names disallow `_`; product family keeps the underscore spelling)
 * - Binding WHITEBOARD_CODES → KV share-code → boardId index (permanent per board)
 * - Cloud library indexes (Phase 4b): R2 JSON under library/{ownerKey}/*.json
 * - Auth: Clerk (CLERK_SECRET_KEY + PUBLIC_CLERK_PUBLISHABLE_KEY)
 */
import { handle } from '@astrojs/cloudflare/handler'
import {
	claimTempAssetsFromMetaResponse,
	handleAssetRequest,
} from './worker/assetRoutes'
import { handleCodeRequest } from './worker/codeRoutes'
import { handleLibraryRequest } from './worker/libraryRoutes'
import { handleForceFollowRequest } from './worker/forceFollowRoutes'
import { handleParticipantRequest } from './worker/participantRoutes'
import { handleAdminRequest } from './worker/adminRoutes'
import { WhiteboardBoard } from './worker/WhiteboardBoard'

export { WhiteboardBoard }

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isBoardUuid(value: string): boolean {
	return UUID_RE.test(value)
}

function looksLikeJwt(raw: string | null): boolean {
	if (!raw) return false
	const parts = raw.trim().split('.')
	return parts.length === 3 && raw.trim().length > 40
}

/** Host proof only — skip JWT-shaped leftovers so Clerk Bearer stays Clerk. */
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

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url)

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

		// PHASE 3.2 — R2 asset upload / download / delete / claim / expire-temp
		if (url.pathname.startsWith('/api/whiteboard/assets')) {
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
				return new Response('Invalid board id', { status: 400 })
			}
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket upgrade', { status: 426 })
			}
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
				return new Response('Invalid board id', { status: 400 })
			}
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 204 })
			}
			const id = env.WHITEBOARDS.idFromName(boardId)
			const stub = env.WHITEBOARDS.get(id)
			const forwardUrl = new URL(request.url)
			forwardUrl.searchParams.set('boardId', boardId)
			const hostSecret = extractHostSecret(request, forwardUrl)
			if (hostSecret) forwardUrl.searchParams.set('hostSecret', hostSecret)
			const actorSessionId = request.headers.get('X-Board-Session')?.trim()
			const actorAuth = request.headers.get('X-Board-Auth')?.trim()
			if (actorSessionId) {
				forwardUrl.searchParams.set('actorSessionId', actorSessionId)
			}
			if (actorAuth) {
				forwardUrl.searchParams.set('actorAuth', actorAuth)
			}
			const headers = new Headers({ 'Content-Type': 'application/json' })
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
			const body =
				request.method === 'GET' || request.method === 'HEAD'
					? undefined
					: await request.text()
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
			return metaResponse
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
} satisfies ExportedHandler<Env>
