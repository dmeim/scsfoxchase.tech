/**
 * Cloudflare Worker bindings for scsfoxchase-tech.
 * Generated-style Env used by src/worker.ts and WhiteboardBoard.
 *
 * Resource family: scsfoxchase-tech_whiteboards
 * - WHITEBOARDS → Durable Object class WhiteboardBoard
 * - WHITEBOARD_ASSETS → R2 bucket scsfoxchase-tech-whiteboards
 *   (also stores Phase 4b cloud library JSON under library/{ownerKey}/)
 * - WHITEBOARD_CODES → KV share-code → boardId index (permanent per board)
 *
 * Clerk (Phase 4b) — set via wrangler secret / Workers Builds / .dev.vars:
 * - CLERK_SECRET_KEY (secret)
 * - PUBLIC_CLERK_PUBLISHABLE_KEY (var; also baked into client at build)
 * - PUBLIC_CLERK_ALLOWED_DOMAINS (optional; comma-separated domains/emails)
 * - WHITEBOARD_ADMIN_SECRET (secret; POST /api/whiteboard/admin/wipe-storage)
 */
interface Env {
	WHITEBOARDS: DurableObjectNamespace
	WHITEBOARD_ASSETS: R2Bucket
	WHITEBOARD_CODES: KVNamespace
	ASSETS: Fetcher
	CLERK_SECRET_KEY?: string
	PUBLIC_CLERK_PUBLISHABLE_KEY?: string
	CLERK_PUBLISHABLE_KEY?: string
	PUBLIC_CLERK_ALLOWED_DOMAINS?: string
	WHITEBOARD_ADMIN_SECRET?: string
}
