/**
 * Durable Object for one whiteboard room (product family: scsfoxchase-tech_whiteboards).
 *
 * Phase 2: native WebSocket Excalidraw scene sync + persist. Share-code
 * mint/revoke/alarm and People HTTP stay on this same object.
 *
 * One alarm slot: the sooner of share-code expiry (12h) and unsaved TTL (24h).
 * Refresh does not wipe the scene. “Lose work” = never saved to a cloud library.
 */
import { DurableObject } from 'cloudflare:workers'
import { generateGuestDisplayName } from '../lib/whiteboard-display-name'
import {
	FULL_RESYNC_EVERY,
	MAX_SCENE_ELEMENTS,
	MAX_SCENE_JSON_BYTES,
	META_BOARD_ID_KEY,
	META_CLASS_CAN_EDIT_KEY,
	META_CLOUD_OWNER_KEY,
	META_CREATED_AT_KEY,
	META_SAVED_TO_LIBRARY_KEY,
	META_TEMP_ASSET_PREFIX_KEY,
	META_UNSAVED_EXPIRES_AT_KEY,
	UNSAVED_BOARD_TTL_MS,
	asScenePersistError,
	canAssignRole,
	isAssignableRole,
	isWhiteboardRole,
	isGuestConnectUserId,
	mergeSceneElements,
	parseDatabaseScene,
	parseSceneElements,
	parseStoredSceneElements,
	roleCanEdit,
	sceneTooLargeError,
	type AssignableRole,
	type BoardPublicMeta,
	type OwnerHook,
	type SceneAppState,
	type SceneElement,
	type ScenePersistError,
	type WhiteboardRole,
} from '../lib/whiteboard-sync'
import {
	tryClerkWhiteboardAuth,
	verifyClerkWhiteboardToken,
	type ClerkWhiteboardAuth,
} from './clerkAuth'
import {
	isExpiredIso,
	kvCodeKey,
	normalizeShareCode,
	sampleShareCode,
	SHARE_CODE_TTL_MS,
	SHARE_CODE_TTL_SECONDS,
} from './shareCode'

const HOST_SECRET_HASH_KEY = 'meta:hostSecretHash'
const JOIN_CODE_COOKIE_PREFIX = 'scsfoxchase_wbj_'
const FORCE_FOLLOW_KEY = 'meta:forceFollow'
const META_TITLE_KEY = 'meta:title'
const MAX_BOARD_TITLE_LENGTH = 80
const DEFAULT_BOARD_TITLE = 'Untitled board'
// PHASE 3.3
const ROLES_KEY = 'meta:roles'
const ACTIVE_CODE_KEY = 'meta:activeCode'
const CODE_EXPIRES_AT_KEY = 'meta:codeExpiresAt'
const CODE_MINT_LOG_KEY = 'meta:codeMintLog'

const SCENE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS excalidraw_scene (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		scene_json TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`

const SCENE_TABLE_V2_SQL = `
	CREATE TABLE IF NOT EXISTS excalidraw_scene_v2 (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		scene_json TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`

export type WipeStoredDataResult = {
	objectId: string
	tablesBefore: string[]
	tablesAfter: string[]
	hadTldrawTables: boolean
}

function listUserSqlTables(storage: DurableObjectStorage): string[] {
	return storage.sql
		.exec<{ name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE '__cf_%'
			 ORDER BY name`,
		)
		.toArray()
		.map((row) => row.name)
}

function hasTldrawSqlTables(names: string[]): boolean {
	return names.some((name) => name.startsWith('tldraw_'))
}

function listSceneTableColumns(storage: DurableObjectStorage): string[] {
	try {
		return storage.sql
			.exec<{ name: string }>('PRAGMA table_info(excalidraw_scene)')
			.toArray()
			.map((row) => row.name)
	} catch {
		return []
	}
}

function liveOrDatabaseToSceneJson(row: {
	live_json?: string | null
	database_json?: string | null
}): string | null {
	if (typeof row.live_json === 'string' && row.live_json.length > 0) {
		return row.live_json
	}
	if (typeof row.database_json === 'string' && row.database_json.length > 0) {
		const database = parseDatabaseScene(row.database_json)
		if (database) {
			return JSON.stringify({
				elements: database.elements,
				appState: database.appState,
			})
		}
		return row.database_json
	}
	return null
}

/**
 * One JSON column per row. Old boards stored `database_json` + `live_json`
 * together, which can exceed SQLite's per-row limit even when each value
 * is under MAX_SCENE_JSON_BYTES.
 */
function migrateExcalidrawSceneTable(storage: DurableObjectStorage): void {
	const tables = new Set(listUserSqlTables(storage))
	if (tables.has('excalidraw_scene_v2') && !tables.has('excalidraw_scene')) {
		storage.sql.exec(
			'ALTER TABLE excalidraw_scene_v2 RENAME TO excalidraw_scene',
		)
		return
	}

	storage.sql.exec(SCENE_TABLE_SQL)
	const columns = new Set(listSceneTableColumns(storage))
	if (
		columns.has('scene_json') &&
		!columns.has('live_json') &&
		!columns.has('database_json')
	) {
		if (tables.has('excalidraw_scene_v2')) {
			storage.sql.exec('DROP TABLE IF EXISTS excalidraw_scene_v2')
		}
		return
	}
	if (!columns.has('live_json') && !columns.has('database_json')) return

	const row = storage.sql
		.exec<{
			live_json: string | null
			database_json: string | null
			updated_at: number | null
		}>('SELECT live_json, database_json, updated_at FROM excalidraw_scene WHERE id = 1')
		.toArray()[0]
	const sceneJson = row ? liveOrDatabaseToSceneJson(row) : null

	storage.sql.exec(SCENE_TABLE_V2_SQL)
	storage.sql.exec('DELETE FROM excalidraw_scene_v2')
	try {
		if (sceneJson) {
			storage.sql.exec(
				`INSERT INTO excalidraw_scene_v2 (id, scene_json, updated_at)
				 VALUES (1, ?, ?)`,
				sceneJson,
				row?.updated_at ?? Date.now(),
			)
		}
	} catch {
		storage.sql.exec('DROP TABLE IF EXISTS excalidraw_scene_v2')
		return
	}
	storage.sql.exec('DROP TABLE excalidraw_scene')
	storage.sql.exec(
		'ALTER TABLE excalidraw_scene_v2 RENAME TO excalidraw_scene',
	)
}

/** Max mint/rotate attempts per board in a rolling window. */
const MINT_RATE_LIMIT = 12
const MINT_RATE_WINDOW_MS = 10 * 60 * 1000
const MINT_SAMPLE_ATTEMPTS = 24

type SessionMeta = {
	displayName: string
	userId: string
	isHost: boolean
}

interface SocketAttachment {
	sessionId: string
	isHost: boolean
	canEdit: boolean
	// PHASE 3.3
	role: WhiteboardRole
	authToken: string
	meta: SessionMeta
	/** Waiting for first-message Clerk / host proof (`wb:auth`). */
	pendingClerkAuth?: boolean
	connectOrigin?: string
	/** Cookie Clerk from the upgrade request; first-message token wins. */
	connectClerkAuth?: ClerkWhiteboardAuth
	/** Voluntary Follow target; survives hibernation with the socket. */
	followTargetSessionId?: string
	/** Presented the active share code on connect (cookie). Not a stored role. */
	joinedViaShareCode?: boolean
}

// PHASE 3.3
type StoredRoles = Record<string, AssignableRole>
type StoredForceFollow = {
	enabled: boolean
	targetUserId: string
	subjects: Record<string, string>
}

type CodeState = {
	code: string
	expiresAt: string
}

type ParticipantPublic = {
	sessionId: string
	userId: string
	displayName: string
	role: WhiteboardRole
	canEdit: boolean
	isHost: boolean
}

type LiveScene = {
	elements: SceneElement[]
	appState: SceneAppState
}

async function sha256Hex(value: string): Promise<string> {
	const data = new TextEncoder().encode(value)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('')
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function sanitizeBoardTitle(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, MAX_BOARD_TITLE_LENGTH)
	return cleaned || null
}

function sanitizeDisplayName(raw: string | null): string {
	if (!raw) return ''
	return raw.trim().slice(0, 48)
}

function sanitizeUserId(raw: string | null): string {
	if (!raw) return ''
	const value = raw.trim().slice(0, 128)
	if (!value || /^google:/i.test(value) || !isGuestConnectUserId(value)) {
		return ''
	}
	return value
}

function looksLikeJwt(raw: string | null): boolean {
	if (!raw) return false
	const parts = raw.trim().split('.')
	return parts.length === 3 && raw.trim().length > 40
}

function sanitizeOwnerKey(raw: string | null | undefined): string | null {
	if (!raw) return null
	const value = raw.trim().slice(0, 160)
	if (!/^(local|google):[A-Za-z0-9_.:@-]{1,128}$/.test(value)) return null
	return value
}

function sanitizeAssetPrefix(raw: string | null | undefined): string | null {
	if (!raw) return null
	const value = raw.trim().slice(0, 200)
	if (!value.startsWith('assets/')) return null
	if (value.includes('..')) return null
	return value
}

function isClerkWhiteboardAuth(value: unknown): value is ClerkWhiteboardAuth {
	if (!value || typeof value !== 'object') return false
	const row = value as Partial<ClerkWhiteboardAuth>
	return (
		typeof row.accountId === 'string' &&
		typeof row.ownerKey === 'string' &&
		typeof row.clerkUserId === 'string'
	)
}

/** Normalize attachments from older deploys that lacked canEdit/meta/role. */
function normalizeAttachment(
	raw: Partial<SocketAttachment> | null | undefined,
	sessionId: string,
): SocketAttachment {
	const isHost = Boolean(raw?.isHost)
	const meta = raw?.meta ?? {
		displayName: '',
		userId: '',
		isHost,
	}
	const role: WhiteboardRole = isWhiteboardRole(raw?.role)
		? raw.role
		: isHost
			? 'owner'
			: raw?.canEdit === false
				? 'viewer'
				: 'editor'
	return {
		sessionId: raw?.sessionId ?? sessionId,
		isHost,
		canEdit: roleCanEdit(role),
		role,
		authToken: typeof raw?.authToken === 'string' ? raw.authToken : '',
		meta: {
			displayName: meta.displayName ?? '',
			userId: meta.userId ?? '',
			isHost: Boolean(meta.isHost || isHost),
		},
		pendingClerkAuth: Boolean(raw?.pendingClerkAuth),
		connectOrigin:
			typeof raw?.connectOrigin === 'string' ? raw.connectOrigin : '',
		connectClerkAuth: isClerkWhiteboardAuth(raw?.connectClerkAuth)
			? raw.connectClerkAuth
			: undefined,
		followTargetSessionId:
			typeof raw?.followTargetSessionId === 'string' &&
			raw.followTargetSessionId
				? raw.followTargetSessionId
				: undefined,
		joinedViaShareCode: Boolean(raw?.joinedViaShareCode),
	}
}

function readCookieValue(header: string | null, name: string): string {
	if (!header || !name) return ''
	for (const part of header.split(';')) {
		const idx = part.indexOf('=')
		if (idx < 0) continue
		if (part.slice(0, idx).trim() !== name) continue
		try {
			return decodeURIComponent(part.slice(idx + 1).trim())
		} catch {
			return part.slice(idx + 1).trim()
		}
	}
	return ''
}

function joinCodeFromConnectRequest(request: Request, boardId: string): string {
	return (
		normalizeShareCode(
			readCookieValue(
				request.headers.get('Cookie'),
				`${JOIN_CODE_COOKIE_PREFIX}${boardId}`,
			),
		) ?? ''
	)
}

function sendJson(ws: WebSocket, payload: unknown): void {
	try {
		ws.send(JSON.stringify(payload))
	} catch {
		// Socket may already be closing.
	}
}

export class WhiteboardBoard extends DurableObject<Env> {
	/** Map sessionId → ws so HTTP handlers can reach a live socket. */
	private readonly sessionIdToWs = new Map<string, WebSocket>()
	/** Cached force-follow flag (null until first storage read). */
	private forceFollowCache: StoredForceFollow | null = null
	/** followerSessionId → targetSessionId; restored from socket attachments after hibernation. */
	private readonly voluntaryFollow = new Map<string, string>()
	private socketsHydrated = false
	/** After a wake, rebroadcast Follow Me to sockets that never disconnected. */
	private forceFollowNeedsRebroadcast = false
	private sceneCache: LiveScene | null = null
	private sceneLoaded = false
	private updatesSinceFullSync = 0

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// Respond to ping messages at the platform level without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
		)
		this.ctx.blockConcurrencyWhile(async () => {
			const tables = listUserSqlTables(this.ctx.storage)
			if (hasTldrawSqlTables(tables)) {
				await this.clearAllStorage()
			}
			migrateExcalidrawSceneTable(this.ctx.storage)
		})
	}

	private resetLiveState(): void {
		this.forceFollowCache = null
		this.voluntaryFollow.clear()
		this.forceFollowNeedsRebroadcast = false
		this.sceneCache = { elements: [], appState: {} }
		this.sceneLoaded = true
		this.updatesSinceFullSync = 0
	}

	private async clearAllStorage(): Promise<void> {
		try {
			await this.ctx.storage.deleteAlarm()
		} catch {
			// no alarm set
		}
		await this.ctx.storage.deleteAll()
		this.resetLiveState()
	}

	/**
	 * Authenticated admin RPC: drop tldraw (and any other) SQLite/KV data, then
	 * re-create an empty Excalidraw scene table. Does not wipe new boards on its
	 * own — the Worker only calls this for listed object IDs.
	 */
	async wipeStoredData(): Promise<WipeStoredDataResult> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const tablesBefore = listUserSqlTables(this.ctx.storage)
			for (const ws of this.ctx.getWebSockets()) {
				try {
					ws.close(4000, 'storage wiped')
				} catch {
					// already closing
				}
			}
			this.sessionIdToWs.clear()
			await this.clearAllStorage()
			this.ctx.storage.sql.exec(SCENE_TABLE_SQL)
			return {
				objectId: this.ctx.id.toString(),
				tablesBefore,
				tablesAfter: listUserSqlTables(this.ctx.storage),
				hadTldrawTables: hasTldrawSqlTables(tablesBefore),
			}
		})
	}

	/**
	 * Asset PUT/DELETE gate used by assetRoutes. Accepts the creating host
	 * secret or a live can-edit WebSocket session. Does not mint a host hash.
	 */
	async assertAssetWriteAccess(opts: {
		hostSecret?: string | null
		sessionId?: string | null
		authToken?: string | null
	}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
		this.hydrateSockets()
		const hostSecret =
			typeof opts.hostSecret === 'string' ? opts.hostSecret.trim() : ''
		if (hostSecret && (await this.assertHost(hostSecret))) {
			return { ok: true }
		}
		const sessionId =
			typeof opts.sessionId === 'string' ? opts.sessionId.trim() : ''
		const authToken =
			typeof opts.authToken === 'string' ? opts.authToken.trim() : ''
		if (sessionId && authToken) {
			const ws = this.sessionIdToWs.get(sessionId)
			if (ws) {
				const attachment = normalizeAttachment(
					ws.deserializeAttachment() as Partial<SocketAttachment> | null,
					sessionId,
				)
				if (
					attachment.authToken &&
					attachment.authToken === authToken &&
					(attachment.canEdit || roleCanEdit(attachment.role))
				) {
					return { ok: true }
				}
			}
		}
		const presented = Boolean(hostSecret || (sessionId && authToken))
		return {
			ok: false,
			status: presented ? 403 : 401,
			error: presented
				? "Not allowed to write this board's assets"
				: 'Host secret or editor session required',
		}
	}

	/** Rebuild the session map after hibernation. */
	private hydrateSockets(): void {
		if (this.socketsHydrated) return
		this.socketsHydrated = true
		this.voluntaryFollow.clear()
		for (const ws of this.ctx.getWebSockets()) {
			const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
			if (!raw?.sessionId) continue
			const attachment = normalizeAttachment(raw, raw.sessionId)
			ws.serializeAttachment(attachment)
			this.sessionIdToWs.set(attachment.sessionId, ws)
		}
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const attachment = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			const target = attachment.followTargetSessionId
			if (target && this.sessionIdToWs.has(target)) {
				this.voluntaryFollow.set(sessionId, target)
			} else if (target) {
				this.persistVoluntaryFollow(sessionId, null)
			}
		}
		this.forceFollowNeedsRebroadcast = this.sessionIdToWs.size > 0
	}

	/**
	 * After hibernation, already-open tabs never got a new `wb:hello`.
	 * Reload Follow Me from storage and send `wb:forceFollow` to them.
	 */
	private async restoreFollowAfterWake(): Promise<void> {
		if (!this.forceFollowNeedsRebroadcast) return
		this.forceFollowNeedsRebroadcast = false
		await this.broadcastForceFollow()
		await this.refreshFollowedFlags()
	}

	/**
	 * Store host secret hash on first connect that supplies a secret;
	 * verify on later connects. Creating browser is ephemeral Owner.
	 */
	private async resolveHost(hostSecret: string | null): Promise<boolean> {
		if (!hostSecret || looksLikeJwt(hostSecret)) return false
		const hash = await sha256Hex(hostSecret)
		const existing = await this.ctx.storage.get<string>(HOST_SECRET_HASH_KEY)
		if (!existing) {
			await this.ctx.storage.put(HOST_SECRET_HASH_KEY, hash)
			return true
		}
		return existing === hash
	}

	private async assertHost(hostSecret: string | null): Promise<boolean> {
		if (!hostSecret || looksLikeJwt(hostSecret)) return false
		const hash = await sha256Hex(hostSecret)
		const existing = await this.ctx.storage.get<string>(HOST_SECRET_HASH_KEY)
		return Boolean(existing && existing === hash)
	}

	private async hasGoogleCloudOwner(): Promise<boolean> {
		const key =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		return Boolean(key && key.startsWith('google:'))
	}

	/**
	 * Scratch Owner proof only. After a Google claim, leftover host secrets
	 * must not count as Owner (shared Chromebook). `mint` is first-connect
	 * only — HTTP handlers must not mint a hash.
	 */
	private async hostProvesScratchOwner(
		hostSecret: string | null,
		opts: { mint: boolean },
	): Promise<boolean> {
		const ok = opts.mint
			? await this.resolveHost(hostSecret)
			: await this.assertHost(hostSecret)
		if (!ok) return false
		if (await this.hasGoogleCloudOwner()) return false
		return true
	}

	/** Header only — never the WebSocket query string (access logs). */
	private connectHostSecretFromHeader(request: Request): string | null {
		const header = request.headers.get('X-Board-Host')?.trim()
		if (!header || looksLikeJwt(header)) return null
		return header
	}

	async fetch(request: Request): Promise<Response> {
		this.hydrateSockets()
		await this.restoreFollowAfterWake()
		const url = new URL(request.url)
		const connectMatch = url.pathname.match(
			/^\/api\/whiteboard\/connect\/([^/]+)\/?$/i,
		)
		if (connectMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
			return this.handleConnect(
				request,
				url,
				decodeURIComponent(connectMatch[1]!),
			)
		}

		const codeMatch = url.pathname.match(
			/^\/api\/whiteboard\/boards\/([^/]+)\/code\/?$/i,
		)
		if (codeMatch) {
			const boardId =
				url.searchParams.get('boardId') || decodeURIComponent(codeMatch[1]!)
			return this.handleCodeHttp(request, url, boardId)
		}

		const metaMatch = url.pathname.match(
			/^\/api\/whiteboard\/boards\/([^/]+)\/meta\/?$/i,
		)
		if (metaMatch) {
			const boardId =
				url.searchParams.get('boardId') || decodeURIComponent(metaMatch[1]!)
			return this.handleMetaHttp(request, url, boardId)
		}

		const participantMatch = url.pathname.match(
			/^\/api\/whiteboard\/boards\/([^/]+)\/participants\/([^/]+)\/?$/i,
		)
		if (participantMatch) {
			const sessionId =
				url.searchParams.get('sessionId') ||
				decodeURIComponent(participantMatch[2]!)
			return this.handleParticipantPatch(request, url, sessionId)
		}

		const forceFollowMatch = url.pathname.match(
			/^\/api\/whiteboard\/boards\/([^/]+)\/force-follow\/?$/i,
		)
		if (forceFollowMatch) {
			return this.handleForceFollowPatch(request, url)
		}

		return new Response('Not found', { status: 404 })
	}

	private async handleConnect(
		request: Request,
		url: URL,
		boardId: string,
	): Promise<Response> {
		const sessionId = url.searchParams.get('sessionId')
		if (!sessionId) {
			return new Response('Missing sessionId', { status: 400 })
		}

		const headerHost = this.connectHostSecretFromHeader(request)
		const isHost = await this.hostProvesScratchOwner(headerHost, { mint: true })
		const guestUserId = sanitizeUserId(url.searchParams.get('userId'))
		let displayName = sanitizeDisplayName(url.searchParams.get('displayName'))
		if (!displayName) {
			displayName = generateGuestDisplayName(guestUserId || sessionId)
		}

		const clerkAuth = await tryClerkWhiteboardAuth(request, this.env)
		// Always wait for first-message `wb:auth` so scratch host proof can
		// arrive off the query string (browsers cannot set WS headers).
		const pendingClerkAuth = true
		const userId = clerkAuth ? clerkAuth.accountId : guestUserId
		if (clerkAuth) {
			displayName = sanitizeDisplayName(clerkAuth.displayName) || displayName
		}
		const joinedViaShareCode = await this.presentedJoinCodeIsActive(
			joinCodeFromConnectRequest(request, boardId),
		)
		const role = await this.resolveConnectRole({
			clerkAuth,
			guestUserId,
			isHost,
			joinedViaShareCode,
		})
		const canEdit = roleCanEdit(role)
		const authToken = crypto.randomUUID()
		const meta: SessionMeta = {
			displayName,
			userId,
			isHost,
		}

		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		this.ctx.acceptWebSocket(serverWebSocket)

		const previous = this.sessionIdToWs.get(sessionId)
		if (previous && previous !== serverWebSocket) {
			try {
				previous.close(4000, 'replaced')
			} catch {
				// already closed
			}
			this.sessionIdToWs.delete(sessionId)
		}

		const attachment: SocketAttachment = {
			sessionId,
			isHost,
			canEdit,
			role,
			authToken,
			meta,
			pendingClerkAuth,
			connectOrigin: request.headers.get('Origin') ?? '',
			connectClerkAuth: clerkAuth ?? undefined,
			joinedViaShareCode,
		}
		serverWebSocket.serializeAttachment(attachment)
		this.sessionIdToWs.set(sessionId, serverWebSocket)

		await this.ensureBoardLifetime(boardId)
		await this.sendFullScene(serverWebSocket)

		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}

	private async sendConnectHello(
		ws: WebSocket,
		attachment: SocketAttachment,
	): Promise<void> {
		const revealOwnerKey = roleCanEdit(attachment.role)
		const owner = await this.readOwnerHook(attachment.isHost, revealOwnerKey)
		const savedToLibrary = await this.isSavedToLibrary()
		sendJson(ws, {
			type: 'wb:hello',
			sessionId: attachment.sessionId,
			isHost: attachment.isHost,
			canEdit: attachment.canEdit,
			savedToLibrary,
			owner,
			title: await this.readBoardTitle(),
			classCanEdit: await this.readClassCanEdit(),
			role: attachment.role,
			authToken: attachment.authToken,
		})
	}

	private async finishPendingConnectAuth(
		ws: WebSocket,
		attachment: SocketAttachment,
		data: Record<string, unknown>,
	): Promise<SocketAttachment> {
		let clerkAuth: ClerkWhiteboardAuth | null =
			attachment.connectClerkAuth ?? null
		if (data.type === 'wb:auth' && typeof data.token === 'string') {
			const fromToken = await verifyClerkWhiteboardToken(
				data.token,
				this.env,
				attachment.connectOrigin,
			)
			if (fromToken) clerkAuth = fromToken
		}

		const hostSecret =
			data.type === 'wb:auth' && typeof data.hostSecret === 'string'
				? data.hostSecret
				: ''
		const isHost =
			attachment.isHost ||
			(await this.hostProvesScratchOwner(hostSecret, { mint: true }))

		const guestUserId = sanitizeUserId(attachment.meta.userId)
		const userId = clerkAuth ? clerkAuth.accountId : guestUserId
		let displayName = attachment.meta.displayName
		if (clerkAuth) {
			displayName =
				sanitizeDisplayName(clerkAuth.displayName) || displayName
		}
		const joinedViaShareCode = Boolean(attachment.joinedViaShareCode)
		const role = await this.resolveConnectRole({
			clerkAuth,
			guestUserId,
			isHost,
			joinedViaShareCode,
		})
		const next: SocketAttachment = {
			...attachment,
			isHost,
			role,
			canEdit: roleCanEdit(role),
			pendingClerkAuth: false,
			connectClerkAuth: undefined,
			joinedViaShareCode,
			meta: {
				...attachment.meta,
				userId,
				displayName,
				isHost,
			},
		}
		ws.serializeAttachment(next)
		await this.sendConnectHello(ws, next)
		this.broadcastParticipants()
		void this.broadcastForceFollow()
		void this.refreshFollowedFlags()
		return next
	}

	private async handleMetaHttp(
		request: Request,
		url: URL,
		boardId: string,
	): Promise<Response> {
		if (request.method === 'GET') {
			await this.ensureBoardLifetime(boardId)
			const reveal = await this.canRevealCloudOwnerKey(request, url)
			return json(200, await this.readPublicMeta(reveal))
		}

		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' })
		}

		let body: {
			title?: unknown
			sessionId?: unknown
			authToken?: unknown
			savedToLibrary?: unknown
			cloudOwnerKey?: unknown
			tempAssetPrefix?: unknown
			classCanEdit?: unknown
		}
		try {
			body = (await request.json()) as typeof body
		} catch {
			return json(400, { error: 'Invalid JSON body' })
		}

		const hasTitle = 'title' in body
		const hasClassCanEdit = typeof body.classCanEdit === 'boolean'
		const hasLifetimeFields =
			typeof body.savedToLibrary === 'boolean' ||
			'cloudOwnerKey' in body ||
			'tempAssetPrefix' in body

		if (hasTitle || hasClassCanEdit) {
			const actor = await this.resolveActorFromMeta(url, request, body)
			if (!actor || (actor.role !== 'owner' && actor.role !== 'manager')) {
				return json(403, {
					error: hasTitle
						? 'Only the Owner or a Manager can rename this board.'
						: 'Only the Owner or a Manager can change class can edit.',
				})
			}
			if (hasTitle) {
				const nextTitle = sanitizeBoardTitle(body.title)
				if (!nextTitle) {
					return json(400, { error: 'Enter a board name' })
				}
				await this.ctx.storage.put(META_TITLE_KEY, nextTitle)
				this.broadcastTitle(nextTitle)
			}
			if (hasClassCanEdit) {
				await this.setClassCanEdit(body.classCanEdit === true)
				await this.syncLiveRolesForClassCanEdit()
			}
		}

		if (!hasLifetimeFields) {
			if (hasTitle || hasClassCanEdit) {
				await this.ensureBoardLifetime(boardId)
				return json(200, await this.readPublicMeta(true))
			}
			return json(400, { error: 'No meta fields to update' })
		}

		const hostSecret = url.searchParams.get('hostSecret')
		if (!(await this.assertHost(hostSecret))) {
			return json(403, { error: 'Host secret required' })
		}

		const existingOwner =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		const existingGoogle = Boolean(
			existingOwner && existingOwner.startsWith('google:'),
		)

		let nextOwner: string | null | undefined
		if ('cloudOwnerKey' in body) {
			if (body.cloudOwnerKey === null) {
				nextOwner = null
			} else if (typeof body.cloudOwnerKey === 'string') {
				const key = sanitizeOwnerKey(body.cloudOwnerKey)
				if (!key) return json(400, { error: 'Invalid cloudOwnerKey' })
				nextOwner = key
			}
		}

		const ownerChanging =
			nextOwner !== undefined && nextOwner !== existingOwner
		if (ownerChanging && existingGoogle) {
			const clerkAuth = await this.tryClerkFromMetaRequest(request, url)
			if (!clerkAuth || clerkAuth.ownerKey !== existingOwner) {
				return json(403, {
					error: 'Host secret cannot change the Google owner of a saved board',
				})
			}
		}

		if (
			typeof body.savedToLibrary === 'boolean' &&
			body.savedToLibrary === false &&
			existingGoogle
		) {
			const clerkAuth = await this.tryClerkFromMetaRequest(request, url)
			if (!clerkAuth || clerkAuth.ownerKey !== existingOwner) {
				return json(403, {
					error: 'Host secret cannot unsaved a Google-owned board',
				})
			}
		}

		if (typeof body.savedToLibrary === 'boolean') {
			await this.ctx.storage.put(META_SAVED_TO_LIBRARY_KEY, body.savedToLibrary)
			if (body.savedToLibrary) {
				await this.ctx.storage.delete(META_UNSAVED_EXPIRES_AT_KEY)
			} else {
				const createdAt =
					(await this.ctx.storage.get<string>(META_CREATED_AT_KEY)) ??
					new Date().toISOString()
				const expiresAt = new Date(
					Date.parse(createdAt) + UNSAVED_BOARD_TTL_MS,
				).toISOString()
				await this.ctx.storage.put(META_UNSAVED_EXPIRES_AT_KEY, expiresAt)
			}
		}

		if (ownerChanging) {
			if (nextOwner === null) {
				await this.ctx.storage.delete(META_CLOUD_OWNER_KEY)
			} else if (typeof nextOwner === 'string') {
				await this.ctx.storage.put(META_CLOUD_OWNER_KEY, nextOwner)
			}
		}

		if ('tempAssetPrefix' in body) {
			if (body.tempAssetPrefix === null) {
				await this.ctx.storage.delete(META_TEMP_ASSET_PREFIX_KEY)
			} else if (typeof body.tempAssetPrefix === 'string') {
				const prefix = sanitizeAssetPrefix(body.tempAssetPrefix)
				if (!prefix) return json(400, { error: 'Invalid tempAssetPrefix' })
				await this.ctx.storage.put(META_TEMP_ASSET_PREFIX_KEY, prefix)
			}
		}

		await this.scheduleNextAlarm()
		return json(200, await this.readPublicMeta(true))
	}

	/**
	 * `google:` prefix for canvas PUT. Unsigned GET and Viewer sessions stay
	 * hidden. Live Owner/Manager/Editor (session token) or Clerk Owner /
	 * stored Manager/Editor may see it. Scratch host proof still reveals.
	 */
	private async canRevealCloudOwnerKey(
		request: Request,
		url: URL,
	): Promise<boolean> {
		const hostSecret = url.searchParams.get('hostSecret')
		if (await this.assertHost(hostSecret)) {
			return true
		}
		const actor = await this.resolveActorFromMeta(url, request, {})
		if (actor && roleCanEdit(actor.role)) {
			return true
		}
		const clerkAuth = await this.tryClerkFromMetaRequest(request, url)
		if (!clerkAuth) return false
		return this.clerkMayRevealCloudOwnerKey(clerkAuth)
	}

	private async clerkMayRevealCloudOwnerKey(
		clerkAuth: ClerkWhiteboardAuth,
	): Promise<boolean> {
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		if (cloudOwnerKey && cloudOwnerKey === clerkAuth.ownerKey) {
			return true
		}
		const stored = await this.readStoredRoles()
		const storedRole =
			stored[clerkAuth.accountId] ??
			stored[clerkAuth.ownerKey] ??
			stored[clerkAuth.clerkUserId]
		return storedRole === 'manager' || storedRole === 'editor'
	}

	/**
	 * Worker meta forwarding copies Authorization Bearer into `hostSecret`.
	 * Treat JWT-shaped values as Clerk proof, not as a host secret.
	 */
	private async tryClerkFromMetaRequest(
		request: Request,
		url: URL,
	): Promise<ClerkWhiteboardAuth | null> {
		const fromRequest = await tryClerkWhiteboardAuth(request, this.env)
		if (fromRequest) return fromRequest
		const forwarded = url.searchParams.get('hostSecret')
		if (!forwarded || !looksLikeJwt(forwarded)) return null
		return verifyClerkWhiteboardToken(
			forwarded,
			this.env,
			request.headers.get('Origin'),
		)
	}

	private async readPublicMeta(revealCloudOwnerKey: boolean): Promise<BoardPublicMeta> {
		const savedToLibrary = await this.isSavedToLibrary()
		const storedKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		const cloudOwnerKey = revealCloudOwnerKey ? storedKey : null
		return {
			savedToLibrary,
			cloudOwnerKey,
			createdAt: (await this.ctx.storage.get<string>(META_CREATED_AT_KEY)) ?? null,
			unsavedExpiresAt:
				(await this.ctx.storage.get<string>(META_UNSAVED_EXPIRES_AT_KEY)) ??
				null,
			title: await this.readBoardTitle(),
			owner: await this.readOwnerHook(false, revealCloudOwnerKey),
			classCanEdit: await this.readClassCanEdit(),
		}
	}

	private async readBoardTitle(): Promise<string> {
		return sanitizeBoardTitle(await this.ctx.storage.get<string>(META_TITLE_KEY))
			?? DEFAULT_BOARD_TITLE
	}

	private broadcastTitle(title: string): void {
		for (const ws of this.sessionIdToWs.values()) {
			sendJson(ws, { type: 'wb:title', title })
		}
	}

	/**
	 * Title PATCH: live session token (Owner/Manager) or scratch host proof.
	 * Session may arrive on the stub query, JSON body, or request headers.
	 */
	private async resolveActorFromMeta(
		url: URL,
		request: Request,
		body: { sessionId?: unknown; authToken?: unknown },
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		const actorUrl = new URL(url.toString())
		const sessionId =
			actorUrl.searchParams.get('actorSessionId') ||
			request.headers.get('X-Board-Session')?.trim() ||
			(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
		const authToken =
			actorUrl.searchParams.get('actorAuth') ||
			request.headers.get('X-Board-Auth')?.trim() ||
			(typeof body.authToken === 'string' ? body.authToken.trim() : '')
		if (sessionId) actorUrl.searchParams.set('actorSessionId', sessionId)
		if (authToken) actorUrl.searchParams.set('actorAuth', authToken)
		return this.resolveActor(actorUrl)
	}

	private async readOwnerHook(
		isHost: boolean,
		revealCloudOwnerKey = isHost,
	): Promise<OwnerHook> {
		const storedKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		const saved = await this.isSavedToLibrary()
		const google =
			saved && typeof storedKey === 'string' && storedKey.startsWith('google:')
		return {
			kind: google ? 'google' : 'ephemeral',
			cloudOwnerKey: revealCloudOwnerKey ? storedKey : null,
			isHost,
		}
	}

	private async isSavedToLibrary(): Promise<boolean> {
		return Boolean(await this.ctx.storage.get<boolean>(META_SAVED_TO_LIBRARY_KEY))
	}

	/**
	 * First connect starts the 24h unsaved clock. Later connects / Chromebook
	 * refreshes must not reset it or delete the scene.
	 */
	private async ensureBoardLifetime(boardId: string): Promise<void> {
		const existingId = await this.ctx.storage.get<string>(META_BOARD_ID_KEY)
		if (!existingId) {
			await this.ctx.storage.put(META_BOARD_ID_KEY, boardId)
		}

		const createdAt = await this.ctx.storage.get<string>(META_CREATED_AT_KEY)
		if (!createdAt) {
			const now = new Date()
			await this.ctx.storage.put(META_CREATED_AT_KEY, now.toISOString())
			if (!(await this.isSavedToLibrary())) {
				await this.ctx.storage.put(
					META_UNSAVED_EXPIRES_AT_KEY,
					new Date(now.getTime() + UNSAVED_BOARD_TTL_MS).toISOString(),
				)
			}
		}

		await this.scheduleNextAlarm()
	}

	private parseLiveSceneJson(raw: string): LiveScene | null {
		try {
			const live = JSON.parse(raw) as unknown
			if (Array.isArray(live)) {
				return { elements: parseStoredSceneElements(live), appState: {} }
			}
			if (live && typeof live === 'object') {
				const rec = live as Record<string, unknown>
				if (rec.type === 'excalidraw') {
					const database = parseDatabaseScene(raw)
					return database
						? { elements: database.elements, appState: database.appState }
						: {
								elements: parseStoredSceneElements(rec.elements),
								appState:
									rec.appState && typeof rec.appState === 'object'
										? (rec.appState as SceneAppState)
										: {},
							}
				}
				return {
					elements: parseStoredSceneElements(rec.elements),
					appState:
						rec.appState && typeof rec.appState === 'object'
							? (rec.appState as SceneAppState)
							: {},
				}
			}
		} catch {
			return null
		}
		return null
	}

	private async loadScene(): Promise<LiveScene> {
		if (this.sceneLoaded && this.sceneCache) return this.sceneCache
		this.sceneLoaded = true
		const columns = new Set(listSceneTableColumns(this.ctx.storage))
		if (columns.has('scene_json')) {
			const row = this.ctx.storage.sql
				.exec<{ scene_json: string }>(
					'SELECT scene_json FROM excalidraw_scene WHERE id = 1',
				)
				.toArray()[0]
			this.sceneCache = row
				? this.parseLiveSceneJson(row.scene_json) ?? {
						elements: [],
						appState: {},
					}
				: { elements: [], appState: {} }
			return this.sceneCache
		}

		const row = columns.has('live_json')
			? this.ctx.storage.sql
					.exec<{ live_json: string; database_json: string }>(
						'SELECT live_json, database_json FROM excalidraw_scene WHERE id = 1',
					)
					.toArray()[0]
			: undefined
		if (!row) {
			this.sceneCache = { elements: [], appState: {} }
			return this.sceneCache
		}
		this.sceneCache =
			this.parseLiveSceneJson(row.live_json) ??
			this.parseLiveSceneJson(row.database_json) ?? {
				elements: [],
				appState: {},
			}
		if (
			(!this.sceneCache.appState ||
				Object.keys(this.sceneCache.appState).length === 0) &&
			row.database_json
		) {
			const database = parseDatabaseScene(row.database_json)
			if (database) this.sceneCache.appState = database.appState
		}
		return this.sceneCache
	}

	private persistScene(scene: LiveScene): void {
		if (scene.elements.length > MAX_SCENE_ELEMENTS) {
			throw sceneTooLargeError()
		}
		const liveJson = JSON.stringify({
			elements: scene.elements,
			appState: scene.appState,
		})
		if (liveJson.length > MAX_SCENE_JSON_BYTES) {
			throw sceneTooLargeError()
		}
		try {
			this.ctx.storage.sql.exec(
				`INSERT INTO excalidraw_scene (id, scene_json, updated_at)
				 VALUES (1, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   scene_json = excluded.scene_json,
				   updated_at = excluded.updated_at`,
				liveJson,
				Date.now(),
			)
		} catch (err) {
			throw asScenePersistError(err)
		}
		this.sceneCache = scene
		this.sceneLoaded = true
	}

	private async sendFullScene(ws: WebSocket): Promise<void> {
		const scene = await this.loadScene()
		sendJson(ws, {
			type: 'scene:sync',
			elements: scene.elements,
			appState: scene.appState,
		})
	}

	private broadcastScene(
		payload: unknown,
		exceptSessionId: string | null,
	): void {
		for (const [sessionId, ws] of this.sessionIdToWs) {
			if (exceptSessionId && sessionId === exceptSessionId) continue
			sendJson(ws, payload)
		}
	}

	private notifyScenePersistError(
		fromSessionId: string,
		error: ScenePersistError,
	): void {
		const payload = {
			type: 'wb:error' as const,
			code: error.code,
			message: error.message,
		}
		const origin = this.sessionIdToWs.get(fromSessionId)
		if (origin) sendJson(origin, payload)
		for (const [sessionId, ws] of this.sessionIdToWs) {
			if (sessionId === fromSessionId) continue
			const attachment = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			if (roleCanEdit(attachment.role)) sendJson(ws, payload)
		}
	}

	private async applySceneUpdate(
		fromSessionId: string,
		incoming: SceneElement[],
		databaseJson: string | undefined,
		full: boolean,
	): Promise<void> {
		if (incoming.length === 0 && !full && !databaseJson) return
		const scene = await this.loadScene()
		const { next, accepted } = mergeSceneElements(scene.elements, incoming)
		if (accepted.length === 0 && !databaseJson) return

		let appState = scene.appState
		if (databaseJson) {
			const parsed = parseDatabaseScene(databaseJson)
			if (parsed) appState = parsed.appState
		}
		const nextScene: LiveScene = { elements: next, appState }
		this.persistScene(nextScene)

		this.updatesSinceFullSync += 1
		if (full || this.updatesSinceFullSync >= FULL_RESYNC_EVERY) {
			this.updatesSinceFullSync = 0
			this.broadcastScene(
				{
					type: 'scene:sync',
					elements: nextScene.elements,
					appState: nextScene.appState,
				},
				null,
			)
			return
		}

		this.broadcastScene(
			{ type: 'scene:update', elements: accepted, full: false },
			fromSessionId,
		)
	}

	// PHASE 3.3 — roles + follow (do not replace the Phase 2 scene store above)
	private async resolveConnectRole(opts: {
		clerkAuth: ClerkWhiteboardAuth | null
		guestUserId: string
		isHost: boolean
		joinedViaShareCode: boolean
	}): Promise<WhiteboardRole> {
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null

		if (opts.clerkAuth) {
			if (cloudOwnerKey && cloudOwnerKey === opts.clerkAuth.ownerKey) {
				return 'owner'
			}
			const stored = await this.readStoredRoles()
			const storedRole =
				stored[opts.clerkAuth.accountId] ??
				stored[opts.clerkAuth.ownerKey] ??
				stored[opts.clerkAuth.clerkUserId]
			if (
				storedRole === 'manager' ||
				storedRole === 'editor' ||
				storedRole === 'viewer'
			) {
				return storedRole
			}
			if (!cloudOwnerKey && opts.isHost) return 'owner'
			return this.roleForShareCodeJoiner(opts.joinedViaShareCode)
		}

		if (!cloudOwnerKey && opts.isHost) return 'owner'

		const guestUserId = opts.guestUserId
		if (guestUserId && isGuestConnectUserId(guestUserId)) {
			const stored = await this.readStoredRoles()
			const role = stored[guestUserId]
			if (role === 'manager' || role === 'editor' || role === 'viewer') {
				return role
			}
		}
		return this.roleForShareCodeJoiner(opts.joinedViaShareCode)
	}

	private async roleForShareCodeJoiner(
		joinedViaShareCode: boolean,
	): Promise<WhiteboardRole> {
		if (joinedViaShareCode && (await this.readClassCanEdit())) {
			return 'editor'
		}
		return 'viewer'
	}

	private async readClassCanEdit(): Promise<boolean> {
		return (await this.ctx.storage.get<boolean>(META_CLASS_CAN_EDIT_KEY)) === true
	}

	private async setClassCanEdit(enabled: boolean): Promise<void> {
		if (enabled) {
			await this.ctx.storage.put(META_CLASS_CAN_EDIT_KEY, true)
			return
		}
		await this.ctx.storage.delete(META_CLASS_CAN_EDIT_KEY)
	}

	private async presentedJoinCodeIsActive(code: string): Promise<boolean> {
		if (!code) return false
		const active = await this.readActiveCode()
		return Boolean(active && active.code === code)
	}

	/**
	 * Promote/demote live code-joiners when class-can-edit changes.
	 * Does not write `meta:roles` — stored Viewer/Editor still wins on reconnect.
	 */
	private async syncLiveRolesForClassCanEdit(): Promise<void> {
		this.hydrateSockets()
		const enabled = await this.readClassCanEdit()
		const stored = await this.readStoredRoles()
		let changed = false
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const prev = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			if (prev.role === 'owner' || prev.role === 'manager' || prev.isHost) {
				continue
			}
			const userId = prev.meta.userId
			const storedRole = userId ? stored[userId] : undefined
			if (
				storedRole === 'manager' ||
				storedRole === 'editor' ||
				storedRole === 'viewer'
			) {
				continue
			}
			const nextRole: WhiteboardRole =
				enabled && prev.joinedViaShareCode ? 'editor' : 'viewer'
			if (nextRole === prev.role) continue
			const next: SocketAttachment = {
				...prev,
				role: nextRole,
				canEdit: roleCanEdit(nextRole),
			}
			ws.serializeAttachment(next)
			sendJson(ws, {
				type: 'wb:role',
				role: nextRole,
				canEdit: next.canEdit,
			})
			changed = true
		}
		if (changed) this.broadcastParticipants()
	}

	private async readStoredRoles(): Promise<StoredRoles> {
		const stored = await this.ctx.storage.get<StoredRoles>(ROLES_KEY)
		if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
			return {}
		}
		const out: StoredRoles = {}
		for (const [userId, role] of Object.entries(stored)) {
			if (isAssignableRole(role) && userId) out[userId] = role
		}
		return out
	}

	private emptyForceFollow(): StoredForceFollow {
		return { enabled: false, targetUserId: '', subjects: {} }
	}

	private async getForceFollowState(): Promise<StoredForceFollow> {
		if (this.forceFollowCache) return this.forceFollowCache
		const stored = await this.ctx.storage.get<boolean | StoredForceFollow>(
			FORCE_FOLLOW_KEY,
		)
		if (stored === true) {
			this.forceFollowCache = {
				enabled: true,
				targetUserId: this.resolveOwnerUserId(),
				subjects: {},
			}
			return this.forceFollowCache
		}
		if (stored && typeof stored === 'object') {
			this.forceFollowCache = {
				enabled: Boolean(stored.enabled),
				targetUserId:
					typeof stored.targetUserId === 'string' ? stored.targetUserId : '',
				subjects:
					stored.subjects && typeof stored.subjects === 'object'
						? stored.subjects
						: {},
			}
			return this.forceFollowCache
		}
		this.forceFollowCache = this.emptyForceFollow()
		return this.forceFollowCache
	}

	private async setForceFollowState(state: StoredForceFollow): Promise<void> {
		this.forceFollowCache = state
		if (!state.enabled && Object.keys(state.subjects).length === 0) {
			await this.ctx.storage.delete(FORCE_FOLLOW_KEY)
			return
		}
		await this.ctx.storage.put(FORCE_FOLLOW_KEY, state)
	}

	private async resolveActor(
		url: URL,
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		const actorSessionId = url.searchParams.get('actorSessionId')
		const actorAuth = url.searchParams.get('actorAuth')
		if (actorSessionId && actorAuth) {
			const ws = this.sessionIdToWs.get(actorSessionId)
			if (ws) {
				const attachment = normalizeAttachment(
					ws.deserializeAttachment() as Partial<SocketAttachment> | null,
					actorSessionId,
				)
				if (attachment.authToken && attachment.authToken === actorAuth) {
					return {
						role: attachment.role,
						userId: attachment.meta.userId,
						sessionId: attachment.sessionId,
					}
				}
			}
		}

		const hostSecret = url.searchParams.get('hostSecret')
		if (await this.assertHost(hostSecret)) {
			const cloudOwnerKey =
				(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
			if (!cloudOwnerKey) {
				const owner = this.listParticipants().find(
					(row) => row.role === 'owner' || row.isHost,
				)
				return {
					role: 'owner',
					userId: owner?.userId ?? '',
					sessionId: owner?.sessionId ?? '',
				}
			}
		}
		return null
	}

	private async handleParticipantPatch(
		request: Request,
		url: URL,
		sessionId: string,
	): Promise<Response> {
		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' })
		}

		const actor = await this.resolveActor(url)
		if (!actor || (actor.role !== 'owner' && actor.role !== 'manager')) {
			return json(403, {
				error: 'Only the Owner or a Manager can change roles.',
			})
		}

		const nextRoleRaw = url.searchParams.get('role')
		if (!isAssignableRole(nextRoleRaw)) {
			return json(400, {
				error: 'Body must include role manager | editor | viewer',
			})
		}

		this.hydrateSockets()
		const ws = this.sessionIdToWs.get(sessionId)
		if (!ws) {
			return json(404, { error: 'Session not connected' })
		}

		const attachment = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			sessionId,
		)

		if (attachment.role === 'owner' || attachment.meta.isHost) {
			return json(400, { error: 'Owner cannot be demoted.' })
		}

		if (!canAssignRole(actor.role, attachment.role, nextRoleRaw)) {
			return json(403, {
				error:
					actor.role === 'manager'
						? 'Managers can only set Editor or Viewer, and cannot change the Owner or another Manager.'
						: 'That role change is not allowed.',
			})
		}

		await this.applyRoleToUser(attachment.meta.userId, nextRoleRaw)
		const row = this.participantFromSession(sessionId)
		if (!row) {
			return json(404, { error: 'Session not connected' })
		}
		return json(200, row)
	}

	private async applyRoleToUser(
		userId: string,
		role: AssignableRole,
	): Promise<void> {
		if (userId) {
			const stored = await this.readStoredRoles()
			stored[userId] = role
			await this.ctx.storage.put(ROLES_KEY, stored)
		}
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const prev = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			if (prev.role === 'owner') continue
			if (userId && prev.meta.userId === userId) {
				const next: SocketAttachment = {
					...prev,
					role,
					canEdit: roleCanEdit(role),
				}
				ws.serializeAttachment(next)
				sendJson(ws, {
					type: 'wb:role',
					role,
					canEdit: next.canEdit,
				})
			}
		}
		this.broadcastParticipants()
	}

	private async handleForceFollowPatch(
		request: Request,
		url: URL,
	): Promise<Response> {
		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' })
		}

		const actor = await this.resolveActor(url)
		if (!actor || (actor.role !== 'owner' && actor.role !== 'manager')) {
			return json(403, {
				error: 'Only the Owner or a Manager can force follow.',
			})
		}

		const forceFollowParam = url.searchParams.get('forceFollow')
		const forceFollow =
			forceFollowParam === '1' || forceFollowParam === 'true'
		const targetUserId =
			(url.searchParams.get('targetUserId') || '').trim() || actor.userId
		const subjectUserId = (url.searchParams.get('subjectUserId') || '').trim()

		const current = await this.getForceFollowState()
		if (subjectUserId) {
			if (forceFollow && targetUserId) {
				current.subjects[subjectUserId] = targetUserId
			} else {
				delete current.subjects[subjectUserId]
			}
		} else {
			current.enabled = forceFollow
			current.targetUserId = forceFollow ? targetUserId : ''
		}
		await this.setForceFollowState(current)
		void this.broadcastForceFollow()
		void this.refreshFollowedFlags()
		const targetSessionId = this.sessionIdForUserId(current.targetUserId)
		return json(200, {
			forceFollow: current.enabled,
			targetUserId: current.targetUserId,
			targetSessionId,
			subjects: current.subjects,
		})
	}

	private resolveOwnerUserId(): string {
		for (const row of this.listParticipants()) {
			if (row.role === 'owner' && row.userId) return row.userId
		}
		return ''
	}

	private sessionIdForUserId(userId: string): string {
		if (!userId) return ''
		for (const row of this.listParticipants()) {
			if (row.userId === userId) return row.sessionId
		}
		return ''
	}

	private async broadcastForceFollow(): Promise<void> {
		const state = await this.getForceFollowState()
		if (state.enabled && !state.targetUserId) {
			state.targetUserId = this.resolveOwnerUserId()
		}
		const payload = {
			type: 'wb:forceFollow' as const,
			forceFollow: state.enabled,
			targetUserId: state.targetUserId,
			targetSessionId: this.sessionIdForUserId(state.targetUserId),
			subjects: state.subjects,
		}
		for (const ws of this.sessionIdToWs.values()) {
			sendJson(ws, payload)
		}
	}

	private async refreshFollowedFlags(): Promise<void> {
		const force = await this.getForceFollowState()
		const voluntaryTargets = new Set(this.voluntaryFollow.values())
		const subjectTargets = new Set(Object.values(force.subjects))
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const row = this.participantFromSession(sessionId)
			const isForceTarget =
				force.enabled && Boolean(row?.userId) && row!.userId === force.targetUserId
			const isSubjectTarget = Boolean(row?.userId && subjectTargets.has(row.userId))
			sendJson(ws, {
				type: 'wb:followedBy',
				followed: Boolean(
					isForceTarget || isSubjectTarget || voluntaryTargets.has(sessionId),
				),
			})
		}
	}

	private participantFromSession(sessionId: string): ParticipantPublic | null {
		const ws = this.sessionIdToWs.get(sessionId)
		if (!ws) return null
		const attachment = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			sessionId,
		)
		if (attachment.pendingClerkAuth) return null
		return {
			sessionId,
			userId: attachment.meta.userId,
			displayName: attachment.meta.displayName,
			role: attachment.role,
			canEdit: attachment.canEdit,
			isHost: attachment.isHost || attachment.meta.isHost,
		}
	}

	private listParticipants(): ParticipantPublic[] {
		const rows: ParticipantPublic[] = []
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const attachment = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			if (attachment.pendingClerkAuth) continue
			rows.push({
				sessionId,
				userId: attachment.meta.userId,
				displayName: attachment.meta.displayName,
				role: attachment.role,
				canEdit: attachment.canEdit,
				isHost: attachment.isHost || attachment.meta.isHost,
			})
		}
		return rows
	}

	private broadcastParticipants(): void {
		const participants = this.listParticipants()
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const self = participants.find((row) => row.sessionId === sessionId)
			sendJson(ws, {
				type: 'wb:participants',
				yourSessionId: sessionId,
				yourRole: self?.role ?? 'viewer',
				participants,
			})
		}
	}

	private persistVoluntaryFollow(
		fromSessionId: string,
		targetSessionId: string | null,
	): void {
		if (!targetSessionId) {
			this.voluntaryFollow.delete(fromSessionId)
		} else if (this.sessionIdToWs.has(targetSessionId)) {
			this.voluntaryFollow.set(fromSessionId, targetSessionId)
		} else {
			return
		}
		const ws = this.sessionIdToWs.get(fromSessionId)
		if (!ws) return
		const prev = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			fromSessionId,
		)
		ws.serializeAttachment({
			...prev,
			followTargetSessionId: targetSessionId || undefined,
		})
	}

	private handleFollowSubscribe(
		fromSessionId: string,
		targetSessionId: string | null,
	): void {
		this.persistVoluntaryFollow(fromSessionId, targetSessionId)
		void this.refreshFollowedFlags()
	}

	private async relaySceneBounds(
		fromSessionId: string,
		bounds: [number, number, number, number],
	): Promise<void> {
		const payload = {
			type: 'wb:sceneBounds' as const,
			socketId: fromSessionId,
			bounds,
		}
		const force = await this.getForceFollowState()
		const fromRow = this.participantFromSession(fromSessionId)
		for (const [sessionId, ws] of this.sessionIdToWs) {
			if (sessionId === fromSessionId) continue
			const row = this.participantFromSession(sessionId)
			const voluntary = this.voluntaryFollow.get(sessionId) === fromSessionId
			const roomForce =
				force.enabled &&
				fromRow &&
				force.targetUserId &&
				fromRow.userId === force.targetUserId
			const subjectForce =
				row?.userId &&
				fromRow?.userId &&
				force.subjects[row.userId] === fromRow.userId
			if (voluntary || roomForce || subjectForce) {
				sendJson(ws, payload)
			}
		}
	}

	/**
	 * Share-code GET (secret value) / POST / DELETE: Owner or Manager only.
	 * Proof is a live session token, scratch host secret, or Clerk matching
	 * `cloudOwnerKey`. Leftover host on a Google-owned board is not enough.
	 */
	private async resolveShareCodeActor(
		request: Request,
		url: URL,
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		const actorUrl = new URL(url.toString())
		const sessionId =
			actorUrl.searchParams.get('actorSessionId') ||
			request.headers.get('X-Board-Session')?.trim() ||
			''
		const authToken =
			actorUrl.searchParams.get('actorAuth') ||
			request.headers.get('X-Board-Auth')?.trim() ||
			''
		if (sessionId) actorUrl.searchParams.set('actorSessionId', sessionId)
		if (authToken) actorUrl.searchParams.set('actorAuth', authToken)
		const headerHost = request.headers.get('X-Board-Host')?.trim()
		if (
			headerHost &&
			!looksLikeJwt(headerHost) &&
			!actorUrl.searchParams.get('hostSecret')
		) {
			actorUrl.searchParams.set('hostSecret', headerHost)
		}
		const fromLive = await this.resolveActor(actorUrl)
		if (fromLive) return fromLive

		const clerkAuth = await this.tryClerkFromMetaRequest(request, url)
		if (!clerkAuth) return null
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		if (cloudOwnerKey && cloudOwnerKey === clerkAuth.ownerKey) {
			return {
				role: 'owner',
				userId: clerkAuth.accountId,
				sessionId: '',
			}
		}
		return null
	}

	private async requireShareCodeAdmin(
		request: Request,
		url: URL,
	): Promise<Response | null> {
		const actor = await this.resolveShareCodeActor(request, url)
		if (actor && (actor.role === 'owner' || actor.role === 'manager')) {
			return null
		}
		return json(403, {
			error: 'Only the Owner or a Manager can manage the share code.',
		})
	}

	private async handleCodeHttp(
		request: Request,
		url: URL,
		boardId: string,
	): Promise<Response> {
		if (!this.env.WHITEBOARD_CODES) {
			return json(503, {
				error: 'Share codes are not configured on this Worker.',
			})
		}

		const denied = await this.requireShareCodeAdmin(request, url)
		if (denied) return denied

		if (request.method === 'GET') {
			const state = await this.readActiveCode()
			if (!state) {
				return json(200, { code: null, expiresAt: null, open: false })
			}
			return json(200, {
				code: state.code,
				expiresAt: state.expiresAt,
				open: true,
			})
		}

		if (request.method === 'POST') {
			const rotate =
				url.searchParams.get('rotate') === '1' ||
				url.searchParams.get('rotate') === 'true'
			try {
				const state = await this.mintOrKeepCode(boardId, rotate)
				return json(200, {
					code: state.code,
					expiresAt: state.expiresAt,
					open: true,
				})
			} catch (err) {
				const message =
					err instanceof Error ? err.message : 'Could not create share code'
				const status = message.includes('Rate limit') ? 429 : 503
				return json(status, { error: message })
			}
		}

		if (request.method === 'DELETE') {
			await this.revokeActiveCode()
			return json(200, { code: null, expiresAt: null, open: false })
		}

		return json(405, { error: 'Method not allowed' })
	}

	private async readActiveCode(): Promise<CodeState | null> {
		const code = await this.ctx.storage.get<string>(ACTIVE_CODE_KEY)
		const expiresAt = await this.ctx.storage.get<string>(CODE_EXPIRES_AT_KEY)
		if (!code || !expiresAt) return null
		if (isExpiredIso(expiresAt)) {
			await this.revokeActiveCode()
			return null
		}
		return { code, expiresAt }
	}

	private async assertMintAllowed(): Promise<void> {
		const now = Date.now()
		const log =
			(await this.ctx.storage.get<number[]>(CODE_MINT_LOG_KEY)) ?? []
		const recent = log.filter((t) => now - t < MINT_RATE_WINDOW_MS)
		if (recent.length >= MINT_RATE_LIMIT) {
			throw new Error(
				'Rate limit: too many share-code changes. Try again in a few minutes.',
			)
		}
		recent.push(now)
		await this.ctx.storage.put(CODE_MINT_LOG_KEY, recent)
	}

	/**
	 * Open: mint if none, else keep. Rotate: always mint a new code.
	 */
	private async mintOrKeepCode(
		boardId: string,
		rotate: boolean,
	): Promise<CodeState> {
		const existing = await this.readActiveCode()
		if (existing && !rotate) {
			return existing
		}

		await this.assertMintAllowed()

		if (existing) {
			await this.env.WHITEBOARD_CODES.delete(kvCodeKey(existing.code))
		}

		const expiresAt = new Date(Date.now() + SHARE_CODE_TTL_MS).toISOString()
		let code: string | null = null

		for (let i = 0; i < MINT_SAMPLE_ATTEMPTS; i++) {
			const candidate = sampleShareCode()
			const key = kvCodeKey(candidate)
			const clash = await this.env.WHITEBOARD_CODES.get(key)
			if (clash) continue

			await this.env.WHITEBOARD_CODES.put(
				key,
				JSON.stringify({ boardId, exp: expiresAt }),
				{ expirationTtl: SHARE_CODE_TTL_SECONDS },
			)
			code = candidate
			break
		}

		if (!code) {
			throw new Error('Could not allocate a free share code. Try again.')
		}

		await this.ctx.storage.put(ACTIVE_CODE_KEY, code)
		await this.ctx.storage.put(CODE_EXPIRES_AT_KEY, expiresAt)
		await this.scheduleNextAlarm()

		return { code, expiresAt }
	}

	private async revokeActiveCode(): Promise<void> {
		await this.clearActiveCodeKeys()
		await this.scheduleNextAlarm()
	}

	private async clearActiveCodeKeys(): Promise<void> {
		const code = await this.ctx.storage.get<string>(ACTIVE_CODE_KEY)
		if (code) {
			await this.env.WHITEBOARD_CODES.delete(kvCodeKey(code))
		}
		await this.ctx.storage.delete(ACTIVE_CODE_KEY)
		await this.ctx.storage.delete(CODE_EXPIRES_AT_KEY)
	}

	/**
	 * Durable Objects have one alarm. Fire the sooner of share-code expiry
	 * and unsaved 24h TTL; the handler reschedules whatever is still pending.
	 */
	private async scheduleNextAlarm(): Promise<void> {
		const times: number[] = []
		const codeExpiresAt = await this.ctx.storage.get<string>(CODE_EXPIRES_AT_KEY)
		if (codeExpiresAt && !isExpiredIso(codeExpiresAt)) {
			const t = Date.parse(codeExpiresAt)
			if (!Number.isNaN(t)) times.push(t)
		}
		if (!(await this.isSavedToLibrary())) {
			const unsavedExpiresAt = await this.ctx.storage.get<string>(
				META_UNSAVED_EXPIRES_AT_KEY,
			)
			if (unsavedExpiresAt && !isExpiredIso(unsavedExpiresAt)) {
				const t = Date.parse(unsavedExpiresAt)
				if (!Number.isNaN(t)) times.push(t)
			}
		}
		if (times.length === 0) {
			try {
				await this.ctx.storage.deleteAlarm()
			} catch {
				// no alarm set
			}
			return
		}
		await this.ctx.storage.setAlarm(Math.min(...times))
	}

	private async expireUnsavedBoard(): Promise<void> {
		this.ctx.storage.sql.exec('DELETE FROM excalidraw_scene')
		this.sceneCache = { elements: [], appState: {} }
		this.sceneLoaded = true
		await this.cleanupTempAssets()
		await this.clearActiveCodeKeys()
		await this.ctx.storage.delete(META_UNSAVED_EXPIRES_AT_KEY)
		await this.ctx.storage.delete(META_CREATED_AT_KEY)
		this.broadcastScene(
			{ type: 'scene:sync', elements: [], appState: {} },
			null,
		)
	}

	/** Phase 3.2 stores `meta:tempAssetPrefix`; we best-effort delete that R2 prefix. */
	private async cleanupTempAssets(): Promise<void> {
		const prefix = sanitizeAssetPrefix(
			await this.ctx.storage.get<string>(META_TEMP_ASSET_PREFIX_KEY),
		)
		if (!prefix || !this.env.WHITEBOARD_ASSETS) return
		try {
			let cursor: string | undefined
			do {
				const listed = await this.env.WHITEBOARD_ASSETS.list({
					prefix,
					cursor,
					limit: 100,
				})
				await Promise.all(
					listed.objects.map((object) =>
						this.env.WHITEBOARD_ASSETS.delete(object.key),
					),
				)
				cursor = listed.truncated ? listed.cursor : undefined
			} while (cursor)
		} catch {
			// R2 cleanup is best-effort; scene already dropped.
		}
	}

	/** KV TTL + DO alarm: share codes (12h) and unsaved boards (24h). */
	override async alarm(): Promise<void> {
		const expiresAt = await this.ctx.storage.get<string>(CODE_EXPIRES_AT_KEY)
		if (!expiresAt || isExpiredIso(expiresAt)) {
			await this.clearActiveCodeKeys()
		}

		const saved = await this.isSavedToLibrary()
		const unsavedExpiresAt = await this.ctx.storage.get<string>(
			META_UNSAVED_EXPIRES_AT_KEY,
		)
		if (!saved && unsavedExpiresAt && isExpiredIso(unsavedExpiresAt)) {
			await this.expireUnsavedBoard()
		}

		await this.scheduleNextAlarm()
	}

	private getSessionId(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as SocketAttachment | null
		return attachment?.sessionId ?? null
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		this.hydrateSockets()
		await this.restoreFollowAfterWake()
		const sessionId = this.getSessionId(ws)
		if (!sessionId) return
		this.sessionIdToWs.set(sessionId, ws)
		if (typeof message !== 'string') return

		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return
		}
		if (!parsed || typeof parsed !== 'object') return
		const data = parsed as Record<string, unknown>
		const attachment = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			sessionId,
		)
		if (attachment.pendingClerkAuth) {
			await this.finishPendingConnectAuth(ws, attachment, data)
			if (data.type === 'wb:auth') return
		}
		const type = data.type

		if (type === 'wb:auth') return

		if (type === 'scene:request') {
			await this.sendFullScene(ws)
			return
		}

		if (type === 'wb:follow') {
			const targetSessionId =
				typeof data.targetSessionId === 'string' && data.targetSessionId
					? data.targetSessionId
					: null
			this.handleFollowSubscribe(sessionId, targetSessionId)
			return
		}

		if (type === 'wb:sceneBounds') {
			const bounds = data.bounds
			if (
				Array.isArray(bounds) &&
				bounds.length === 4 &&
				bounds.every((n) => typeof n === 'number' && Number.isFinite(n))
			) {
				await this.relaySceneBounds(
					sessionId,
					bounds as [number, number, number, number],
				)
			}
			return
		}

		if (type === 'scene:update') {
			const attachment = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			// PHASE 3.3: Viewers cannot mutate the document (UI + server).
			if (!roleCanEdit(attachment.role)) return
			try {
				if (
					typeof data.databaseJson === 'string' &&
					data.databaseJson.length > MAX_SCENE_JSON_BYTES
				) {
					throw sceneTooLargeError()
				}
				const elements = parseSceneElements(data.elements)
				const databaseJson =
					typeof data.databaseJson === 'string'
						? data.databaseJson
						: undefined
				await this.applySceneUpdate(
					sessionId,
					elements,
					databaseJson,
					data.full === true,
				)
			} catch (err) {
				this.notifyScenePersistError(sessionId, asScenePersistError(err))
			}
		}
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	) {
		try {
			ws.close(code, reason)
		} catch {
			// already closing
		}
		this.handleWebSocketEnd(ws)
	}

	override async webSocketError(ws: WebSocket) {
		this.handleWebSocketEnd(ws)
	}

	private handleWebSocketEnd(ws: WebSocket) {
		this.hydrateSockets()
		const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
		if (!raw?.sessionId) return
		this.sessionIdToWs.delete(raw.sessionId)
		this.persistVoluntaryFollow(raw.sessionId, null)
		for (const [follower, target] of [...this.voluntaryFollow]) {
			if (target === raw.sessionId) this.persistVoluntaryFollow(follower, null)
		}
		this.broadcastParticipants()
		void this.refreshFollowedFlags()
	}
}
