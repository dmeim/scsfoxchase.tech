/**
 * Custom Worker entry for Astro assets + whiteboard sync / asset APIs.
 *
 * Cloudflare resource family: scsfoxchase-tech_whiteboards
 * - Binding WHITEBOARDS → Durable Object class WhiteboardBoard (SQLite)
 * - Binding WHITEBOARD_ASSETS → R2 bucket scsfoxchase-tech-whiteboards
 *   (R2 names disallow `_`; product family keeps the underscore spelling)
 * - Binding WHITEBOARD_CODES → KV share-code → boardId index (TTL 12h)
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
import { WhiteboardBoard } from './worker/WhiteboardBoard'

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

		// Cloud board / asset library indexes (Clerk session required)
		if (url.pathname.startsWith('/api/whiteboard/library')) {
			const libraryResponse = await handleLibraryRequest(request, env)
			if (libraryResponse) return libraryResponse
		}

		// Share codes: join lookup + mint/revoke (Phase 5)
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
		// Phase 2: Excalidraw element diffs + persist, not tldraw useSync.
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
			const headerSecret = request.headers.get('X-Board-Host')?.trim()
			const auth = request.headers.get('Authorization')
			const bearer =
				auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
			const hostSecret =
				headerSecret || bearer || forwardUrl.searchParams.get('hostSecret')
			if (hostSecret) forwardUrl.searchParams.set('hostSecret', hostSecret)
			const body =
				request.method === 'GET' || request.method === 'HEAD'
					? undefined
					: await request.text()
			const metaResponse = await stub.fetch(
				new Request(forwardUrl.toString(), {
					method: request.method,
					headers: { 'Content-Type': 'application/json' },
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
