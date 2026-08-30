/**
 * Durable Object for one whiteboard room (product family: scsfoxchase-tech_whiteboards).
 *
 * Phase 2: native WebSocket Excalidraw scene sync + persist. Share-code
 * mint (once, permanent) / revoke and People HTTP stay on this same object.
 *
 * One alarm slot: unsaved TTL (24h). Refresh does not wipe the scene.
 * “Lose work” = never saved to a cloud library.
 */
import { DurableObject } from 'cloudflare:workers'
import { generateGuestDisplayName } from '../lib/whiteboard-display-name'
import {
	FULL_RESYNC_EVERY,
	MAX_SCENE_ELEMENTS,
	MAX_SCENE_FRAME_BYTES,
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
	isMutationId,
	mergeSceneElements,
	parseDatabaseScene,
	parseSceneElements,
	parseStoredSceneElements,
	roleCanEdit,
	sceneEditNotAllowedError,
	sceneMalformedError,
	sessionCanEdit,
	sceneTooLargeError,
	type AssignableRole,
	type BoardPublicMeta,
	type OwnerHook,
	type SceneAppState,
	type SceneElement,
	type ScenePersistError,
	type SceneAckStatus,
	type WhiteboardRole,
	utf8ByteLength,
} from '../lib/whiteboard-sync'
import {
	tryClerkWhiteboardAuth,
	verifyClerkWhiteboardToken,
	type ClerkWhiteboardAuth,
} from './clerkAuth'
import {
	isValidConnectSessionId,
} from './connectAdmission'
import { libraryIndexContainsBoard } from './libraryRoutes'
import { logWhiteboardEvent } from './httpSecurity'
import {
	isExpiredIso,
	kvCodeKey,
	normalizeShareCode,
	parseShareCodeRecord,
	sampleShareCode,
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
/** Skip replacing an alarm when it is already scheduled at the target time. */
const ALARM_SET_TOLERANCE_MS = 1000
/** Bounds apply before any per-board storage reads on a websocket upgrade. */
export const MAX_BOARD_SOCKETS = 64
export const MAX_PENDING_AUTH_SOCKETS = 32
export const PENDING_AUTH_MAX_AGE_MS = 30_000

export function shouldSkipIdenticalScenePersist(
	lastPersistedJson: string | null,
	nextJson: string,
	force = false,
): boolean {
	return !force && lastPersistedJson === nextJson
}

export function shouldReplaceStorageAlarm(
	existingAlarm: number | null | undefined,
	target: number,
	toleranceMs = ALARM_SET_TOLERANCE_MS,
): boolean {
	if (existingAlarm == null) return true
	return Math.abs(existingAlarm - target) > toleranceMs
}

export function shouldApplySocketRoleUpgrade(
	current: WhiteboardRole,
	next: WhiteboardRole,
): boolean {
	const rank: Record<WhiteboardRole, number> = {
		viewer: 0,
		editor: 1,
		manager: 2,
		owner: 3,
	}
	return rank[next] > rank[current]
}

export function shouldApplySocketIdentityRefresh(
	current: { userId: string; displayName: string },
	next: { userId: string; displayName: string },
	clerkAuthenticated: boolean,
): boolean {
	return Boolean(
		clerkAuthenticated &&
			next.userId &&
			(next.userId !== current.userId ||
				next.displayName !== current.displayName),
	)
}

const SCENE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS excalidraw_scene (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		scene_json TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		last_mutation_id TEXT,
		last_mutation_hash TEXT,
		scene_revision INTEGER NOT NULL DEFAULT 0
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
	// PRAGMA returns an empty list when the table does not exist. Other errors
	// (notably quota/storage failures) must propagate: treating them as a new
	// empty board could let a later edit overwrite a scene we failed to read.
	return storage.sql
		.exec<{ name: string }>('PRAGMA table_info(excalidraw_scene)')
		.toArray()
		.map((row) => row.name)
}

function listSceneV2TableColumns(storage: DurableObjectStorage): string[] {
	return storage.sql
		.exec<{ name: string }>('PRAGMA table_info(excalidraw_scene_v2)')
		.toArray()
		.map((row) => row.name)
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
function migrateExcalidrawSceneTable(
	storage: DurableObjectStorage,
	knownTables?: Iterable<string>,
): boolean {
	const tables = new Set(knownTables ?? listUserSqlTables(storage))
	if (tables.has('excalidraw_scene_v2') && !tables.has('excalidraw_scene')) {
		// Keep the interrupted v2 table as a recoverable source. Copying it into
		// the canonical table is additive; renaming it would make a partial
		// migration needlessly destructive if the next write fails.
		try {
			storage.sql.exec(SCENE_TABLE_SQL)
			storage.sql.exec(
				`INSERT INTO excalidraw_scene (id, scene_json, updated_at)
				 SELECT id, scene_json, updated_at
				 FROM excalidraw_scene_v2
				 WHERE id = 1
				 ON CONFLICT(id) DO NOTHING`,
			)
		} catch {
			// The v2 table remains readable if an additive copy is interrupted.
			return false
		}
		return true
	}

	try {
		storage.sql.exec(SCENE_TABLE_SQL)
	} catch {
		// Leave an existing legacy table readable when canonical setup fails.
		return false
	}
	const columns = new Set(listSceneTableColumns(storage))
	if (columns.has('scene_json')) {
		// A leftover v2 table is historical data, not disposable migration
		// scratch. Leave it in place. For an additive legacy table, the old
		// columns remain the read-authoritative fallback until the next scene
		// write has durably populated the canonical column.
		// This also covers an additive legacy table, which must not receive a
		// second scene_json column on a later scene write.
		return true
	}
	if (!columns.has('live_json') && !columns.has('database_json')) return true

	const legacyColumns = [
		columns.has('live_json') ? 'live_json' : null,
		columns.has('database_json') ? 'database_json' : null,
		columns.has('updated_at') ? 'updated_at' : null,
	].filter((column): column is string => column !== null)
	const row = storage.sql
		.exec<{
			live_json?: string | null
			database_json?: string | null
			updated_at?: number | null
		}>(
			`SELECT ${legacyColumns.join(', ')} FROM excalidraw_scene WHERE id = 1`,
		)
		.toArray()[0]
	const sceneJson = row ? liveOrDatabaseToSceneJson(row) : null

	// Legacy boards use this table name already, so migrate additively instead
	// of replacing the table. The old live/database columns remain available
	// as a lossless fallback if the copy cannot be represented.
	try {
		storage.sql.exec(
			'ALTER TABLE excalidraw_scene ADD COLUMN scene_json TEXT',
		)
	} catch {
		// The legacy columns remain the lossless read fallback.
		return false
	}
	if (sceneJson) {
		try {
			storage.sql.exec(
				`UPDATE excalidraw_scene
				 SET scene_json = ?, updated_at = COALESCE(updated_at, ?)
				 WHERE id = 1 AND (scene_json IS NULL OR scene_json = '')`,
				sceneJson,
				row?.updated_at ?? Date.now(),
			)
		} catch {
			// A failed copy does not invalidate the legacy source row.
			return false
		}
	}
	return true
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
	/** Wall-clock age for pending auth; attachment survives DO hibernation. */
	pendingSince?: number
	connectOrigin?: string
	/** Voluntary Follow target; survives hibernation with the socket. */
	followTargetSessionId?: string
	/** Presented the active share code on connect (cookie). Not a stored role. */
	joinedViaShareCode?: boolean
	/** Board UUID from the connect URL (Durable Object name). */
	boardId?: string
}

type ResolvedSocketAuth = {
	attachment: SocketAttachment
	clerkAuthenticated: boolean
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

/** Compare JSON-derived appState values without treating object key order as a change. */
function stableJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null'
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(',')}]`
	}
	const record = value as Record<string, unknown>
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(',')}}`
}

function sameSceneAppState(
	left: SceneAppState,
	right: SceneAppState,
): boolean {
	return stableJson(left) === stableJson(right)
}

function liveSceneJson(scene: LiveScene): string {
	return JSON.stringify({
		elements: scene.elements,
		appState: scene.appState,
	})
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

const BOARD_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PLAYER_OWNER_KEY_RE = /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/

function parsePersistedPlayerLink(
	link: unknown,
): { ownerKey: string; fileId: string } | null {
	if (typeof link !== 'string' || !link) return null
	let url: URL
	try {
		url = new URL(link, 'https://scsfoxchase.tech')
	} catch {
		return null
	}
	if (url.pathname !== '/whiteboard-player') return null
	const ownerKey = url.searchParams.get('owner') || ''
	const fileId = url.searchParams.get('id') || ''
	if (!PLAYER_OWNER_KEY_RE.test(ownerKey) || !BOARD_UUID_RE.test(fileId)) {
		return null
	}
	return { ownerKey, fileId }
}

function rewritePlayerLinkOwner(link: string, nextOwner: string): string {
	const url = new URL(link, 'https://scsfoxchase.tech')
	url.searchParams.set('owner', nextOwner)
	return `/whiteboard-player?${url.searchParams.toString()}`
}

/** Persist `owner=temp:{boardId}` embeddable player URLs as `google:` (keep `id=`). */
function rewriteTempPlayerUrlsInElements(
	elements: SceneElement[],
	tempOwner: string,
	googleOwner: string,
): { elements: SceneElement[]; rewritten: number } {
	let rewritten = 0
	const next = elements.map((el) => {
		if (el.type !== 'embeddable') return el
		const parsed = parsePersistedPlayerLink(el.link)
		if (!parsed || parsed.ownerKey !== tempOwner) return el
		rewritten += 1
		return {
			...el,
			link: rewritePlayerLinkOwner(String(el.link), googleOwner),
			version: el.version + 1,
		}
	})
	return { elements: next, rewritten }
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
			: raw?.canEdit === true
				? 'editor'
				: 'viewer'
	return {
		sessionId: raw?.sessionId ?? sessionId,
		isHost,
		canEdit:
			typeof raw?.canEdit === 'boolean' ? raw.canEdit : roleCanEdit(role),
		role,
		authToken: typeof raw?.authToken === 'string' ? raw.authToken : '',
		meta: {
			displayName: meta.displayName ?? '',
			userId: meta.userId ?? '',
			isHost: Boolean(meta.isHost || isHost),
		},
		pendingClerkAuth: Boolean(raw?.pendingClerkAuth),
		pendingSince:
			raw?.pendingClerkAuth &&
			typeof raw?.pendingSince === 'number' &&
			Number.isFinite(raw.pendingSince) &&
			raw.pendingSince > 0
				? raw.pendingSince
				: raw?.pendingClerkAuth
					? Date.now()
					: undefined,
		connectOrigin:
			typeof raw?.connectOrigin === 'string' ? raw.connectOrigin : '',
		followTargetSessionId:
			typeof raw?.followTargetSessionId === 'string' &&
			raw.followTargetSessionId
				? raw.followTargetSessionId
				: undefined,
		joinedViaShareCode: Boolean(raw?.joinedViaShareCode),
		boardId: typeof raw?.boardId === 'string' ? raw.boardId : '',
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

function protocolError(
	ws: WebSocket,
	error: ScenePersistError,
	mutationId: string | null = null,
): void {
	if (error.code === 'scene_too_large' || error.code === 'malformed_scene') {
		logWhiteboardEvent('scene_rejected', {
			reason: error.code === 'scene_too_large' ? 'too_large' : 'malformed',
		})
	}
	sendJson(ws, {
		type: 'wb:error',
		code: error.code,
		message: error.message,
		mutationId,
		terminal: error.terminal,
	})
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
	/** Canonical scene table is ready for writes in this object lifetime. */
	private sceneTableReady = false
	/** Mutation receipt columns are added lazily on the first scene write. */
	private sceneMutationColumnsReady = false
	/** Monotonic appState revision column is added with the receipt columns. */
	private sceneRevisionColumnReady = false
	/** Coalesces concurrent /meta + WebSocket lifetime checks after a wake. */
	private lifetimeInitialization: Promise<void> | null = null
	/** Serializes share-code mint, revoke, and expiry transitions. */
	private shareCodeTransition: Promise<void> = Promise.resolve()
	/** Invalidates a mint as soon as revoke/expiry is requested. */
	private shareCodeTransitionVersion = 0
	/** Last scene_json blob written or loaded; identical writes are no-ops. */
	private lastPersistedJson: string | null = null
	/**
	 * Deliberately retain only the latest receipt in the same scene row. Mutation
	 * IDs are ack correlation, not an unbounded replay log. Older replays use
	 * element LWW, while the same-row scene revision prevents stale appState.
	 */
	private lastMutationId: string | null = null
	private lastMutationHash: string | null = null
	private updatesSinceFullSync = 0
	/** Serializes scene read/merge/persist/broadcast/ack transitions. */
	private sceneTransition: Promise<void> = Promise.resolve()
	/** Persisted monotonic ordering for database appState mutations. */
	private sceneRevision = 0

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// Respond to ping messages at the platform level without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
		)
	}

	/** Keep the queue usable after a failed operation. */
	private enqueueSceneTransition<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.sceneTransition.then(operation, operation)
		this.sceneTransition = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	private resetLiveState(): void {
		this.forceFollowCache = null
		this.voluntaryFollow.clear()
		this.forceFollowNeedsRebroadcast = false
		this.sceneCache = { elements: [], appState: {} }
		this.sceneLoaded = true
		this.sceneTableReady = false
		this.sceneMutationColumnsReady = false
		this.sceneRevisionColumnReady = false
		this.lastPersistedJson = null
		this.lastMutationId = null
		this.lastMutationHash = null
		this.sceneRevision = 0
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

	/** Library delete: free the KV PIN. Does not wipe the scene. */
	async revokeShareCodeMapping(): Promise<void> {
		this.shareCodeTransitionVersion += 1
		await this.enqueueShareCodeTransition(() =>
			this.clearActiveCodeKeys(),
		)
		await this.scheduleNextAlarm()
	}

	/**
	 * Authenticated admin RPC: drop tldraw (and any other) SQLite/KV data, then
	 * re-create an empty Excalidraw scene table. Does not wipe new boards on its
	 * own — the Worker only calls this for listed object IDs.
	 */
	async wipeStoredData(): Promise<WipeStoredDataResult> {
		this.shareCodeTransitionVersion += 1
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
			await this.enqueueShareCodeTransition(() =>
				this.clearActiveCodeKeys(),
			)
			await this.clearAllStorage()
			this.lifetimeInitialization = null
			this.ctx.storage.sql.exec(SCENE_TABLE_SQL)
			this.sceneTableReady = true
			this.sceneMutationColumnsReady = true
			this.sceneRevisionColumnReady = true
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
					sessionCanEdit(attachment.role, await this.readClassCanEdit())
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

	/**
	 * After claim copies temp→google, rewrite persisted `/whiteboard-player`
	 * URLs in `scene_json`. Persist uses the same fail-closed path as live
	 * edits (throw, `wb:error`, no broadcast). Does not delete R2 objects.
	 */
	async rewriteTempPlayerUrlsAfterClaim(opts: {
		boardId: string
		googleOwnerKey: string
	}): Promise<
		| { ok: true; rewritten: number }
		| { ok: false; status: number; error: string; code?: string }
	> {
		this.hydrateSockets()
		const boardId = typeof opts.boardId === 'string' ? opts.boardId.trim() : ''
		if (!BOARD_UUID_RE.test(boardId)) {
			return { ok: false, status: 400, error: 'Invalid boardId' }
		}
		const key = sanitizeOwnerKey(opts.googleOwnerKey)
		if (!key || !key.startsWith('google:')) {
			return { ok: false, status: 400, error: 'Invalid google owner' }
		}
		const stored =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		if (stored && stored.startsWith('google:') && stored !== key) {
			return {
				ok: false,
				status: 403,
				error: 'Owner does not match this board',
			}
		}
		try {
			const rewritten = await this.applyTempPlayerUrlRewrite(boardId, key)
			return { ok: true, rewritten }
		} catch (err) {
			const persistErr = asScenePersistError(err)
			this.notifyScenePersistError('', persistErr)
			return {
				ok: false,
				status: 500,
				error: persistErr.message,
				code: persistErr.code,
			}
		}
	}

	/** Rebuild the session map after hibernation. */
	private hydrateSockets(): void {
		if (this.socketsHydrated) return
		this.socketsHydrated = true
		this.voluntaryFollow.clear()
		for (const ws of this.ctx.getWebSockets()) {
			const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
			if (!raw?.sessionId || !isValidConnectSessionId(raw.sessionId)) {
				try {
					ws.close(4002, 'invalid session id')
				} catch {
					// already closing
				}
				continue
			}
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

	private pendingSocketCount(): number {
		let count = 0
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const attachment = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			if (attachment.pendingClerkAuth) count += 1
		}
		return count
	}

	/**
	 * Pending auth has no storage alarm of its own. A wake/connect/message
	 * prunes stale sockets and keeps the in-memory admission counters finite.
	 */
	private pruneExpiredPendingSockets(now = Date.now()): void {
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const attachment = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			if (
				!attachment.pendingClerkAuth ||
				!attachment.pendingSince ||
				now - attachment.pendingSince < PENDING_AUTH_MAX_AGE_MS
			)
				continue
			try {
				ws.close(4008, 'authentication timeout')
			} catch {
				// already closing
			}
			this.sessionIdToWs.delete(sessionId)
			this.voluntaryFollow.delete(sessionId)
			logWhiteboardEvent('connect_auth_timeout')
		}
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
	 * Store host secret hash on the first authenticated wb:auth that supplies a
	 * secret; verify on later connects. Creating browser is ephemeral Owner.
	 */
	private async resolveHost(hostSecret: string | null): Promise<boolean> {
		if (!hostSecret || looksLikeJwt(hostSecret)) return false
		const hash = await sha256Hex(hostSecret)
		return this.ctx.storage.transaction(async (transaction) => {
			const existing = await transaction.get<string>(HOST_SECRET_HASH_KEY)
			if (existing) return existing === hash
			await transaction.put(HOST_SECRET_HASH_KEY, hash)
			return true
		})
	}

	private async assertHost(hostSecret: string | null): Promise<boolean> {
		if (!hostSecret || looksLikeJwt(hostSecret)) return false
		const hash = await sha256Hex(hostSecret)
		const existing = await this.ctx.storage.get<string>(HOST_SECRET_HASH_KEY)
		return Boolean(existing && existing === hash)
	}

	/**
	 * Scratch Owner proof only. After a Google claim, leftover host secrets
	 * must not count as Owner for a *different* Google account (shared
	 * Chromebook). Same Clerk owner may still use leftover host after an
	 * in-flight Recents claim sets `cloudOwnerKey`. `mint` is first-connect
	 * only — HTTP handlers must not mint a hash.
	 */
	private async hostProvesScratchOwner(
		hostSecret: string | null,
		opts: { mint: boolean; clerkAuth?: ClerkWhiteboardAuth | null },
	): Promise<boolean> {
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		if (cloudOwnerKey && cloudOwnerKey.startsWith('google:')) {
			if (
				!opts.clerkAuth ||
				!this.clerkMatchesCloudOwner(opts.clerkAuth, cloudOwnerKey)
			)
				return false
			// A leftover host secret may verify for the matching Clerk owner, but
			// a host header/auth retry must never plant a new secret on a claimed
			// board. Claiming is already established by Clerk metadata.
			return await this.assertHost(hostSecret)
		}
		return opts.mint
			? await this.resolveHost(hostSecret)
			: await this.assertHost(hostSecret)
	}

	/** Header only — never the WebSocket query string (access logs). */
	private connectHostSecretFromHeader(request: Request): string | null {
		const header = request.headers.get('X-Board-Host')?.trim()
		if (!header || looksLikeJwt(header)) return null
		return header
	}

	async fetch(request: Request): Promise<Response> {
		this.hydrateSockets()
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
		await this.restoreFollowAfterWake()

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
		if (!isValidConnectSessionId(sessionId)) {
			logWhiteboardEvent('connect_rejected')
			return new Response('Invalid session id', { status: 400 })
		}

		// This check intentionally precedes host/share/storage reads and the
		// platform acceptWebSocket call. Reconnects replace their own socket.
		this.pruneExpiredPendingSockets()
		const replacing = this.sessionIdToWs.get(sessionId)
		const socketCount = this.sessionIdToWs.size - (replacing ? 1 : 0)
		if (socketCount >= MAX_BOARD_SOCKETS) {
			logWhiteboardEvent('connect_socket_cap_rejected')
			return new Response('Board connection limit reached', { status: 429 })
		}
		const pendingCount =
			this.pendingSocketCount() -
			(replacing &&
				normalizeAttachment(
					replacing.deserializeAttachment() as Partial<SocketAttachment> | null,
					sessionId,
				).pendingClerkAuth
				? 1
				: 0)
		if (pendingCount >= MAX_PENDING_AUTH_SOCKETS) {
			logWhiteboardEvent('connect_pending_cap_rejected')
			return new Response('Pending authentication limit reached', { status: 429 })
		}

		const headerHost = this.connectHostSecretFromHeader(request)
		// Do not resolve Clerk on the upgrade request. Browsers cannot send
		// Authorization headers on a WebSocket, and a slow Clerk BAPI call
		// here blocks the 101 handshake and the initial scene:sync. Role is
		// decided at first-message `wb:auth` (finishPendingConnectAuth).
		const isHost = await this.hostProvesScratchOwner(headerHost, {
			// A header is only a non-mutating proof of an already initialized
			// board. New scratch ownership is claimed by the first wb:auth frame.
			mint: false,
			clerkAuth: null,
		})
		const guestUserId = sanitizeUserId(url.searchParams.get('userId'))
		const displayName =
			sanitizeDisplayName(url.searchParams.get('displayName')) ||
			generateGuestDisplayName(guestUserId || sessionId)

		// Always wait for first-message `wb:auth` so scratch host proof can
		// arrive off the query string (browsers cannot set WS headers).
		const pendingClerkAuth = true
		const userId = guestUserId
		const joinedViaShareCode = await this.presentedJoinCodeIsActive(
			joinCodeFromConnectRequest(request, boardId),
		)
		const role = await this.resolveConnectRole({
			clerkAuth: null,
			guestUserId,
			isHost,
			joinedViaShareCode,
			boardId,
		})
		const canEdit = sessionCanEdit(role, await this.readClassCanEdit())
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
			pendingSince: Date.now(),
			connectOrigin: request.headers.get('Origin') ?? '',
			joinedViaShareCode,
			boardId,
		}
		serverWebSocket.serializeAttachment(attachment)
		this.sessionIdToWs.set(sessionId, serverWebSocket)
		logWhiteboardEvent('connect_accepted')

		// Do not make the HTTP 101 wait on an old/large scene read. The accepted
		// socket queues this initial frame, and waitUntil keeps delivery alive.
		this.ctx.waitUntil(
			this.sendInitialScene(serverWebSocket),
		)

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

	/**
	 * Resolve identity + role from a `wb:auth` payload. Returns null when the
	 * caller says it is signed in but has no JWT yet — the socket must stay
	 * pending (client shows "Connecting…") rather than finalize as Viewer and
	 * lock a real Owner out of the tools.
	 */
	private async resolveAuthMessage(
		attachment: SocketAttachment,
		data: Record<string, unknown>,
		opts: { mintHost: boolean },
	): Promise<ResolvedSocketAuth | null> {
		// Identity comes only from this message. Clerk is never resolved during
		// the upgrade, so there is nothing carried over from connect.
		let clerkAuth: ClerkWhiteboardAuth | null = null
		const rawToken = 'token' in data ? data.token : undefined
		const token = typeof rawToken === 'string' ? rawToken.trim() : ''
		if (token) {
			const profileUpdatedAt =
				typeof data.profileUpdatedAt === 'number' &&
				Number.isSafeInteger(data.profileUpdatedAt) &&
				data.profileUpdatedAt > 0
					? data.profileUpdatedAt
					: undefined
			const fromToken = await verifyClerkWhiteboardToken(
				token,
				this.env,
				attachment.connectOrigin,
				{
					refreshProfile: data.refreshProfile === true,
					profileUpdatedAt,
				},
			)
			if (fromToken) clerkAuth = fromToken
		}
		const signedInWithoutClerk = !clerkAuth && data.signedIn === true

		const hostSecret =
			typeof data.hostSecret === 'string' ? data.hostSecret : ''
		const isHost =
			attachment.isHost ||
			(await this.hostProvesScratchOwner(hostSecret, {
				mint: opts.mintHost,
				clerkAuth,
			}))

		const guestUserId = sanitizeUserId(attachment.meta.userId)
		const userId = clerkAuth ? clerkAuth.accountId : guestUserId
		let displayName = attachment.meta.displayName
		if (clerkAuth) {
			displayName = sanitizeDisplayName(clerkAuth.displayName) || displayName
		}
		const joinedViaShareCode = Boolean(attachment.joinedViaShareCode)
		const boardId =
			attachment.boardId ||
			(await this.ctx.storage.get<string>(META_BOARD_ID_KEY)) ||
			''
		const role = await this.resolveConnectRole({
			clerkAuth,
			guestUserId,
			isHost,
			joinedViaShareCode,
			boardId,
		})
		// Host proof on an unclaimed board already earns Owner, so greeting is
		// safe. Anything less could be a real Owner whose Clerk session has not
		// loaded yet — keep that socket pending instead of locking it to Viewer.
		if (signedInWithoutClerk && !roleCanEdit(role)) return null

		// Upgrade-time reads are deliberately write-free. Only a verified Clerk
		// token, active share cookie, or valid host proof from this first auth
		// frame may initialize board metadata and its alarm.
		if (boardId && (clerkAuth || isHost || joinedViaShareCode)) {
			await this.ensureBoardLifetime(boardId, {
				mintShareCode: role === 'owner' || role === 'manager',
			})
		}

		return {
			clerkAuthenticated: Boolean(clerkAuth),
			attachment: {
				...attachment,
				isHost,
				role,
				canEdit: sessionCanEdit(role, await this.readClassCanEdit()),
				pendingClerkAuth: false,
				pendingSince: undefined,
				joinedViaShareCode,
				boardId,
				meta: {
					...attachment.meta,
					userId,
					displayName,
					isHost,
				},
			},
		}
	}

	private async finishPendingConnectAuth(
		ws: WebSocket,
		attachment: SocketAttachment,
		data: Record<string, unknown>,
	): Promise<SocketAttachment> {
		const resolved = await this.resolveAuthMessage(attachment, data, {
			mintHost: true,
		})
		if (!resolved) return attachment
		const next = resolved.attachment
		// Another `wb:auth` may have greeted this socket while the Clerk
		// verification above was in flight. One hello per socket.
		const current = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			attachment.sessionId,
		)
		if (!current.pendingClerkAuth) return current
		ws.serializeAttachment(next)
		if (next.isHost || next.role !== 'viewer' || next.joinedViaShareCode) {
			logWhiteboardEvent('connect_auth_accepted')
		} else {
			logWhiteboardEvent('connect_viewer_accepted')
		}
		await this.sendConnectHello(ws, next)
		this.broadcastParticipants()
		await Promise.all([
			this.broadcastForceFollow(),
			this.refreshFollowedFlags(),
		])
		return next
	}

	/**
	 * A second `wb:auth` on an already-greeted socket. Clerk can settle well
	 * after connect (slow Chromebook, cold Clerk script), so the client
	 * re-sends once it holds a real JWT. Upgrade roles in place via `wb:role`,
	 * or refresh verified identity metadata without changing privileges. One
	 * hello per socket, and never downgrade an existing session.
	 */
	private async reauthenticateSocket(
		ws: WebSocket,
		attachment: SocketAttachment,
		data: Record<string, unknown>,
	): Promise<void> {
		const token = typeof data.token === 'string' ? data.token.trim() : ''
		const hostSecret =
			typeof data.hostSecret === 'string' ? data.hostSecret.trim() : ''
		if (!token && !hostSecret) return
		// `mintHost: false` — a greeted socket must not be able to plant the
		// host hash on a board that has none, which would lock the real
		// creator's leftover secret out for good.
		const resolved = await this.resolveAuthMessage(attachment, data, {
			mintHost: false,
		})
		if (!resolved) return
		const next = resolved.attachment
		// Upgrades only. Demotions belong to the People PATCH and the Group Edit
		// resync. A verified Clerk identity may still replace a same-role guest
		// name, but it must retain the socket's existing privilege fields.
		const roleUpgrade = shouldApplySocketRoleUpgrade(
			attachment.role,
			next.role,
		)
		const identityRefresh = shouldApplySocketIdentityRefresh(
			attachment.meta,
			next.meta,
			resolved.clerkAuthenticated,
		)
		if (!roleUpgrade && !identityRefresh) return
		const applied = roleUpgrade
			? next
			: {
					...attachment,
					meta: {
						...attachment.meta,
						userId: next.meta.userId,
						displayName: next.meta.displayName,
					},
				}
		ws.serializeAttachment(applied)
		if (roleUpgrade) {
			sendJson(ws, {
				type: 'wb:role',
				role: applied.role,
				canEdit: applied.canEdit,
			})
		}
		this.broadcastParticipants()
		await Promise.all([
			this.broadcastForceFollow(),
			this.refreshFollowedFlags(),
		])
	}

	private async handleMetaHttp(
		request: Request,
		url: URL,
		boardId: string,
	): Promise<Response> {
		if (request.method === 'GET') {
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
						: 'Only the Owner or a Manager can change Group Edit.',
				})
			}
			if (hasTitle) {
				const nextTitle = sanitizeBoardTitle(body.title)
				if (!nextTitle) {
					return json(400, { error: 'Enter a board name' })
				}
				const existingTitle = await this.ctx.storage.get<string>(META_TITLE_KEY)
				if (existingTitle !== nextTitle) {
					await this.ctx.storage.put(META_TITLE_KEY, nextTitle)
					this.broadcastTitle(nextTitle)
				}
			}
			if (hasClassCanEdit) {
				await this.setClassCanEdit(body.classCanEdit === true)
				await this.syncLiveCanEditForClassCanEdit()
			}
		}

		if (!hasLifetimeFields) {
			if (hasTitle || hasClassCanEdit) {
				await this.ensureBoardLifetime(boardId)
				return json(200, await this.readPublicMeta(true))
			}
			return json(400, { error: 'No meta fields to update' })
		}

		// Header proof is the normal transport from the Worker boundary. Keep
		// the URL value only for historical callers that predate X-Board-Host.
		const hostSecret = this.hostSecretFromRequest(request, url)
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
			if (!clerkAuth || !this.clerkMatchesCloudOwner(clerkAuth, existingOwner)) {
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
			if (!clerkAuth || !this.clerkMatchesCloudOwner(clerkAuth, existingOwner)) {
				return json(403, {
					error: 'Host secret cannot unsaved a Google-owned board',
				})
			}
		}

		if (typeof body.savedToLibrary === 'boolean') {
			const existingSaved = await this.isSavedToLibrary()
			if (existingSaved !== body.savedToLibrary) {
				await this.ctx.storage.put(
					META_SAVED_TO_LIBRARY_KEY,
					body.savedToLibrary,
				)
			}
			if (body.savedToLibrary) {
				const existingExpiry = await this.ctx.storage.get(
					META_UNSAVED_EXPIRES_AT_KEY,
				)
				if (existingExpiry !== undefined) {
					await this.ctx.storage.delete(META_UNSAVED_EXPIRES_AT_KEY)
				}
			} else {
				const createdAt =
					(await this.ctx.storage.get<string>(META_CREATED_AT_KEY)) ??
					new Date().toISOString()
				const expiresAt = new Date(
					Date.parse(createdAt) + UNSAVED_BOARD_TTL_MS,
				).toISOString()
				const existingExpiry = await this.ctx.storage.get<string>(
					META_UNSAVED_EXPIRES_AT_KEY,
				)
				if (existingExpiry !== expiresAt) {
					await this.ctx.storage.put(META_UNSAVED_EXPIRES_AT_KEY, expiresAt)
				}
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
			const existingPrefix = await this.ctx.storage.get<string>(
				META_TEMP_ASSET_PREFIX_KEY,
			)
			if (body.tempAssetPrefix === null) {
				if (existingPrefix !== undefined) {
					await this.ctx.storage.delete(META_TEMP_ASSET_PREFIX_KEY)
				}
			} else if (typeof body.tempAssetPrefix === 'string') {
				const prefix = sanitizeAssetPrefix(body.tempAssetPrefix)
				if (!prefix) return json(400, { error: 'Invalid tempAssetPrefix' })
				if (existingPrefix !== prefix) {
					await this.ctx.storage.put(META_TEMP_ASSET_PREFIX_KEY, prefix)
				}
			}
		}

		await this.scheduleNextAlarm()

		const savedNow = await this.isSavedToLibrary()
		const googleNow =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		if (savedNow && googleNow && googleNow.startsWith('google:')) {
			try {
				await this.applyTempPlayerUrlRewrite(boardId, googleNow)
			} catch (err) {
				const persistErr = asScenePersistError(err)
				this.notifyScenePersistError('', persistErr)
				return json(500, {
					error: persistErr.message,
					code: persistErr.code,
				})
			}
		}

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
		const hostSecret = this.hostSecretFromRequest(request, url)
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
		if (cloudOwnerKey && this.clerkMatchesCloudOwner(clerkAuth, cloudOwnerKey)) {
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
	 * Normal Worker forwarding keeps Clerk Authorization in its header. A
	 * JWT-shaped `hostSecret` query value is retained only for old callers.
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
	 * Title / class-can-edit PATCH: live session token, scratch host proof,
	 * then Clerk Owner (`cloudOwnerKey`) or stored Clerk Manager. Hub rename
	 * usually has Clerk (Worker forwards the JWT Authorization header) and no
	 * live socket. JWT-shaped values stay Clerk, not host proof.
	 */
	private async resolveActorFromMeta(
		url: URL,
		request: Request,
		body: { sessionId?: unknown; authToken?: unknown },
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		const actorUrl = new URL(url.toString())
		// Headers stay headers on the normal path. Body credentials are retained
		// only for the older meta PATCH shape, where resolveActor still accepts
		// the resulting compatibility query values.
		if (
			!request.headers.get('X-Board-Session') &&
			typeof body.sessionId === 'string' &&
			body.sessionId.trim()
		) {
			actorUrl.searchParams.set('actorSessionId', body.sessionId.trim())
		}
		if (
			!request.headers.get('X-Board-Auth') &&
			typeof body.authToken === 'string' &&
			body.authToken.trim()
		) {
			actorUrl.searchParams.set('actorAuth', body.authToken.trim())
		}
		const fromLive = await this.resolveActor(actorUrl, request)
		if (fromLive) return fromLive
		return this.resolveClerkOwnerOrManager(request, url)
	}

	/** Normal host proof is forwarded in a header; query proof is legacy-only. */
	private hostSecretFromRequest(request: Request, url: URL): string | null {
		const header = request.headers.get('X-Board-Host')?.trim()
		if (header && !looksLikeJwt(header)) return header
		const legacy = url.searchParams.get('hostSecret')?.trim()
		return legacy && !looksLikeJwt(legacy) ? legacy : null
	}

	/**
	 * Share-admin / title PATCH Clerk fallback: Owner via `cloudOwnerKey`,
	 * or stored Manager. Editors and unsigned stay out (Viewer 403).
	 */
	private async resolveClerkOwnerOrManager(
		request: Request,
		url: URL,
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		const clerkAuth = await this.tryClerkFromMetaRequest(request, url)
		if (!clerkAuth) return null
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		if (cloudOwnerKey && this.clerkMatchesCloudOwner(clerkAuth, cloudOwnerKey)) {
			return {
				role: 'owner',
				userId: clerkAuth.accountId,
				sessionId: '',
			}
		}
		const stored = await this.readStoredRoles()
		const storedRole =
			stored[clerkAuth.accountId] ??
			stored[clerkAuth.ownerKey] ??
			stored[clerkAuth.clerkUserId]
		if (storedRole !== 'manager') return null
		return {
			role: 'manager',
			userId: clerkAuth.accountId,
			sessionId: '',
		}
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
	private async initializeBoardLifetime(boardId: string): Promise<void> {
		const existingId = await this.ctx.storage.get<string>(META_BOARD_ID_KEY)
		if (!existingId) {
			// Schema setup belongs to first board initialization, not every cold
			// Durable Object wake. Re-running sqlite_master scans and DDL on every
			// reconnect wastes rows and can make an exhausted write quota block an
			// otherwise read-only existing board before its WebSocket upgrade. Only
			// supported Excalidraw schemas are considered; unrelated historical
			// tables (including tldraw_*) are never wiped or otherwise modified.
			const tables = listUserSqlTables(this.ctx.storage)
			this.sceneTableReady = migrateExcalidrawSceneTable(
				this.ctx.storage,
				tables,
			)
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

	private async ensureBoardLifetime(
		boardId: string,
		opts: { mintShareCode?: boolean } = {},
	): Promise<void> {
		if (!this.lifetimeInitialization) {
			this.lifetimeInitialization = this.initializeBoardLifetime(boardId)
		}
		try {
			await this.lifetimeInitialization
		} catch (error) {
			this.lifetimeInitialization = null
			throw error
		}

		if (opts.mintShareCode !== false) {
			try {
				await this.ensureShareCode(boardId)
			} catch {
				// UUID access still works if mint fails (rate limit / KV collision).
			}
		}
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
		const hasMutationColumns =
			columns.has('last_mutation_id') && columns.has('last_mutation_hash')
		this.sceneMutationColumnsReady = hasMutationColumns
		this.sceneRevisionColumnReady = columns.has('scene_revision')
		this.sceneRevision = 0
		const hasLegacySceneColumns =
			columns.has('live_json') || columns.has('database_json')
		const legacySceneColumns = [
			columns.has('live_json') ? 'live_json' : null,
			columns.has('database_json') ? 'database_json' : null,
		].filter((column): column is string => column !== null)
		const readV2Scene = (): { raw: string; scene: LiveScene } | null => {
			const v2Columns = new Set(listSceneV2TableColumns(this.ctx.storage))
			if (!v2Columns.has('scene_json')) return null
			const row = this.ctx.storage.sql
				.exec<{ scene_json?: string | null }>(
					'SELECT scene_json FROM excalidraw_scene_v2 WHERE id = 1',
				)
				.toArray()[0]
			if (typeof row?.scene_json !== 'string') return null
			const scene = this.parseLiveSceneJson(row.scene_json)
			return scene ? { raw: row.scene_json, scene } : null
		}
		const useScene = (raw: string | null | undefined): LiveScene | null =>
			typeof raw === 'string' ? this.parseLiveSceneJson(raw) : null
		if (columns.has('scene_json')) {
			this.sceneTableReady = true
			const row = this.ctx.storage.sql
				.exec<{
					scene_json?: string | null
					live_json?: string | null
					database_json?: string | null
					last_mutation_id?: string | null
					last_mutation_hash?: string | null
					scene_revision?: number | null
				}>(
					`SELECT scene_json${hasLegacySceneColumns ? `, ${legacySceneColumns.join(', ')}` : ''}${
						hasMutationColumns
							? ', last_mutation_id, last_mutation_hash'
							: ''
					}${this.sceneRevisionColumnReady ? ', scene_revision' : ''} FROM excalidraw_scene WHERE id = 1`,
				)
				.toArray()[0]
			this.sceneRevision =
				typeof row?.scene_revision === 'number' &&
				Number.isSafeInteger(row.scene_revision) &&
				row.scene_revision >= 0
					? row.scene_revision
					: 0
			if (hasMutationColumns) {
				this.lastMutationId = row?.last_mutation_id ?? null
				this.lastMutationHash = row?.last_mutation_hash ?? null
			}
			const canonicalRaw = [row?.scene_json, row?.live_json, row?.database_json]
				for (const raw of canonicalRaw) {
					const scene = useScene(raw)
					if (scene) {
						this.sceneCache = scene
						this.lastPersistedJson = liveSceneJson(scene)
						return scene
				}
			}
		} else if (hasLegacySceneColumns) {
			const row = this.ctx.storage.sql
				.exec<{
					live_json?: string | null
					database_json?: string | null
					last_mutation_id?: string | null
					last_mutation_hash?: string | null
				}>(
					`SELECT ${legacySceneColumns.join(', ')} FROM excalidraw_scene WHERE id = 1`,
				)
				.toArray()[0]
			const legacyScene = useScene(row?.live_json) ?? useScene(row?.database_json)
			if (legacyScene) {
				if (
					(!legacyScene.appState ||
						Object.keys(legacyScene.appState).length === 0) &&
					row?.database_json
				) {
					const database = parseDatabaseScene(row.database_json)
					if (database) legacyScene.appState = database.appState
				}
					this.sceneCache = legacyScene
					this.lastPersistedJson = liveSceneJson(legacyScene)
					return legacyScene
			}
		}

		// Some boards can be left in the temporary v2 table when a prior
		// migration was interrupted. Reading must remain write-free so a cold
		// wake can still recover the scene while Durable Object writes are capped.
		const v2 = readV2Scene()
			if (v2) {
				this.sceneCache = v2.scene
				this.lastPersistedJson = liveSceneJson(v2.scene)
			return v2.scene
		}
		this.sceneCache = { elements: [], appState: {} }
		this.lastPersistedJson = null
		return this.sceneCache
	}

	/**
	 * Existing canonical boards never execute DDL. New boards and legacy
	 * dual-column boards migrate only when a scene write is actually needed.
	 */
	private ensureSceneTableForWrite(): void {
		if (!this.sceneTableReady) {
			const columns = new Set(listSceneTableColumns(this.ctx.storage))
			if (
				columns.has('scene_json') &&
				!columns.has('live_json') &&
				!columns.has('database_json')
			) {
				this.sceneTableReady = true
			} else {
				this.sceneTableReady = migrateExcalidrawSceneTable(this.ctx.storage)
			}
		}
		if (this.sceneMutationColumnsReady && this.sceneRevisionColumnReady) return
		const columns = new Set(listSceneTableColumns(this.ctx.storage))
		try {
			if (!this.sceneMutationColumnsReady && !columns.has('last_mutation_id')) {
				this.ctx.storage.sql.exec(
					'ALTER TABLE excalidraw_scene ADD COLUMN last_mutation_id TEXT',
				)
			}
			if (!this.sceneMutationColumnsReady && !columns.has('last_mutation_hash')) {
				this.ctx.storage.sql.exec(
					'ALTER TABLE excalidraw_scene ADD COLUMN last_mutation_hash TEXT',
				)
			}
			this.sceneMutationColumnsReady = true
			if (!columns.has('scene_revision')) {
				this.ctx.storage.sql.exec(
					'ALTER TABLE excalidraw_scene ADD COLUMN scene_revision INTEGER NOT NULL DEFAULT 0',
				)
			}
			this.sceneRevisionColumnReady = true
		} catch (err) {
			throw asScenePersistError(err)
		}
	}

	private persistScene(
		scene: LiveScene,
		opts: {
			force?: boolean
			mutationId?: string | null
			mutationHash?: string | null
			sceneRevision?: number
		} = {},
	): void {
		if (scene.elements.length > MAX_SCENE_ELEMENTS) {
			throw sceneTooLargeError()
		}
		const liveJson = liveSceneJson(scene)
		if (utf8ByteLength(liveJson) > MAX_SCENE_JSON_BYTES) {
			throw sceneTooLargeError()
		}
		// Accepted element changes are passed with force=true so they are never
		// skipped, even if serialization happens to produce the same blob.
		if (
			shouldSkipIdenticalScenePersist(
				this.lastPersistedJson,
				liveJson,
				opts.force === true,
			)
		) {
			this.sceneCache = scene
			this.sceneLoaded = true
			return
		}
		const sceneRevision =
			typeof opts.sceneRevision === 'number' &&
			Number.isSafeInteger(opts.sceneRevision) &&
			opts.sceneRevision >= this.sceneRevision
				? opts.sceneRevision
				: this.sceneRevision + 1
		try {
			this.ensureSceneTableForWrite()
			this.ctx.storage.sql.exec(
				`INSERT INTO excalidraw_scene
					(id, scene_json, updated_at, last_mutation_id, last_mutation_hash, scene_revision)
				 VALUES (1, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   scene_json = excluded.scene_json,
				   updated_at = excluded.updated_at,
				   last_mutation_id = excluded.last_mutation_id,
				   last_mutation_hash = excluded.last_mutation_hash,
				   scene_revision = excluded.scene_revision`,
				liveJson,
				Date.now(),
				opts.mutationId === undefined
					? this.lastMutationId
					: opts.mutationId,
				opts.mutationHash === undefined
					? this.lastMutationHash
					: opts.mutationHash,
				sceneRevision,
			)
		} catch (err) {
			throw asScenePersistError(err)
		}
		this.lastPersistedJson = liveJson
		this.lastMutationId =
			opts.mutationId === undefined ? this.lastMutationId : opts.mutationId
		this.lastMutationHash =
			opts.mutationHash === undefined
				? this.lastMutationHash
				: opts.mutationHash
		this.sceneRevision = sceneRevision
		this.sceneCache = scene
		this.sceneLoaded = true
	}

	/**
	 * Rewrite persisted embeddable player URLs from this board's temp prefix
	 * to `google:`. No-op when none match. persistScene throws on failure;
	 * callers must not broadcast until this returns.
	 */
	private async applyTempPlayerUrlRewrite(
		boardId: string,
		googleOwnerKey: string,
	): Promise<number> {
		return this.enqueueSceneTransition(() =>
			this.applyTempPlayerUrlRewriteNow(boardId, googleOwnerKey),
		)
	}

	private async applyTempPlayerUrlRewriteNow(
		boardId: string,
		googleOwnerKey: string,
	): Promise<number> {
		this.hydrateSockets()
		const scene = await this.loadScene()
		const { elements, rewritten } = rewriteTempPlayerUrlsInElements(
			scene.elements,
			`temp:${boardId}`,
			googleOwnerKey,
		)
		if (rewritten === 0) return 0
		const nextScene: LiveScene = { elements, appState: scene.appState }
		this.persistScene(nextScene, { force: rewritten > 0 })
		this.updatesSinceFullSync = 0
		this.broadcastScene(
			{
				type: 'scene:sync',
				elements: nextScene.elements,
				appState: nextScene.appState,
				revision: this.sceneRevision,
			},
			null,
		)
		return rewritten
	}

	private async sendFullScene(ws: WebSocket): Promise<void> {
		return this.enqueueSceneTransition(() => this.sendFullSceneNow(ws))
	}

	private async sendInitialScene(ws: WebSocket): Promise<void> {
		try {
			await this.sendFullScene(ws)
		} catch (err) {
			this.closeAfterSceneHydrationFailure(ws, err)
		}
	}

	private async sendFullSceneNow(ws: WebSocket): Promise<void> {
		const scene = await this.loadScene()
		sendJson(ws, {
			type: 'scene:sync',
			elements: scene.elements,
			appState: scene.appState,
			revision: this.sceneRevision,
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
		mutationId: string | null = null,
	): void {
		logWhiteboardEvent('scene_persist_error')
		const payload = {
			type: 'wb:error' as const,
			code: error.code,
			message: error.message,
			mutationId,
			terminal: error.terminal,
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

	/** A cold scene-read failure must make the client reconnect, not strand it. */
	private closeAfterSceneHydrationFailure(ws: WebSocket, cause: unknown): void {
		const error = asScenePersistError(cause)
		protocolError(ws, error)
		try {
			ws.close(error.terminal ? 4000 : 4001, 'scene hydration failed')
		} catch {
			// Socket may already be closing.
		}
	}

	private async applySceneUpdate(
		fromSessionId: string,
		incoming: SceneElement[],
		databaseJson: string | undefined,
		full: boolean,
		mutationId: string | null,
		baseRevision?: number,
	): Promise<SceneAckStatus | null> {
		return this.enqueueSceneTransition(() =>
			this.applySceneUpdateNow(
				fromSessionId,
				incoming,
				databaseJson,
				full,
				mutationId,
				baseRevision,
			),
		)
	}

	private async applySceneUpdateNow(
		fromSessionId: string,
		incoming: SceneElement[],
		databaseJson: string | undefined,
		full: boolean,
		mutationId: string | null,
		baseRevision?: number,
	): Promise<SceneAckStatus | null> {
		const mutationHash = mutationId
			? await sha256Hex(
					JSON.stringify({
						elements: incoming,
						full,
						databaseJson: databaseJson ?? null,
						baseRevision: baseRevision ?? null,
					}),
				)
			: null
		const scene = await this.loadScene()
		if (mutationId && this.lastMutationId === mutationId) {
			if (this.lastMutationHash !== mutationHash) {
				throw sceneMalformedError(
					'The mutation ID was reused with different scene data.',
				)
			}
			return 'duplicate'
		}
		let parsedDatabase: ReturnType<typeof parseDatabaseScene> = null
		if (databaseJson !== undefined) {
			parsedDatabase = parseDatabaseScene(databaseJson)
			if (!parsedDatabase) {
				throw sceneMalformedError('The database scene is malformed.')
			}
		}
		if (incoming.length === 0 && !full && !parsedDatabase) {
			return mutationId ? 'noop' : null
		}
		const { next, accepted } = mergeSceneElements(scene.elements, incoming)
		/*
		 * Current mutation-ID clients include the scene revision they observed.
		 * Database appState is accepted only against that exact base revision;
		 * otherwise an old replay could restore a stale viewport after the latest
		 * receipt has been evicted. Rolling-deploy mutation frames without a base
		 * revision may still carry appState alongside accepted elements, while
		 * no-ID legacy appState-only frames remain compatible.
		 */
		const appStateMayApply =
			parsedDatabase !== null &&
			(mutationId === null
				? accepted.length > 0 || incoming.length === 0
				: baseRevision !== undefined
					? baseRevision === this.sceneRevision
					: accepted.length > 0)
		const appState = appStateMayApply
			? parsedDatabase?.appState ?? scene.appState
			: scene.appState
		const appStateChanged = !sameSceneAppState(scene.appState, appState)
		// A replay that lost its ack must not rewrite the row after another peer
		// has already advanced the scene. Persist an appState-only mutation only
		// when its normalized value really changed.
		if (accepted.length === 0 && !appStateChanged) {
			return mutationId ? 'noop' : null
		}
		const nextScene: LiveScene = { elements: next, appState }
		this.persistScene(nextScene, {
			force: true,
			mutationId,
			mutationHash,
			sceneRevision: this.sceneRevision + 1,
		})

		this.updatesSinceFullSync += 1
		if (full || appStateChanged || this.updatesSinceFullSync >= FULL_RESYNC_EVERY) {
			this.updatesSinceFullSync = 0
			this.broadcastScene(
				{
					type: 'scene:sync',
					elements: nextScene.elements,
					appState: nextScene.appState,
					revision: this.sceneRevision,
				},
				fromSessionId,
			)
			return mutationId ? 'applied' : null
		}

		this.broadcastScene(
			{
				type: 'scene:update',
				elements: accepted,
				full: false,
				revision: this.sceneRevision,
			},
			fromSessionId,
		)
		return mutationId ? 'applied' : null
	}

	private clerkOwnerKeys(auth: ClerkWhiteboardAuth): string[] {
		return [
			...new Set([
				auth.ownerKey,
				`google:${auth.accountId}`,
				`google:${auth.clerkUserId}`,
			]),
		].filter((key) => key.startsWith('google:') && key !== 'google:')
	}

	/** Recents/DO may store `google:{sub}` while the JWT has `google:{clerkUserId}` (or the reverse). */
	private clerkMatchesCloudOwner(
		auth: ClerkWhiteboardAuth,
		cloudOwnerKey: string | null,
	): boolean {
		if (!cloudOwnerKey) return false
		if (this.clerkOwnerKeys(auth).includes(cloudOwnerKey)) return true
		const suffix = cloudOwnerKey.startsWith('google:')
			? cloudOwnerKey.slice('google:'.length)
			: cloudOwnerKey
		if (!suffix) return false
		return (
			auth.accountId === suffix ||
			auth.clerkUserId === suffix ||
			auth.accountId === cloudOwnerKey ||
			auth.clerkUserId === cloudOwnerKey
		)
	}

	private async clerkOwnsLibraryIndex(
		auth: ClerkWhiteboardAuth,
		boardId: string,
	): Promise<boolean> {
		if (!boardId) return false
		return libraryIndexContainsBoard(this.env, this.clerkOwnerKeys(auth), boardId)
	}

	/**
	 * Recents is an R2 index, not Owner proof — except when the DO has no
	 * owner yet (pre-claim library PUT). Then Clerk + boards.json membership
	 * backfills `cloudOwnerKey`. Also rewrite google:{clerkUserId} →
	 * google:{sub}. Does not overwrite an existing Google owner.
	 */
	private async syncCloudOwnerFromClerk(
		auth: ClerkWhiteboardAuth,
		boardId: string,
	): Promise<void> {
		const current =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null

		if (this.clerkMatchesCloudOwner(auth, current)) {
			if (current !== auth.ownerKey) {
				await this.ctx.storage.put(META_CLOUD_OWNER_KEY, auth.ownerKey)
			}
			if (!(await this.isSavedToLibrary())) {
				await this.ctx.storage.put(META_SAVED_TO_LIBRARY_KEY, true)
				await this.ctx.storage.delete(META_UNSAVED_EXPIRES_AT_KEY)
			}
			return
		}

		if (current) return
		if (!(await this.clerkOwnsLibraryIndex(auth, boardId))) return

		await this.ctx.storage.put(META_CLOUD_OWNER_KEY, auth.ownerKey)
		await this.ctx.storage.put(META_SAVED_TO_LIBRARY_KEY, true)
		await this.ctx.storage.delete(META_UNSAVED_EXPIRES_AT_KEY)
	}

	// PHASE 3.3 — roles + follow (do not replace the Phase 2 scene store above)
	private async resolveConnectRole(opts: {
		clerkAuth: ClerkWhiteboardAuth | null
		guestUserId: string
		isHost: boolean
		joinedViaShareCode: boolean
		boardId: string
	}): Promise<WhiteboardRole> {
		if (opts.clerkAuth) {
			await this.syncCloudOwnerFromClerk(opts.clerkAuth, opts.boardId)
		}

		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null

		if (opts.clerkAuth) {
			if (this.clerkMatchesCloudOwner(opts.clerkAuth, cloudOwnerKey)) {
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
			// Group Edit Off must not lock the Google Owner. UUID-only guests
			// (no Clerk match, no host) stay Viewer unless they joined with the code.
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

	private roleForShareCodeJoiner(
		joinedViaShareCode: boolean,
	): WhiteboardRole {
		return joinedViaShareCode ? 'editor' : 'viewer'
	}

	private async readClassCanEdit(): Promise<boolean> {
		return (await this.ctx.storage.get<boolean>(META_CLASS_CAN_EDIT_KEY)) === true
	}

	private async setClassCanEdit(enabled: boolean): Promise<void> {
		if ((await this.readClassCanEdit()) === enabled) return
		if (enabled) {
			await this.ctx.storage.put(META_CLASS_CAN_EDIT_KEY, true)
			return
		}
		await this.ctx.storage.delete(META_CLASS_CAN_EDIT_KEY)
	}

	private async presentedJoinCodeIsActive(code: string): Promise<boolean> {
		if (!code) return false
		const active = await this.readStoredCode()
		return Boolean(active && active === code)
	}

	/**
	 * Recompute live canEdit when Group Edit changes. Does not change roles.
	 */
	private async syncLiveCanEditForClassCanEdit(): Promise<void> {
		this.hydrateSockets()
		const enabled = await this.readClassCanEdit()
		let changed = false
		for (const [sessionId, ws] of this.sessionIdToWs) {
			const prev = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			const nextCanEdit = sessionCanEdit(prev.role, enabled)
			if (prev.canEdit === nextCanEdit) continue
			const next: SocketAttachment = {
				...prev,
				canEdit: nextCanEdit,
			}
			ws.serializeAttachment(next)
			sendJson(ws, {
				type: 'wb:role',
				role: next.role,
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
		request: Request,
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		// Forwarded headers are the normal actor proof. URL credentials remain
		// only as compatibility for old internal callers.
		const actorSessionId =
			request.headers.get('X-Board-Session')?.trim() ||
			url.searchParams.get('actorSessionId')
		const actorAuth =
			request.headers.get('X-Board-Auth')?.trim() ||
			url.searchParams.get('actorAuth')
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

		const hostSecret = this.hostSecretFromRequest(request, url)
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

		const actor = await this.resolveActor(url, request)
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
					canEdit: sessionCanEdit(role, await this.readClassCanEdit()),
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

		const actor = await this.resolveActor(url, request)
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
		await Promise.all([
			this.broadcastForceFollow(),
			this.refreshFollowedFlags(),
		])
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

	private async handleFollowSubscribe(
		fromSessionId: string,
		targetSessionId: string | null,
	): Promise<void> {
		this.persistVoluntaryFollow(fromSessionId, targetSessionId)
		await this.refreshFollowedFlags()
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
	 * Proof is a live session token, scratch host secret, or Clerk Owner /
	 * stored Manager. Leftover host on a Google-owned board is not enough.
	 */
	private async resolveShareCodeActor(
		request: Request,
		url: URL,
	): Promise<{ role: WhiteboardRole; userId: string; sessionId: string } | null> {
		const fromLive = await this.resolveActor(url, request)
		if (fromLive) return fromLive
		return this.resolveClerkOwnerOrManager(request, url)
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

		if (request.method === 'GET' || request.method === 'POST') {
			try {
				const state = await this.ensureShareCode(boardId)
				return json(200, { code: state?.code ?? null })
			} catch (err) {
				const message =
					err instanceof Error ? err.message : 'Could not create share code'
				const status = message.includes('Rate limit') ? 429 : 503
				return json(status, { error: message })
			}
		}

		if (request.method === 'DELETE') {
			await this.revokeActiveCode()
			return json(200, { code: null })
		}

		return json(405, { error: 'Method not allowed' })
	}

	private async persistShareCodeKv(code: string, boardId: string): Promise<void> {
		if (!this.env.WHITEBOARD_CODES) return
		await this.env.WHITEBOARD_CODES.put(
			kvCodeKey(code),
			JSON.stringify({ boardId }),
		)
	}

	private async readStoredCode(): Promise<string | null> {
		const code = await this.ctx.storage.get<string>(ACTIVE_CODE_KEY)
		if (!code || !normalizeShareCode(code)) return null
		return code
	}

	/** Run one share-code state transition after all earlier transitions settle. */
	private enqueueShareCodeTransition<T>(
		transition: () => Promise<T>,
	): Promise<T> {
		const run = this.shareCodeTransition.then(transition, transition)
		this.shareCodeTransition = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	/**
	 * Mint once if missing. Existing codes (including leftover 4-character)
	 * are kept and rewritten to KV without TTL.
	 */
	private async ensureShareCode(boardId: string): Promise<CodeState | null> {
		if (!this.env.WHITEBOARD_CODES || !boardId) return null
		const transitionVersion = this.shareCodeTransitionVersion
		return this.enqueueShareCodeTransition(() =>
			this.ensureShareCodeOnce(boardId, transitionVersion),
		)
	}

	private async ensureShareCodeOnce(
		boardId: string,
		transitionVersion: number,
	): Promise<CodeState | null> {
		if (transitionVersion !== this.shareCodeTransitionVersion) return null
		const existing = await this.readStoredCode()
		if (existing) {
			if (transitionVersion !== this.shareCodeTransitionVersion) return null
			const expiresAt = await this.ctx.storage.get(CODE_EXPIRES_AT_KEY)
			if (transitionVersion !== this.shareCodeTransitionVersion) return null
			if (expiresAt != null) {
				await this.ctx.storage.delete(CODE_EXPIRES_AT_KEY)
			}
			if (transitionVersion !== this.shareCodeTransitionVersion) return null
			return { code: existing }
		}
		return this.mintPermanentCode(boardId, transitionVersion)
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

	private async mintPermanentCode(
		boardId: string,
		transitionVersion: number,
	): Promise<CodeState | null> {
		await this.assertMintAllowed()
		if (transitionVersion !== this.shareCodeTransitionVersion) return null

		for (let i = 0; i < MINT_SAMPLE_ATTEMPTS; i++) {
			const candidate = sampleShareCode()
			const key = kvCodeKey(candidate)
			const clashRaw = await this.env.WHITEBOARD_CODES.get(key)
			if (transitionVersion !== this.shareCodeTransitionVersion) return null
			if (clashRaw) {
				const clash = parseShareCodeRecord(clashRaw)
				if (clash?.boardId === boardId) {
					return this.commitMintedCode(
						candidate,
						boardId,
						transitionVersion,
					)
				}
				continue
			}

			return this.commitMintedCode(candidate, boardId, transitionVersion)
		}

		throw new Error('Could not allocate a free share code. Try again.')
	}

	private async commitMintedCode(
		candidate: string,
		boardId: string,
		transitionVersion: number,
	): Promise<CodeState | null> {
		let mappingMayExist = true
		const rollback = async (): Promise<void> => {
			if (!mappingMayExist) return
			// Mark it handled before awaiting cleanup so a cleanup failure is not
			// accidentally retried by the catch path. The failed transition must
			// reject; callers cannot retry while compensation is still pending.
			mappingMayExist = false
			await this.compensateMint(candidate)
		}
		try {
			await this.persistShareCodeKv(candidate, boardId)
			if (transitionVersion !== this.shareCodeTransitionVersion) {
				await rollback()
				return null
			}
			// The storage write can fail ambiguously after committing. Compensation
			// therefore removes both the exact KV mapping and a matching active key.
			await this.ctx.storage.put(ACTIVE_CODE_KEY, candidate)
			await this.ctx.storage.delete(CODE_EXPIRES_AT_KEY)
			if (transitionVersion !== this.shareCodeTransitionVersion) {
				await rollback()
				return null
			}
			mappingMayExist = false
			return { code: candidate }
		} catch (error) {
			try {
				await rollback()
			} catch (cleanupError) {
				throw cleanupError
			}
			throw error
		}
	}

	private async compensateMint(candidate: string): Promise<void> {
		if (this.env.WHITEBOARD_CODES) {
			await this.env.WHITEBOARD_CODES.delete(kvCodeKey(candidate))
		}
		const active = await this.ctx.storage.get<string>(ACTIVE_CODE_KEY)
		if (normalizeShareCode(active ?? '') === candidate) {
			await this.ctx.storage.delete(ACTIVE_CODE_KEY)
			await this.ctx.storage.delete(CODE_EXPIRES_AT_KEY)
		}
	}

	private async revokeActiveCode(): Promise<void> {
		this.shareCodeTransitionVersion += 1
		await this.enqueueShareCodeTransition(() =>
			this.clearActiveCodeKeys(),
		)
		await this.scheduleNextAlarm()
	}

	private async clearActiveCodeKeys(): Promise<void> {
		const code = await this.ctx.storage.get<string>(ACTIVE_CODE_KEY)
		if (code && this.env.WHITEBOARD_CODES) {
			await this.env.WHITEBOARD_CODES.delete(kvCodeKey(code))
		}
		await this.ctx.storage.delete(ACTIVE_CODE_KEY)
		await this.ctx.storage.delete(CODE_EXPIRES_AT_KEY)
	}

	/**
	 * Durable Objects have one alarm. Fire unsaved 24h TTL; the handler
	 * reschedules whatever is still pending.
	 */
	private async scheduleNextAlarm(): Promise<void> {
		const times: number[] = []
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
			let existing: number | null = null
			try {
				existing = (await this.ctx.storage.getAlarm()) ?? null
			} catch {
				existing = null
			}
			if (existing == null) return
			try {
				await this.ctx.storage.deleteAlarm()
			} catch {
				// no alarm set
			}
			return
		}
		const target = Math.min(...times)
		let existing: number | null = null
		try {
			existing = (await this.ctx.storage.getAlarm()) ?? null
		} catch {
			existing = null
		}
		if (!shouldReplaceStorageAlarm(existing, target)) {
			return
		}
		await this.ctx.storage.setAlarm(target)
	}

	private async expireUnsavedBoard(): Promise<void> {
		return this.enqueueSceneTransition(() => this.expireUnsavedBoardNow())
	}

	private async expireUnsavedBoardNow(): Promise<void> {
		this.shareCodeTransitionVersion += 1
		const clearCode = this.enqueueShareCodeTransition(() =>
			this.clearActiveCodeKeys(),
		)
		this.ctx.storage.sql.exec('DELETE FROM excalidraw_scene')
		this.sceneCache = { elements: [], appState: {} }
		this.sceneLoaded = true
		this.lastPersistedJson = null
		this.sceneRevision = 0
		this.lastMutationId = null
		this.lastMutationHash = null
		await this.cleanupTempAssets()
		await clearCode
		await this.ctx.storage.delete(META_UNSAVED_EXPIRES_AT_KEY)
		await this.ctx.storage.delete(META_CREATED_AT_KEY)
		this.broadcastScene(
			{ type: 'scene:sync', elements: [], appState: {}, revision: 0 },
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

	/** Unsaved boards (24h). Share codes do not expire. */
	override async alarm(): Promise<void> {
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
		const sessionId = attachment?.sessionId ?? null
		return isValidConnectSessionId(sessionId) ? sessionId : null
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		this.hydrateSockets()
		this.pruneExpiredPendingSockets()
		await this.restoreFollowAfterWake()
		const sessionId = this.getSessionId(ws)
		if (!sessionId) return
		this.sessionIdToWs.set(sessionId, ws)
		let rawMessage: string
		if (typeof message === 'string') {
			if (utf8ByteLength(message) > MAX_SCENE_FRAME_BYTES) {
				protocolError(ws, sceneTooLargeError())
				return
			}
			rawMessage = message
		} else {
			if (message.byteLength > MAX_SCENE_FRAME_BYTES) {
				protocolError(ws, sceneTooLargeError())
				return
			}
			try {
				rawMessage = new TextDecoder('utf-8', { fatal: true }).decode(message)
			} catch {
				protocolError(ws, sceneMalformedError('The WebSocket frame is not valid UTF-8.'))
				return
			}
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(rawMessage)
		} catch {
			protocolError(ws, sceneMalformedError('The WebSocket frame is not valid JSON.'))
			return
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			protocolError(ws, sceneMalformedError())
			return
		}
		const data = parsed as Record<string, unknown>
		const attachment = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			sessionId,
		)
		if (attachment.pendingClerkAuth) {
			if (data.type !== 'wb:auth') {
				// Scene/ping/follow must not mint Owner or lock Viewer before
				// Clerk + host proof arrive. Drop until `wb:auth`.
				return
			}
			await this.finishPendingConnectAuth(ws, attachment, data)
			return
		}
		const type = data.type
		if (type === 'wb:auth') {
			await this.reauthenticateSocket(ws, attachment, data)
			return
		}

		if (type === 'scene:request') {
			try {
				await this.sendFullScene(ws)
			} catch (err) {
				this.closeAfterSceneHydrationFailure(ws, err)
			}
			return
		}

		if (type === 'wb:follow') {
			const targetSessionId =
				typeof data.targetSessionId === 'string' && data.targetSessionId
					? data.targetSessionId
					: null
			await this.handleFollowSubscribe(sessionId, targetSessionId)
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
			const rawMutationId = data.mutationId
			const mutationId =
				rawMutationId === undefined
					? null
					: isMutationId(rawMutationId)
						? rawMutationId
						: null
			if (rawMutationId !== undefined && !mutationId) {
				protocolError(ws, sceneMalformedError('The mutation ID is invalid.'))
				return
			}
			// PHASE 3.3: Viewers and frozen Editors cannot mutate the document.
			if (!sessionCanEdit(attachment.role, await this.readClassCanEdit())) {
				protocolError(ws, sceneEditNotAllowedError(), mutationId)
				return
			}
			const allowedKeys = new Set([
				'type',
				'elements',
				'full',
				'databaseJson',
				'mutationId',
				'baseRevision',
			])
			if (Object.keys(data).some((key) => !allowedKeys.has(key))) {
				protocolError(ws, sceneMalformedError())
				return
			}
			if ('full' in data && typeof data.full !== 'boolean') {
				protocolError(ws, sceneMalformedError('The full flag is invalid.'), mutationId)
				return
			}
			if ('databaseJson' in data && typeof data.databaseJson !== 'string') {
				protocolError(ws, sceneMalformedError('The database scene is invalid.'), mutationId)
				return
			}
			if (
				'baseRevision' in data &&
				(typeof data.baseRevision !== 'number' ||
					!Number.isSafeInteger(data.baseRevision) ||
					data.baseRevision < 0)
			) {
				protocolError(
					ws,
					sceneMalformedError('The scene revision is invalid.'),
					mutationId,
				)
				return
			}
			try {
				if (
					typeof data.databaseJson === 'string' &&
					utf8ByteLength(data.databaseJson) > MAX_SCENE_JSON_BYTES
				) {
					throw sceneTooLargeError()
				}
				const elements = parseSceneElements(data.elements)
				const databaseJson =
					typeof data.databaseJson === 'string'
						? data.databaseJson
						: undefined
				if (
					databaseJson !== undefined &&
					!parseDatabaseScene(databaseJson)
				) {
					throw sceneMalformedError('The database scene is malformed.')
				}
					await this.enqueueSceneTransition(async () => {
						try {
							const status = await this.applySceneUpdateNow(
								sessionId,
								elements,
								databaseJson,
								data.full === true,
								mutationId,
								typeof data.baseRevision === 'number'
									? data.baseRevision
									: undefined,
							)
							if (mutationId && status) {
								sendJson(ws, {
									type: 'scene:ack',
									mutationId,
									status,
									revision: this.sceneRevision,
								})
							}
						} catch (err) {
							this.notifyScenePersistError(
								sessionId,
								asScenePersistError(err),
								mutationId,
							)
						}
					})
				} catch (err) {
					// The queued operation handles expected scene persistence errors;
					// this guard only covers an unexpected queue failure.
					this.notifyScenePersistError(
						sessionId,
						asScenePersistError(err),
						mutationId,
					)
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
		await this.handleWebSocketEnd(ws)
	}

	override async webSocketError(ws: WebSocket) {
		await this.handleWebSocketEnd(ws)
	}

	private async handleWebSocketEnd(ws: WebSocket): Promise<void> {
		this.hydrateSockets()
		const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
		if (!raw?.sessionId) return
		this.sessionIdToWs.delete(raw.sessionId)
		this.persistVoluntaryFollow(raw.sessionId, null)
		for (const [follower, target] of [...this.voluntaryFollow]) {
			if (target === raw.sessionId) this.persistVoluntaryFollow(follower, null)
		}
		this.broadcastParticipants()
		await this.refreshFollowedFlags()
	}
}
