/**
 * R2 asset upload / download / delete for whiteboard media.
 * Keys: assets/{ownerKey}/{assetId}
 * Board-scoped keys: boards/{boardId}/assets/{fileId}
 *   google:{accountId} — signed-in saved boards
 *   temp:{boardId}     — unsaved / signed-out scratch (24h TTL unless savedToLibrary)
 *   local:{deviceId}   — leftover hub objects (GET only; no new writes)
 * Routes: PUT|GET|DELETE /api/whiteboard/assets/{ownerKey}/{assetId}
 *         POST /api/whiteboard/assets/claim
 * There is no public global temp-asset sweep route. Expiry is board-scoped
 * through the Durable Object alarm; the legacy PUT path may run a guarded
 * best-effort sweep as maintenance.
 *
 * Account-global PUT/DELETE google:*: matching Clerk Owner only. Viewers
 * are read-only. Canvas writes use the board-scoped route
 * `/api/whiteboard/boards/{boardId}/assets/{fileId}`.
 * temp:* requires a host secret or a live can-edit board session.
 * local:* PUT/DELETE are rejected. Guessing a fileId is not enough.
 * GET stays unauthenticated so connected players can load media; SVG is
 * served as an attachment with nosniff (not a navigable executable document).
 * Hub board previews PUT with X-Whiteboard-Kind: preview (short cache, not
 * immutable). Board-scoped file ids are a UUID (legacy) or SHA-256 hex.
 */
import {
	PREVIEW_CACHE_CONTROL,
	WHITEBOARD_PREVIEW_KIND,
	WHITEBOARD_PREVIEW_KIND_HEADER,
} from '../lib/whiteboard-preview-url'
import { UNSAVED_BOARD_TTL_MS } from '../lib/whiteboard-sync'
import {
	requireClerkWhiteboardAuth,
	verifyClerkWhiteboardTokenResult,
	type ClerkWhiteboardAuth,
} from './clerkAuth'
import type { WhiteboardBoard } from './WhiteboardBoard'

export const MAX_ASSET_BYTES = 8 * 1024 * 1024 // 8 MB — Chromebook-friendly

const ALLOWED_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	'video/mp4',
	'video/webm',
])

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/

/** Leftover GET: local:{uuid}; saved: google:{sub}; scratch media: temp:{boardUuid} */
const OWNER_KEY_RE = /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/

function isAssetUuid(value: string): boolean {
	return UUID_RE.test(value)
}

/** Legacy UUID file ids or SHA-256 hex of the bytes. Board ids stay UUID. */
export function isAssetFileId(value: string): boolean {
	return isAssetUuid(value) || CONTENT_HASH_RE.test(value)
}

function isContentHashFileId(value: string): boolean {
	return CONTENT_HASH_RE.test(value)
}

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as unknown as BufferSource,
	)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

function isOwnerKey(value: string): boolean {
	return OWNER_KEY_RE.test(value)
}

export function isTempOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith('temp:')
}

export function isLocalOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith('local:')
}

export function tempOwnerKey(boardId: string): string {
	return `temp:${boardId}`
}

export function r2TempPrefix(boardId: string): string {
	return `assets/${tempOwnerKey(boardId)}/`
}

export function r2ObjectKey(ownerKey: string, assetId: string): string {
	return `assets/${ownerKey}/${assetId}`
}

export function boardAssetR2Key(boardId: string, fileId: string): string {
	return `boards/${boardId}/assets/${fileId}`
}

export type BoardAssetPath = { boardId: string; fileId: string }

function decodePathPart(value: string): string | null {
	try {
		return decodeURIComponent(value)
	} catch {
		return null
	}
}

export function parseBoardAssetPath(pathname: string): BoardAssetPath | null {
	const match = pathname.match(
		/^\/api\/whiteboard\/boards\/([^/]+)\/assets\/([^/]+)\/?$/i,
	)
	if (!match) return null
	const boardId = decodePathPart(match[1]!)
	const fileId = decodePathPart(match[2]!)
	if (!boardId || !fileId || !isAssetUuid(boardId) || !isAssetFileId(fileId)) {
		return null
	}
	return { boardId, fileId }
}

export function isBoardAssetPath(pathname: string): boolean {
	return /^\/api\/whiteboard\/boards\/[^/]+\/assets(?:\/|$)/i.test(pathname)
}

function boardIdFromTempR2Key(key: string): string | null {
	const prefix = 'assets/temp:'
	if (!key.startsWith(prefix)) return null
	const rest = key.slice(prefix.length)
	const slash = rest.indexOf('/')
	const boardId = slash === -1 ? rest : rest.slice(0, slash)
	return UUID_RE.test(boardId) ? boardId : null
}

/** google then temp, then the requested prefix (covers leftover `local:`). */
function assetOwnerKeysToTry(
	requestedOwnerKey: string,
	boardHint: string | null,
): string[] {
	const fromTemp = isTempOwnerKey(requestedOwnerKey)
		? requestedOwnerKey.slice('temp:'.length)
		: null
	const boardId =
		fromTemp && UUID_RE.test(fromTemp)
			? fromTemp
			: boardHint && UUID_RE.test(boardHint)
				? boardHint
				: null
	const temp = boardId ? tempOwnerKey(boardId) : null
	const google = requestedOwnerKey.startsWith('google:')
		? requestedOwnerKey
		: null
	return [
		...new Set(
			[google, temp, requestedOwnerKey].filter(Boolean) as string[],
		),
	]
}

/**
 * Match /api/whiteboard/assets/{ownerKey}/{assetId}
 * ownerKey may contain `:` so we split on the last `/` after the prefix.
 */
export function parseAssetPath(
	pathname: string,
): { ownerKey: string; assetId: string } | null {
	const prefix = '/api/whiteboard/assets/'
	if (!pathname.startsWith(prefix)) return null
	const rest = pathname.slice(prefix.length).replace(/\/$/, '')
	const slash = rest.lastIndexOf('/')
	if (slash <= 0) return null
	const ownerKey = decodePathPart(rest.slice(0, slash))
	const assetId = decodePathPart(rest.slice(slash + 1))
	if (!ownerKey || !assetId) return null
	if (!isOwnerKey(ownerKey) || !isAssetUuid(assetId)) return null
	return { ownerKey, assetId }
}

/** Site + local Astro origins only. Never echo an arbitrary Origin. */
const ALLOWED_CORS_ORIGINS = new Set([
	'https://scsfoxchase.tech',
	'https://www.scsfoxchase.tech',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
])

const CORS_ALLOW_HEADERS =
	'Content-Type, Content-Length, Authorization, X-Board-Host, X-Board-Session, X-Board-Auth, X-Board-Id, X-Whiteboard-Kind'

function isPreviewKindRequest(request: Request): boolean {
	return (
		request.headers.get(WHITEBOARD_PREVIEW_KIND_HEADER)?.trim().toLowerCase() ===
		WHITEBOARD_PREVIEW_KIND
	)
}

function assetCacheControl(kind: string): string {
	if (kind === WHITEBOARD_PREVIEW_KIND) return PREVIEW_CACHE_CONTROL
	if (kind === 'temp') return 'private, max-age=3600'
	return 'public, max-age=31536000, immutable'
}

function corsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get('Origin')
	if (!origin || !ALLOWED_CORS_ORIGINS.has(origin)) {
		return {}
	}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
		'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
		Vary: 'Origin',
	}
}

async function assertGoogleOwnerWrite(
	request: Request,
	env: Env,
	ownerKey: string,
): Promise<Response | null> {
	if (!ownerKey.startsWith('google:')) {
		return jsonError(
			403,
			'This prefix requires a host secret or editor session',
			request,
		)
	}
	const authResult = await requireClerkWhiteboardAuth(request, env)
	if (!authResult.ok) {
		const headers = new Headers(authResult.response.headers)
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})
		return new Response(authResult.response.body, {
			status: authResult.response.status,
			headers,
		})
	}
	if (authResult.auth.ownerKey !== ownerKey) {
		return jsonError(403, 'ownerKey does not match signed-in account', request)
	}
	return null
}

function extractHostSecret(request: Request): string | null {
	const header = request.headers.get('X-Board-Host')?.trim()
	if (header) return header
	const auth = request.headers.get('Authorization')
	if (auth?.toLowerCase().startsWith('bearer ')) {
		const token = auth.slice(7).trim()
		// Host secrets are hex; Clerk JWTs contain '.'.
		if (token && !token.includes('.')) return token
	}
	return new URL(request.url).searchParams.get('hostSecret')?.trim() || null
}

function extractSessionProof(
	request: Request,
): { sessionId: string; authToken: string } | null {
	const sessionId = request.headers.get('X-Board-Session')?.trim() || ''
	const authToken = request.headers.get('X-Board-Auth')?.trim() || ''
	if (!sessionId || !authToken) return null
	return { sessionId, authToken }
}

function boardIdForAssetWrite(
	request: Request,
	ownerKey: string,
): string | null {
	if (isTempOwnerKey(ownerKey)) {
		const fromKey = ownerKey.slice('temp:'.length)
		if (!UUID_RE.test(fromKey)) return null
		const headerId = request.headers.get('X-Board-Id')?.trim() || ''
		if (headerId && headerId !== fromKey) return null
		return fromKey
	}
	return null
}

function extractClerkBearer(request: Request): string | null {
	const auth = request.headers.get('Authorization')?.trim() || ''
	if (!auth.toLowerCase().startsWith('bearer ')) return null
	const token = auth.slice(7).trim()
	if (!token || !token.includes('.')) return null
	return token
}

async function verifyBoardWriteAccess(
	env: Env,
	boardId: string,
	hostSecret: string | null,
	session: { sessionId: string; authToken: string } | null,
	clerk?: ClerkWhiteboardAuth | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const stub = env.WHITEBOARDS.get(
		env.WHITEBOARDS.idFromName(boardId),
	) as DurableObjectStub<WhiteboardBoard>
	return stub.assertAssetWriteAccess({
		hostSecret,
		sessionId: session?.sessionId ?? null,
		authToken: session?.authToken ?? null,
		clerk: clerk
			? {
					accountId: clerk.accountId,
					ownerKey: clerk.ownerKey,
					clerkUserId: clerk.clerkUserId,
					profileDegraded: clerk.profileDegraded,
				}
			: null,
	})
}

async function assertBoardAssetWrite(
	request: Request,
	env: Env,
	boardId: string,
): Promise<Response | null> {
	const suppliedBoardId = request.headers.get('X-Board-Id')?.trim() || ''
	const queryBoardId = new URL(request.url).searchParams.get('boardId')?.trim() || ''
	if (
		(suppliedBoardId && suppliedBoardId !== boardId) ||
		(queryBoardId && queryBoardId !== boardId)
	) {
		return jsonError(403, 'Board proof does not match this board', request)
	}

	const hostSecret = extractHostSecret(request)
	const session = extractSessionProof(request)
	try {
		if (hostSecret || session) {
			const result = await verifyBoardWriteAccess(
				env,
				boardId,
				hostSecret,
				session,
			)
			if (result.ok) return null
			return jsonError(result.status, result.error, request)
		}

		const bearer = extractClerkBearer(request)
		if (!bearer) {
			return jsonError(401, 'Host secret or editor session required', request)
		}
		const verified = await verifyClerkWhiteboardTokenResult(
			bearer,
			env,
			request.headers.get('Origin'),
		)
		if (!verified.ok) {
			return jsonError(
				403,
				"Not allowed to write this board's assets",
				request,
			)
		}
		const result = await verifyBoardWriteAccess(
			env,
			boardId,
			null,
			null,
			verified.auth,
		)
		if (result.ok) return null
		return jsonError(result.status, result.error, request)
	} catch {
		return jsonError(503, 'Could not verify board write access', request)
	}
}

/**
 * Account-global saved-board legacy PUT/DELETE requires the Clerk account
 * encoded by the `google:` owner key. Canvas writes use the board-scoped
 * route; this path no longer accepts board-context PUTs.
 */
async function assertGoogleAssetWrite(
	request: Request,
	env: Env,
	ownerKey: string,
): Promise<Response | null> {
	return assertGoogleOwnerWrite(request, env, ownerKey)
}

async function assertTempWrite(
	request: Request,
	env: Env,
	ownerKey: string,
): Promise<Response | null> {
	const hostSecret = extractHostSecret(request)
	const session = extractSessionProof(request)
	if (!hostSecret && !session) {
		return jsonError(
			401,
			'Host secret or editor session required',
			request,
		)
	}

	const boardId = boardIdForAssetWrite(request, ownerKey)
	if (!boardId) {
		return jsonError(401, 'Board proof required', request)
	}

	try {
		const result = await verifyBoardWriteAccess(
			env,
			boardId,
			hostSecret,
			session,
		)
		if (result.ok) return null
		return jsonError(result.status, result.error, request)
	} catch {
		return jsonError(
			503,
			'Could not verify board write access',
			request,
		)
	}
}

/** PUT/DELETE gate: never skip temp:* as unauthenticated capability URLs. */
async function assertAssetWrite(
	request: Request,
	env: Env,
	ownerKey: string,
): Promise<Response | null> {
	if (ownerKey.startsWith('google:')) {
		return assertGoogleAssetWrite(request, env, ownerKey)
	}
	if (isTempOwnerKey(ownerKey)) {
		return assertTempWrite(request, env, ownerKey)
	}
	if (isLocalOwnerKey(ownerKey)) {
		return jsonError(403, 'local: prefix is read-only', request)
	}
	return jsonError(403, 'Unsupported owner key', request)
}

function jsonError(
	status: number,
	message: string,
	request: Request,
): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
		},
	})
}

function jsonOk(
	request: Request,
	body: unknown,
	status = 200,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(request),
		},
	})
}

type BoundedBody =
	| { bytes: Uint8Array; tooLarge: false }
	| { bytes: Uint8Array; tooLarge: true }

/** Read at most `limit + 1` bytes so oversized requests never buffer fully. */
async function readBodyWithLimit(
	request: Request,
	limit: number,
): Promise<BoundedBody> {
	const reader = request.body?.getReader()
	if (!reader) return { bytes: new Uint8Array(), tooLarge: false }

	const chunks: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value?.byteLength) continue
			const remaining = limit + 1 - size
			if (remaining <= 0) {
				await reader.cancel()
				return { bytes: new Uint8Array(), tooLarge: true }
			}
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining))
				size += remaining
				await reader.cancel()
				return { bytes: new Uint8Array(), tooLarge: true }
			}
			chunks.push(value)
			size += value.byteLength
			if (size > limit) {
				await reader.cancel()
				return { bytes: new Uint8Array(), tooLarge: true }
			}
		}

		const bytes = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return { bytes, tooLarge: false }
	} finally {
		reader.releaseLock()
	}
}

function isExpiredUpload(uploaded: Date, now = Date.now()): boolean {
	return now - uploaded.getTime() >= UNSAVED_BOARD_TTL_MS
}

/**
 * Public GET meta includes `savedToLibrary` without revealing `cloudOwnerKey`.
 * `null` means the flag could not be read — callers must not expire temp media.
 */
async function readSavedToLibraryFlag(
	env: Env,
	boardId: string,
): Promise<boolean | null> {
	if (!UUID_RE.test(boardId)) return null
	try {
		const stub = boardStub(env, boardId)
		const res = await stub.fetch(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta?boardId=${encodeURIComponent(boardId)}`,
				{ method: 'GET' },
			),
		)
		if (!res.ok) return null
		const meta = (await res.json()) as { savedToLibrary?: unknown }
		return meta.savedToLibrary === true
	} catch {
		return null
	}
}

/** Copy temp:{boardId}/* → google:{id}/*. Keep temp; the DO rewrites persisted player URLs. */
export async function moveTempPrefixToOwner(
	env: Env,
	boardId: string,
	destOwnerKey: string,
): Promise<{ moved: string[] }> {
	if (!destOwnerKey.startsWith('google:')) {
		return { moved: [] }
	}
	const prefix = r2TempPrefix(boardId)
	const moved: string[] = []
	let cursor: string | undefined
	do {
		const listed = await env.WHITEBOARD_ASSETS.list({
			prefix,
			cursor,
			limit: 100,
		})
		for (const obj of listed.objects) {
			const fileId = obj.key.slice(prefix.length)
			if (!fileId || fileId.includes('/') || !isAssetFileId(fileId)) continue
			const source = await env.WHITEBOARD_ASSETS.get(obj.key)
			if (!source) continue
			const destKey = r2ObjectKey(destOwnerKey, fileId)
			const destination = await env.WHITEBOARD_ASSETS.put(destKey, source.body, {
				onlyIf: { etagDoesNotMatch: '*' },
				httpMetadata: source.httpMetadata,
				customMetadata: {
					...source.customMetadata,
					ownerKey: destOwnerKey,
					assetId: fileId,
					kind: 'persistent',
				},
			})
			// A pre-existing destination wins; never overwrite a user's asset when
			// two boards claim the same legacy file id.
			if (destination !== null) moved.push(fileId)
			else if (await env.WHITEBOARD_ASSETS.head(destKey)) moved.push(fileId)
		}
		cursor = listed.truncated ? listed.cursor : undefined
	} while (cursor)
	return { moved }
}

/**
 * Delete temp:* objects older than 24h on unsaved boards only.
 * Saved boards keep temp until google-then-temp resolution can replace it.
 * Called from an authenticated temp PUT as maintenance. Unsaved-board
 * Durable Object alarms perform their own board-scoped prefix cleanup.
 */
export async function expireTempR2Objects(
	env: Env,
	now = Date.now(),
): Promise<number> {
	let deleted = 0
	let cursor: string | undefined
	const savedByBoard = new Map<string, boolean | null>()
	do {
		const listed = await env.WHITEBOARD_ASSETS.list({
			prefix: 'assets/temp:',
			cursor,
			limit: 100,
		})
		const stale: string[] = []
		for (const obj of listed.objects) {
			if (!isExpiredUpload(obj.uploaded, now)) continue
			const boardId = boardIdFromTempR2Key(obj.key)
			if (!boardId) {
				stale.push(obj.key)
				continue
			}
			let saved = savedByBoard.get(boardId)
			if (saved === undefined) {
				saved = await readSavedToLibraryFlag(env, boardId)
				savedByBoard.set(boardId, saved)
			}
			if (saved !== false) continue
			stale.push(obj.key)
		}
		if (stale.length > 0) {
			await env.WHITEBOARD_ASSETS.delete(stale)
			deleted += stale.length
		}
		cursor = listed.truncated ? listed.cursor : undefined
	} while (cursor)
	return deleted
}

/** PHASE 3.2: after hub Save/claim PATCHes board meta, move temp R2 objects. */
export async function claimTempAssetsFromMetaResponse(
	env: Env,
	boardId: string,
	response: Response,
): Promise<void> {
	try {
		const meta = (await response.json()) as {
			savedToLibrary?: unknown
			cloudOwnerKey?: unknown
		}
		if (meta.savedToLibrary !== true) return
		if (
			typeof meta.cloudOwnerKey !== 'string' ||
			!meta.cloudOwnerKey.startsWith('google:')
		) {
			return
		}
		await moveTempPrefixToOwner(env, boardId, meta.cloudOwnerKey)
	} catch {
		// best-effort; canvas hook also claims
	}
}

function boardStub(
	env: Env,
	boardId: string,
): DurableObjectStub<WhiteboardBoard> {
	return env.WHITEBOARDS.get(
		env.WHITEBOARDS.idFromName(boardId),
	) as DurableObjectStub<WhiteboardBoard>
}

/**
 * GET meta reveals `cloudOwnerKey` only to the matching Owner or host.
 * Do not send a leftover host secret on the Clerk-only probe — that would
 * expose another account's key. Host GETs are used only after
 * `assertAssetWriteAccess` confirms the secret.
 */
async function readRevealedCloudOwnerKey(
	stub: DurableObjectStub<WhiteboardBoard>,
	request: Request,
	boardId: string,
	proof: {
		hostSecret?: string | null
		authorization?: string | null
		session?: { sessionId: string; authToken: string } | null
	},
): Promise<string | null> {
	const forwardUrl = new URL(request.url)
	forwardUrl.pathname = `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`
	forwardUrl.search = ''
	forwardUrl.searchParams.set('boardId', boardId)
	const hostSecret = proof.hostSecret?.trim()
	if (hostSecret) {
		forwardUrl.searchParams.set('hostSecret', hostSecret)
	}
	const headers = new Headers({ 'Content-Type': 'application/json' })
	const authorization = proof.authorization?.trim()
	if (authorization) {
		headers.set('Authorization', authorization)
	}
	const session = proof.session
	if (session?.sessionId && session.authToken) {
		headers.set('X-Board-Session', session.sessionId)
		headers.set('X-Board-Auth', session.authToken)
	}
	const origin = request.headers.get('Origin')
	if (origin) headers.set('Origin', origin)
	const cookie = request.headers.get('Cookie')
	if (cookie && !hostSecret) headers.set('Cookie', cookie)

	const res = await stub.fetch(
		new Request(forwardUrl.toString(), { method: 'GET', headers }),
	)
	if (!res.ok) return null
	const meta = (await res.json()) as { cloudOwnerKey?: unknown }
	if (
		typeof meta.cloudOwnerKey === 'string' &&
		meta.cloudOwnerKey.startsWith('google:')
	) {
		return meta.cloudOwnerKey
	}
	return null
}

/**
 * Destination is the board's Google Owner, never an arbitrary Clerk caller.
 * Matching Owner may claim without a host secret. Scratch (unset
 * cloudOwnerKey) requires a valid host secret before moving into the
 * caller's google: prefix. A leftover host secret cannot retarget an
 * existing google: prefix to a different account.
 */
async function resolveClaimDestination(
	request: Request,
	env: Env,
	boardId: string,
	clerkOwnerKey: string,
): Promise<
	{ ok: true; destOwnerKey: string } | { ok: false; response: Response }
> {
	if (!clerkOwnerKey.startsWith('google:')) {
		return {
			ok: false,
			response: jsonError(
				403,
				'ownerKey does not match signed-in account',
				request,
			),
		}
	}

	const stub = boardStub(env, boardId)
	let revealed: string | null
	try {
		revealed = await readRevealedCloudOwnerKey(stub, request, boardId, {
			authorization: request.headers.get('Authorization'),
		})
	} catch {
		return {
			ok: false,
			response: jsonError(503, 'Could not verify board owner', request),
		}
	}
	if (revealed === clerkOwnerKey) {
		return { ok: true, destOwnerKey: clerkOwnerKey }
	}

	const hostSecret = extractHostSecret(request)
	if (!hostSecret) {
		return {
			ok: false,
			response: jsonError(
				403,
				"Not allowed to claim this board's assets",
				request,
			),
		}
	}

	let hostCheck: Awaited<ReturnType<WhiteboardBoard['assertAssetWriteAccess']>>
	try {
		hostCheck = await stub.assertAssetWriteAccess({
			hostSecret,
			sessionId: null,
			authToken: null,
		})
	} catch {
		return {
			ok: false,
			response: jsonError(
				503,
				'Could not verify board write access',
				request,
			),
		}
	}
	if (!hostCheck.ok) {
		return {
			ok: false,
			response: jsonError(hostCheck.status, hostCheck.error, request),
		}
	}

	let stored: string | null
	try {
		stored = await readRevealedCloudOwnerKey(stub, request, boardId, {
			hostSecret,
		})
	} catch {
		return {
			ok: false,
			response: jsonError(503, 'Could not verify board owner', request),
		}
	}
	if (stored && stored.startsWith('google:') && stored !== clerkOwnerKey) {
		return {
			ok: false,
			response: jsonError(
				403,
				"Not allowed to claim this board's assets",
				request,
			),
		}
	}

	return { ok: true, destOwnerKey: clerkOwnerKey }
}

async function handleClaim(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		})
	}
	if (request.method !== 'POST') {
		return jsonError(405, 'Method not allowed', request)
	}

	let body: { boardId?: unknown }
	try {
		body = (await request.json()) as typeof body
	} catch {
		return jsonError(400, 'Invalid JSON body', request)
	}
	const boardId = typeof body.boardId === 'string' ? body.boardId.trim() : ''
	if (!UUID_RE.test(boardId)) {
		return jsonError(400, 'Invalid boardId', request)
	}

	const authResult = await requireClerkWhiteboardAuth(request, env)
	if (!authResult.ok) {
		const headers = new Headers(authResult.response.headers)
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})
		return new Response(authResult.response.body, {
			status: authResult.response.status,
			headers,
		})
	}

	const resolved = await resolveClaimDestination(
		request,
		env,
		boardId,
		authResult.auth.ownerKey,
	)
	if (!resolved.ok) return resolved.response

	const destOwnerKey = resolved.destOwnerKey
	const { moved } = await moveTempPrefixToOwner(env, boardId, destOwnerKey)
	const stub = boardStub(env, boardId)
	let rewrite: Awaited<
		ReturnType<WhiteboardBoard['rewriteTempPlayerUrlsAfterClaim']>
	>
	try {
		rewrite = await stub.rewriteTempPlayerUrlsAfterClaim({
			boardId,
			googleOwnerKey: destOwnerKey,
		})
	} catch {
		return jsonError(503, 'Could not update board player URLs', request)
	}
	if (!rewrite.ok) {
		return jsonError(rewrite.status, rewrite.error, request)
	}
	return jsonOk(request, {
		ok: true,
		boardId,
		ownerKey: destOwnerKey,
		moved,
		rewritten: rewrite.rewritten,
	})
}

async function handleBoardAssetRequest(
	request: Request,
	env: Env,
	parsed: BoardAssetPath,
): Promise<Response> {
	const { boardId, fileId } = parsed
	const key = boardAssetR2Key(boardId, fileId)

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders(request),
				'Access-Control-Max-Age': '86400',
			},
		})
	}

	if (request.method === 'PUT') {
		const writeDenied = await assertBoardAssetWrite(request, env, boardId)
		if (writeDenied) return writeDenied

		const contentType = (
			request.headers.get('Content-Type') || ''
		)
			.split(';')[0]
			.trim()
			.toLowerCase()
		if (!contentType || !ALLOWED_MIME.has(contentType)) {
			return jsonError(
				415,
				'Unsupported media type. Use JPEG, PNG, GIF, WebP, SVG, or MP4/WebM.',
				request,
			)
		}

		const contentLength = Number(request.headers.get('Content-Length') || '0')
		if (contentLength > MAX_ASSET_BYTES) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}
		if (!request.body) return jsonError(400, 'Missing body', request)

		const boundedBody = await readBodyWithLimit(request, MAX_ASSET_BYTES)
		if (boundedBody.tooLarge) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}
		const body = boundedBody.bytes
		if (body.byteLength === 0) return jsonError(400, 'Empty body', request)

		if (isContentHashFileId(fileId)) {
			const actual = await sha256HexOfBytes(body)
			if (actual !== fileId) {
				return jsonError(400, 'Body hash does not match file id', request)
			}
		}

		// Bytes in R2 are authoritative. The DO manifest is a best-effort GC index.
		await env.WHITEBOARD_ASSETS.put(key, body, {
			httpMetadata: {
				contentType,
				cacheControl: 'public, max-age=31536000, immutable',
			},
			customMetadata: {
				boardId,
				assetId: fileId,
				kind: 'board',
				createdAt: new Date().toISOString(),
			},
		})

		try {
			await boardStub(env, boardId).registerBoardAssetManifest({
				boardId,
				fileId,
				r2Key: key,
				mimeType: contentType,
				size: body.byteLength,
			})
		} catch (error) {
			console.error('whiteboard asset manifest register failed', error)
		}

		return jsonOk(
			request,
			{
				ok: true,
				boardId,
				fileId,
				r2Key: key,
				size: body.byteLength,
				mimeType: contentType,
			},
			201,
		)
	}

	if (request.method === 'GET' || request.method === 'HEAD') {
		const wantsRange = request.headers.has('Range')
		const object = await env.WHITEBOARD_ASSETS.get(
			key,
			wantsRange
				? { range: request.headers, onlyIf: request.headers }
				: { onlyIf: request.headers },
		)
		if (object === null) return jsonError(404, 'Asset not found', request)

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('Accept-Ranges', 'bytes')
		headers.set('X-Content-Type-Options', 'nosniff')
		const servedType = (headers.get('Content-Type') || '')
			.split(';')[0]
			.trim()
			.toLowerCase()
		if (servedType === 'image/svg+xml') {
			headers.set(
				'Content-Disposition',
				`attachment; filename="${fileId}.svg"`,
			)
			headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
		}
		headers.set('Cache-Control', 'public, max-age=31536000, immutable')
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})

		if (!('body' in object) || !object.body) {
			return new Response(null, { status: 304, headers })
		}
		if (request.method === 'HEAD') {
			return new Response(null, { status: 200, headers })
		}

		const range = object.range
		if (
			wantsRange &&
			range &&
			('offset' in range || 'length' in range)
		) {
			const offset = 'offset' in range && range.offset != null ? range.offset : 0
			const length =
				'length' in range && range.length != null
					? range.length
					: object.size - offset
			const end = offset + length - 1
			headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`)
			headers.set('Content-Length', String(length))
			return new Response(object.body, { status: 206, headers })
		}

		return new Response(object.body, { status: 200, headers })
	}

	if (request.method === 'DELETE') {
		const writeDenied = await assertBoardAssetWrite(request, env, boardId)
		if (writeDenied) return writeDenied

		let result: Awaited<
			ReturnType<WhiteboardBoard['deleteBoardAssetManifest']>
		>
		try {
			result = await boardStub(env, boardId).deleteBoardAssetManifest({
				fileId,
			})
		} catch {
			return jsonError(503, 'Could not update board asset manifest', request)
		}
		if (!result.ok) return jsonError(result.status, result.error, request)

		try {
			await env.WHITEBOARD_ASSETS.delete(key)
		} catch {
			return jsonError(503, 'Could not delete board asset', request)
		}
		return jsonOk(request, { ok: true, boardId, fileId })
	}

	return jsonError(405, 'Method not allowed', request)
}

export async function handleAssetRequest(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
): Promise<Response | null> {
	const url = new URL(request.url)

	if (url.pathname === '/api/whiteboard/assets/claim') {
		return handleClaim(request, env)
	}
	const boardAssetPath = parseBoardAssetPath(url.pathname)
	if (boardAssetPath) {
		return handleBoardAssetRequest(request, env, boardAssetPath)
	}
	if (isBoardAssetPath(url.pathname)) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(request),
			})
		}
		return jsonError(400, 'Invalid board asset path', request)
	}

	const parsed = parseAssetPath(url.pathname)
	if (!parsed) {
		// Only claim this path family — let caller 404 invalid shapes under /assets/
		if (url.pathname.startsWith('/api/whiteboard/assets')) {
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					status: 204,
					headers: corsHeaders(request),
				})
			}
			return jsonError(400, 'Invalid asset path', request)
		}
		return null
	}

	const { ownerKey, assetId } = parsed
	const key = r2ObjectKey(ownerKey, assetId)

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders(request),
				'Access-Control-Max-Age': '86400',
			},
		})
	}

	if (request.method === 'PUT') {
		const writeDenied = await assertAssetWrite(request, env, ownerKey)
		if (writeDenied) return writeDenied

		const contentType = (
			request.headers.get('Content-Type') || ''
		)
			.split(';')[0]
			.trim()
			.toLowerCase()
		if (!contentType || !ALLOWED_MIME.has(contentType)) {
			return jsonError(
				415,
				'Unsupported media type. Use JPEG, PNG, GIF, WebP, SVG, or MP4/WebM.',
				request,
			)
		}

		const contentLength = Number(request.headers.get('Content-Length') || '0')
		if (contentLength > MAX_ASSET_BYTES) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}

		if (!request.body) {
			return jsonError(400, 'Missing body', request)
		}

		const boundedBody = await readBodyWithLimit(request, MAX_ASSET_BYTES)
		if (boundedBody.tooLarge) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}
		const body = boundedBody.bytes
		if (body.byteLength === 0) {
			return jsonError(400, 'Empty body', request)
		}

		const kind = isPreviewKindRequest(request)
			? WHITEBOARD_PREVIEW_KIND
			: isTempOwnerKey(ownerKey)
				? 'temp'
				: 'persistent'
		await env.WHITEBOARD_ASSETS.put(key, body, {
			httpMetadata: {
				contentType,
				cacheControl: assetCacheControl(kind),
			},
			customMetadata: {
				ownerKey,
				assetId,
				kind,
				createdAt: new Date().toISOString(),
			},
		})

		if (kind === 'temp' && ctx) {
			ctx.waitUntil(expireTempR2Objects(env).then(() => undefined))
		}

		return jsonOk(
			request,
			{
				ok: true,
				ownerKey,
				assetId,
				r2Key: key,
				size: body.byteLength,
				mimeType: contentType,
			},
			201,
		)
	}

	if (request.method === 'GET' || request.method === 'HEAD') {
		const boardHint =
			url.searchParams.get('board')?.trim() ||
			url.searchParams.get('boardId')?.trim() ||
			request.headers.get('X-Board-Id')?.trim() ||
			null
		const owners = assetOwnerKeysToTry(ownerKey, boardHint)
		let servedOwnerKey = ownerKey
		let servedKey = key
		let object: R2Object | R2ObjectBody | null = null
		for (const tryOwner of owners) {
			const tryKey = r2ObjectKey(tryOwner, assetId)
			const found = await env.WHITEBOARD_ASSETS.get(tryKey, {
				range: request.headers,
				onlyIf: request.headers,
			})
			if (found !== null) {
				servedOwnerKey = tryOwner
				servedKey = tryKey
				object = found
				break
			}
		}
		if (object === null) {
			return jsonError(404, 'Asset not found', request)
		}

		if (
			isTempOwnerKey(servedOwnerKey) &&
			isExpiredUpload(object.uploaded)
		) {
			const boardId = servedOwnerKey.slice('temp:'.length)
			const saved = UUID_RE.test(boardId)
				? await readSavedToLibraryFlag(env, boardId)
				: false
			if (saved === false) {
				await env.WHITEBOARD_ASSETS.delete(servedKey)
				return jsonError(404, 'Asset expired', request)
			}
		}

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('Accept-Ranges', 'bytes')
		headers.set('X-Content-Type-Options', 'nosniff')
		const servedType = (headers.get('Content-Type') || '')
			.split(';')[0]
			.trim()
			.toLowerCase()
		if (servedType === 'image/svg+xml') {
			headers.set(
				'Content-Disposition',
				`attachment; filename="${assetId}.svg"`,
			)
			headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
		}
		const metaKind = object.customMetadata?.kind || ''
		headers.set(
			'Cache-Control',
			assetCacheControl(
				metaKind === WHITEBOARD_PREVIEW_KIND
					? WHITEBOARD_PREVIEW_KIND
					: isTempOwnerKey(servedOwnerKey)
						? 'temp'
						: 'persistent',
			),
		)
		Object.entries(corsHeaders(request)).forEach(([k, v]) => {
			headers.set(k, v)
		})

		if (!('body' in object) || !object.body) {
			return new Response(null, { status: 304, headers })
		}

		if (request.method === 'HEAD') {
			return new Response(null, { status: 200, headers })
		}

		const range = object.range
		const wantsRange = request.headers.has('Range')
		if (
			wantsRange &&
			range &&
			('offset' in range || 'length' in range)
		) {
			const offset = 'offset' in range && range.offset != null ? range.offset : 0
			const length =
				'length' in range && range.length != null
					? range.length
					: object.size - offset
			const end = offset + length - 1
			headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`)
			headers.set('Content-Length', String(length))
			return new Response(object.body, { status: 206, headers })
		}

		return new Response(object.body, { status: 200, headers })
	}

	if (request.method === 'DELETE') {
		const writeDenied = await assertAssetWrite(request, env, ownerKey)
		if (writeDenied) return writeDenied

		await env.WHITEBOARD_ASSETS.delete(key)
		return jsonOk(request, { ok: true })
	}

	return jsonError(405, 'Method not allowed', request)
}
