/**
 * R2 asset upload / download / delete for whiteboard media.
 * Keys: assets/{ownerKey}/{assetId}
 *   google:{accountId} — signed-in saved boards
 *   temp:{boardId}     — unsaved / signed-out scratch (24h TTL unless savedToLibrary)
 *   local:{deviceId}   — leftover hub objects (GET only; no new writes)
 * Routes: PUT|GET|DELETE /api/whiteboard/assets/{ownerKey}/{assetId}
 *         POST /api/whiteboard/assets/claim
 *         POST /api/whiteboard/assets/expire-temp
 *
 * PUT/DELETE google:*: matching Clerk Owner, or a live Owner/Manager/Editor
 * WebSocket session (`X-Board-Session` / `X-Board-Auth`) and/or host proof
 * for that board (`X-Board-Id`). Viewers are read-only.
 * temp:* requires a host secret or a live can-edit board session.
 * local:* PUT/DELETE are rejected. Guessing a fileId is not enough.
 * GET stays unauthenticated so connected players can load media; SVG is
 * served as an attachment with nosniff (not a navigable executable document).
 * Hub board previews PUT with X-Whiteboard-Kind: preview (short cache, not
 * immutable). Asset ids stay raw UUIDs — no /previews/ path or .jpg suffix.
 */
import {
	PREVIEW_CACHE_CONTROL,
	WHITEBOARD_PREVIEW_KIND,
	WHITEBOARD_PREVIEW_KIND_HEADER,
} from '../lib/whiteboard-preview-url'
import { UNSAVED_BOARD_TTL_MS } from '../lib/whiteboard-sync'
import { requireClerkWhiteboardAuth } from './clerkAuth'
import {
	corsHeaders,
	JsonBodyError,
	jsonHeaders,
	jsonResponse,
	logWhiteboardEvent,
	readHostProof,
	readBoundedJsonBody,
	withJsonHeaders,
	type HostProof,
} from './httpSecurity'
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
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/i

/** Leftover GET: local:{uuid}; saved: google:{sub}; scratch media: temp:{boardUuid} */
const OWNER_KEY_RE = /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/

function isAssetUuid(value: string): boolean {
	return UUID_RE.test(value)
}

export function boardAssetR2Key(boardId: string, fileId: string): string {
	return `boards/${boardId}/assets/${fileId}`
}

export type BoardAssetPath = { boardId: string; fileId: string }

/** Read-only compatibility route for board-scoped objects created by later clients. */
export function parseBoardAssetPath(pathname: string): BoardAssetPath | null {
	const match = pathname.match(
		/^\/api\/whiteboard\/boards\/([^/]+)\/assets\/([^/]+)\/?$/i,
	)
	if (!match) return null
	let boardId: string
	let fileId: string
	try {
		boardId = decodeURIComponent(match[1]!)
		fileId = decodeURIComponent(match[2]!)
	} catch {
		return null
	}
	if (!UUID_RE.test(boardId)) return null
	if (!UUID_RE.test(fileId) && !CONTENT_HASH_RE.test(fileId)) return null
	return { boardId, fileId }
}

export function isBoardAssetPath(pathname: string): boolean {
	return parseBoardAssetPath(pathname) !== null
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
	const ownerKey = decodeURIComponent(rest.slice(0, slash))
	const assetId = decodeURIComponent(rest.slice(slash + 1))
	if (!isOwnerKey(ownerKey) || !isAssetUuid(assetId)) return null
	return { ownerKey, assetId }
}

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
		return withJsonHeaders(request, authResult.response, {
			methods: 'GET, PUT, DELETE, POST, OPTIONS',
		})
	}
	if (authResult.auth.ownerKey !== ownerKey) {
		return jsonError(403, 'ownerKey does not match signed-in account', request)
	}
	return null
}

function extractHostProof(request: Request): HostProof {
	return readHostProof(request)
}

function extractSessionProof(
	request: Request,
): { sessionId: string; authToken: string } | null {
	const sessionId = request.headers.get('X-Board-Session')?.trim() || ''
	const authToken = request.headers.get('X-Board-Auth')?.trim() || ''
	if (!sessionId || !authToken) return null
	return { sessionId, authToken }
}

function boardIdFromRequest(request: Request): string | null {
	const headerId = request.headers.get('X-Board-Id')?.trim() || ''
	if (UUID_RE.test(headerId)) return headerId
	const queryId = new URL(request.url).searchParams.get('boardId')?.trim() || ''
	return UUID_RE.test(queryId) ? queryId : null
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
	if (ownerKey.startsWith('google:')) {
		return boardIdFromRequest(request)
	}
	return null
}

async function verifyBoardWriteAccess(
	env: Env,
	boardId: string,
	hostSecret: string | null,
	session: { sessionId: string; authToken: string } | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const stub = env.WHITEBOARDS.get(
		env.WHITEBOARDS.idFromName(boardId),
	) as DurableObjectStub<WhiteboardBoard>
	return stub.assertAssetWriteAccess({
		hostSecret,
		sessionId: session?.sessionId ?? null,
		authToken: session?.authToken ?? null,
	})
}

async function tryRevealCloudOwnerKey(
	request: Request,
	env: Env,
	boardId: string,
	hostSecret: string | null,
	session: { sessionId: string; authToken: string } | null,
): Promise<string | null> {
	const stub = boardStub(env, boardId)
	try {
		const viaClerk = await readRevealedCloudOwnerKey(stub, request, boardId, {
			authorization: request.headers.get('Authorization'),
			sessionId: session?.sessionId ?? null,
			authToken: session?.authToken ?? null,
		})
		if (viaClerk) return viaClerk
	} catch {
		// A failed owner reveal is not authorization. The caller must either
		// retry with a valid host proof or fail closed below.
	}
	if (!hostSecret) return null
	try {
		return await readRevealedCloudOwnerKey(stub, request, boardId, {
			hostSecret,
		})
	} catch {
		return null
	}
}

/**
 * Saved-board canvas PUT/DELETE: Owner Clerk match, or a live can-edit
 * session / host proof on this board. Do not use Clerk-owner as the sole gate
 * (student Editors are signed in as a different google: account).
 */
async function assertGoogleAssetWrite(
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

	const hostSecret = extractHostProof(request).value
	const session = extractSessionProof(request)
	const boardId = boardIdForAssetWrite(request, ownerKey)

	let boardResult: Awaited<ReturnType<typeof verifyBoardWriteAccess>> | null =
		null
	if (boardId && (hostSecret || session)) {
		try {
			boardResult = await verifyBoardWriteAccess(
				env,
				boardId,
				hostSecret,
				session,
			)
			if (boardResult.ok) {
				const revealed = await tryRevealCloudOwnerKey(
					request,
					env,
					boardId,
					hostSecret,
					session,
				)
				if (!revealed || revealed !== ownerKey) {
					return jsonError(
						403,
						'ownerKey does not match this board',
						request,
					)
				}
				return null
			}
		} catch {
			boardResult = {
				ok: false,
				status: 503,
				error: 'Could not verify board write access',
			}
		}
	}

	const clerkDenied = await assertGoogleOwnerWrite(request, env, ownerKey)
	if (!clerkDenied) return null
	if (boardResult && !boardResult.ok) {
		return jsonError(boardResult.status, boardResult.error, request)
	}
	if ((hostSecret || session) && !boardId) {
		return jsonError(401, 'Board proof required', request)
	}
	return clerkDenied
}

async function assertTempWrite(
	request: Request,
	env: Env,
	ownerKey: string,
): Promise<Response | null> {
	const hostSecret = extractHostProof(request).value
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
	if (status >= 400) {
		logWhiteboardEvent('api_error', { method: request.method, status })
	}
	return jsonResponse(
		request,
		status,
		{ error: message },
		{ methods: 'GET, PUT, DELETE, POST, OPTIONS' },
	)
}

function jsonOk(
	request: Request,
	body: unknown,
	status = 200,
): Response {
	return jsonResponse(
		request,
		status,
		body,
		{ methods: 'GET, PUT, DELETE, POST, OPTIONS' },
	)
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
		let listed: R2Objects
		try {
			listed = await env.WHITEBOARD_ASSETS.list({
				prefix,
				cursor,
				limit: 100,
			})
		} catch {
			logWhiteboardEvent('r2_list_error', { method: 'POST', status: 503 })
			throw new Error('R2 list failed')
		}
		for (const obj of listed.objects) {
			const fileId = obj.key.slice(prefix.length)
			if (!fileId || fileId.includes('/') || !isAssetUuid(fileId)) continue
			let source: R2ObjectBody | null
			try {
				source = await env.WHITEBOARD_ASSETS.get(obj.key)
			} catch {
				logWhiteboardEvent('r2_read_error', { method: 'POST', status: 503 })
				throw new Error('R2 read failed')
			}
			if (!source) continue
			const destKey = r2ObjectKey(destOwnerKey, fileId)
			try {
				await env.WHITEBOARD_ASSETS.put(destKey, source.body, {
					httpMetadata: source.httpMetadata,
					customMetadata: {
						...source.customMetadata,
						ownerKey: destOwnerKey,
						assetId: fileId,
						kind: 'persistent',
					},
				})
			} catch {
				logWhiteboardEvent('r2_write_error', { method: 'POST', status: 503 })
				throw new Error('R2 write failed')
			}
			moved.push(fileId)
		}
		cursor = listed.truncated ? listed.cursor : undefined
	} while (cursor)
	return { moved }
}

const TEMP_EXPIRY_BATCH_LIMIT = 100

type TempExpiryBatch = { deleted: number; cursor: string | null }

/**
 * Process one bounded page of stale temp objects. This is maintenance work,
 * never an upload/read side effect; callers must provide authentication and
 * may resume with the returned cursor.
 */
async function expireTempR2Batch(
	env: Env,
	now = Date.now(),
	cursor?: string,
): Promise<TempExpiryBatch> {
	const listed = await env.WHITEBOARD_ASSETS.list({
		prefix: 'assets/temp:',
		...(cursor ? { cursor } : {}),
		limit: TEMP_EXPIRY_BATCH_LIMIT,
	})
	const stale: string[] = []
	const savedByBoard = new Map<string, boolean | null>()
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
	}
	return {
		deleted: stale.length,
		cursor: listed.truncated ? listed.cursor || null : null,
	}
}

/**
 * Compatibility helper for operators/tests. It intentionally processes one
 * page only; bucket-wide scans belong to an authenticated maintenance caller.
 */
export async function expireTempR2Objects(
	env: Env,
	now = Date.now(),
	cursor?: string,
): Promise<number> {
	return (await expireTempR2Batch(env, now, cursor)).deleted
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
		sessionId?: string | null
		authToken?: string | null
	},
): Promise<string | null> {
	const forwardUrl = new URL(request.url)
	forwardUrl.pathname = `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`
	forwardUrl.search = ''
	forwardUrl.searchParams.set('boardId', boardId)
	const hostSecret = proof.hostSecret?.trim()
	const headers = new Headers({ 'Content-Type': 'application/json' })
	const authorization = proof.authorization?.trim()
	if (authorization) {
		headers.set('Authorization', authorization)
	}
	const sessionId = proof.sessionId?.trim()
	const authToken = proof.authToken?.trim()
	if (sessionId && authToken) {
		headers.set('X-Board-Session', sessionId)
		headers.set('X-Board-Auth', authToken)
	}
	const boardHost = request.headers.get('X-Board-Host')?.trim()
	if (boardHost) {
		headers.set('X-Board-Host', boardHost)
	} else if (hostSecret) {
		// Compatibility for callers that supplied Authorization: Bearer <host>.
		// The normal internal URL remains free of credential query parameters.
		headers.set('X-Board-Host', hostSecret)
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

	const hostSecret = extractHostProof(request).value
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
			headers: jsonHeaders(request, {
				methods: 'POST, OPTIONS',
				maxAge: 86400,
			}),
		})
	}
	if (request.method !== 'POST') {
		return jsonError(405, 'Method not allowed', request)
	}

	let body: { boardId?: unknown }
	try {
		const parsed = await readBoundedJsonBody(request)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return jsonError(400, 'Invalid JSON body', request)
		}
		body = parsed as typeof body
	} catch (error) {
		if (error instanceof JsonBodyError) {
			return jsonError(error.status, error.message, request)
		}
		return jsonError(400, 'Invalid JSON body', request)
	}
	const boardId = typeof body.boardId === 'string' ? body.boardId.trim() : ''
	if (!UUID_RE.test(boardId)) {
		return jsonError(400, 'Invalid boardId', request)
	}

	const authResult = await requireClerkWhiteboardAuth(request, env)
	if (!authResult.ok) {
		return withJsonHeaders(request, authResult.response, {
			methods: 'GET, PUT, DELETE, POST, OPTIONS',
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
	let moved: string[]
	try {
		moved = (await moveTempPrefixToOwner(env, boardId, destOwnerKey)).moved
	} catch {
		return jsonError(503, 'Could not claim temporary assets', request)
	}
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

async function handleExpireTemp(
	request: Request,
	env: Env,
): Promise<Response> {
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
		return jsonError(405, 'Method not allowed', request)
	}

	const configuredSecret = env.WHITEBOARD_ADMIN_SECRET?.trim() || ''
	if (!configuredSecret) {
		return jsonError(503, 'Maintenance is not configured', request)
	}
	const authorization = request.headers.get('Authorization')?.trim() || ''
	const presented = authorization.toLowerCase().startsWith('bearer ')
		? authorization.slice(7).trim()
		: ''
	const expected = new TextEncoder().encode(configuredSecret)
	const actual = new TextEncoder().encode(presented)
	let mismatch = expected.byteLength ^ actual.byteLength
	const compareLength = Math.max(expected.byteLength, actual.byteLength)
	for (let index = 0; index < compareLength; index += 1) {
		mismatch |= (actual[index] || 0) ^ (expected[index] || 0)
	}
	const authorized = mismatch === 0
	if (!authorized) {
		logWhiteboardEvent('maintenance_denied', {
			method: request.method,
			status: 401,
		})
		return jsonError(401, 'Unauthorized', request)
	}

	const cursor = new URL(request.url).searchParams.get('cursor')?.trim() || ''
	if (cursor.length > 1024) {
		return jsonError(400, 'Invalid maintenance cursor', request)
	}
	try {
		const batch = await expireTempR2Batch(env, Date.now(), cursor || undefined)
		logWhiteboardEvent('temp_expiry_batch', {
			method: request.method,
			count: batch.deleted,
			limit: TEMP_EXPIRY_BATCH_LIMIT,
		})
		return jsonOk(request, {
			ok: true,
			deleted: batch.deleted,
			nextCursor: batch.cursor,
			limit: TEMP_EXPIRY_BATCH_LIMIT,
		})
	} catch {
		logWhiteboardEvent('r2_maintenance_error', {
			method: request.method,
			status: 503,
		})
		return jsonError(503, 'Could not expire temporary assets', request)
	}
}

type R2AssetObject = R2Object | R2ObjectBody | null

async function responseForR2Object(
	request: Request,
	env: Env,
	object: R2AssetObject,
	assetId: string,
	servedOwnerKey: string | null,
): Promise<Response> {
	if (object === null) {
		return jsonError(404, 'Asset not found', request)
	}

	if (
		servedOwnerKey &&
		isTempOwnerKey(servedOwnerKey) &&
		isExpiredUpload(object.uploaded)
	) {
		const boardId = servedOwnerKey.slice('temp:'.length)
		const saved = UUID_RE.test(boardId)
			? await readSavedToLibraryFlag(env, boardId)
			: false
		if (saved === false) {
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
				: servedOwnerKey && isTempOwnerKey(servedOwnerKey)
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
	if (
		request.headers.has('Range') &&
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

export async function handleAssetRequest(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
): Promise<Response | null> {
	const url = new URL(request.url)

	if (url.pathname === '/api/whiteboard/assets/claim') {
		return handleClaim(request, env)
	}
	if (url.pathname === '/api/whiteboard/assets/expire-temp') {
		return handleExpireTemp(request, env)
	}

	const boardAsset = parseBoardAssetPath(url.pathname)
	if (boardAsset) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					...corsHeaders(request),
					'Access-Control-Max-Age': '86400',
				},
			})
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return jsonError(405, 'Board-scoped asset writes are disabled', request)
		}
		const key = boardAssetR2Key(boardAsset.boardId, boardAsset.fileId)
		let object: R2AssetObject
		try {
			object = await env.WHITEBOARD_ASSETS.get(key, {
				range: request.headers,
				onlyIf: request.headers,
			})
		} catch {
			logWhiteboardEvent('r2_read_error', {
				method: request.method,
				status: 503,
			})
			return jsonError(503, 'Asset storage is temporarily unavailable', request)
		}
		return responseForR2Object(
			request,
			env,
				object,
				boardAsset.fileId,
				null,
			)
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

		// Stream into R2; also enforce size if Content-Length was omitted
		const body = await request.arrayBuffer()
		if (body.byteLength === 0) {
			return jsonError(400, 'Empty body', request)
		}
		if (body.byteLength > MAX_ASSET_BYTES) {
			return jsonError(
				413,
				`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
				request,
			)
		}

		const kind = isPreviewKindRequest(request)
			? WHITEBOARD_PREVIEW_KIND
			: isTempOwnerKey(ownerKey)
				? 'temp'
				: 'persistent'
		try {
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
		} catch {
			logWhiteboardEvent('r2_write_error', {
				method: request.method,
				status: 503,
			})
			return jsonError(503, 'Asset storage is temporarily unavailable', request)
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
		let object: R2Object | R2ObjectBody | null = null
		for (const tryOwner of owners) {
			const tryKey = r2ObjectKey(tryOwner, assetId)
			let found: R2AssetObject
			try {
				found = await env.WHITEBOARD_ASSETS.get(tryKey, {
					range: request.headers,
					onlyIf: request.headers,
				})
			} catch {
				logWhiteboardEvent('r2_read_error', {
					method: request.method,
					status: 503,
				})
				return jsonError(503, 'Asset storage is temporarily unavailable', request)
			}
			if (found !== null) {
				servedOwnerKey = tryOwner
				object = found
				break
			}
		}
		return responseForR2Object(
			request,
			env,
			object,
			assetId,
			servedOwnerKey,
		)
	}

	if (request.method === 'DELETE') {
		const writeDenied = await assertAssetWrite(request, env, ownerKey)
		if (writeDenied) return writeDenied

		try {
			await env.WHITEBOARD_ASSETS.delete(key)
		} catch {
			logWhiteboardEvent('r2_delete_error', {
				method: request.method,
				status: 503,
			})
			return jsonError(503, 'Asset storage is temporarily unavailable', request)
		}
		return jsonOk(request, { ok: true })
	}

	return jsonError(405, 'Method not allowed', request)
}
