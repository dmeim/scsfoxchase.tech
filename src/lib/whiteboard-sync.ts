/**
 * Excalidraw live-collab protocol (Phase 2).
 *
 * Shared by the Durable Object and the board island. Do not import
 * `@excalidraw/excalidraw` here — that package is client-only and would
 * bloat the Worker bundle.
 *
 * Storage keys below are the Phase 3 hook: hub save sets `savedToLibrary`
 * to lift the 24h unsaved TTL; roles attach to the ephemeral-owner hello.
 */

export const UNSAVED_BOARD_TTL_MS = 24 * 60 * 60 * 1000
export const SCENE_FLUSH_MS = 1000
export const CLIENT_PING_MS = 25_000
export const FULL_RESYNC_EVERY = 20

export type SceneBroadcastPlan = {
	type: 'scene:sync' | 'scene:update'
	exceptSessionId: string
}

/**
 * Full scene:sync (explicit full or FULL_RESYNC_EVERY) and incremental
 * scene:update both exclude the writer so the originating tab is not echoed.
 */
export function sceneBroadcastPlan(input: {
	full: boolean
	updatesSinceFullSync: number
	fromSessionId: string
	fullResyncEvery?: number
}): SceneBroadcastPlan {
	const every = input.fullResyncEvery ?? FULL_RESYNC_EVERY
	if (input.full || input.updatesSinceFullSync >= every) {
		return { type: 'scene:sync', exceptSessionId: input.fromSessionId }
	}
	return { type: 'scene:update', exceptSessionId: input.fromSessionId }
}

/**
 * Idle 30s full flush: skip when the scene version has not moved past both
 * the last ack and the last full send. `persistFailedNeedsRetry` must bypass
 * that watermark so a `persist_failed` can retry the same version.
 */
export function shouldSkipIdleFullFlush(input: {
	sceneVersion: number
	acknowledgedVersion: number
	lastSentFullFlushVersion: number
	persistFailedNeedsRetry?: boolean
}): boolean {
	if (input.persistFailedNeedsRetry) return false
	return (
		input.sceneVersion <=
		Math.max(input.acknowledgedVersion, input.lastSentFullFlushVersion)
	)
}

export const MAX_SCENE_ELEMENTS = 4000
export const MAX_SCENE_JSON_BYTES = 2_000_000
export const SCENE_TOO_LARGE_CODE = 'scene_too_large' as const
export const SCENE_PERSIST_FAILED_CODE = 'persist_failed' as const
export const SCENE_TOO_LARGE_MESSAGE =
	'This board is too large to save. The last change was not stored.'
export const SCENE_PERSIST_FAILED_MESSAGE =
	'Could not save this board. The last change was not stored.'

export type SceneErrorCode =
	| typeof SCENE_TOO_LARGE_CODE
	| typeof SCENE_PERSIST_FAILED_CODE

export type SceneErrorMessage = {
	type: 'wb:error'
	code: SceneErrorCode
	message: string
	/** Present when the error rejected a mutation from a current client. */
	mutationId?: string
}

export class ScenePersistError extends Error {
	readonly code: SceneErrorCode
	constructor(code: SceneErrorCode, message: string) {
		super(message)
		this.name = 'ScenePersistError'
		this.code = code
	}
}

export function sceneTooLargeError(): ScenePersistError {
	return new ScenePersistError(SCENE_TOO_LARGE_CODE, SCENE_TOO_LARGE_MESSAGE)
}

export function asScenePersistError(err: unknown): ScenePersistError {
	if (err instanceof ScenePersistError) return err
	return new ScenePersistError(
		SCENE_PERSIST_FAILED_CODE,
		SCENE_PERSIST_FAILED_MESSAGE,
	)
}

/** DO storage: first secret to connect is ephemeral Owner (Phase 3 roles). */
export const META_HOST_SECRET_HASH_KEY = 'meta:hostSecretHash'
export const META_SAVED_TO_LIBRARY_KEY = 'meta:savedToLibrary'
export const META_CLOUD_OWNER_KEY = 'meta:cloudOwnerKey'
export const META_TEMP_ASSET_PREFIX_KEY = 'meta:tempAssetPrefix'
export const META_UNSAVED_EXPIRES_AT_KEY = 'meta:unsavedExpiresAt'
export const META_CREATED_AT_KEY = 'meta:createdAt'
export const META_BOARD_ID_KEY = 'meta:boardId'
/** Owner/Manager: live draw gate — Editors may draw only when true. */
export const META_CLASS_CAN_EDIT_KEY = 'meta:classCanEdit'

export type SceneElement = {
	id: string
	version: number
	versionNonce: number
	isDeleted?: boolean
	[key: string]: unknown
}

export type SceneAppState = Record<string, unknown>

export type DatabaseScene = {
	type: 'excalidraw'
	version: number
	source: string
	elements: SceneElement[]
	appState: SceneAppState
}

export type OwnerHook = {
	/** Scratch boards are ephemeral until Phase 3 claims a Google Owner. */
	kind: 'ephemeral' | 'google'
	/** `google:` prefix on can-edit hello; Viewers get null. */
	cloudOwnerKey: string | null
	isHost: boolean
}

// PHASE 3.3
export const WHITEBOARD_ROLES = [
	'owner',
	'manager',
	'editor',
	'viewer',
] as const
export type WhiteboardRole = (typeof WHITEBOARD_ROLES)[number]
export type AssignableRole = Exclude<WhiteboardRole, 'owner'>

export function isWhiteboardRole(value: unknown): value is WhiteboardRole {
	return (
		value === 'owner' ||
		value === 'manager' ||
		value === 'editor' ||
		value === 'viewer'
	)
}

export function isAssignableRole(value: unknown): value is AssignableRole {
	return value === 'manager' || value === 'editor' || value === 'viewer'
}

export function roleCanEdit(role: WhiteboardRole): boolean {
	return role === 'owner' || role === 'manager' || role === 'editor'
}

const WHITEBOARD_ROLE_RANK: Record<WhiteboardRole, number> = {
	viewer: 0,
	editor: 1,
	manager: 2,
	owner: 3,
}

/**
 * Repeatable `wb:auth` after hello: apply `wb:role` for upgrades and for
 * Clerk identity attaching to an already-editable session. Never demote.
 */
export function shouldApplySocketReauth(
	current: {
		role: WhiteboardRole
		userId: string
		isHost: boolean
		displayName: string
	},
	next: {
		role: WhiteboardRole
		userId: string
		isHost: boolean
		displayName: string
	},
): boolean {
	if (WHITEBOARD_ROLE_RANK[next.role] < WHITEBOARD_ROLE_RANK[current.role]) {
		return false
	}
	return (
		next.role !== current.role ||
		next.userId !== current.userId ||
		next.isHost !== current.isHost ||
		next.displayName !== current.displayName
	)
}

export const ROLE_RESOLVE_DEADLINE_MS = 15_000

export type WbAuthReason =
	| 'awaiting_token'
	| 'token_invalid'
	| 'clerk_unreachable'
	| 'account_not_allowed'
	| 'host_mismatch'

export const WB_AUTH_REASONS: readonly WbAuthReason[] = [
	'awaiting_token',
	'token_invalid',
	'clerk_unreachable',
	'account_not_allowed',
	'host_mismatch',
]

export function isWbAuthReason(value: unknown): value is WbAuthReason {
	return (
		value === 'awaiting_token' ||
		value === 'token_invalid' ||
		value === 'clerk_unreachable' ||
		value === 'account_not_allowed' ||
		value === 'host_mismatch'
	)
}

export type ClerkVerifyFailureReason =
	| 'no_token'
	| 'token_invalid'
	| 'clerk_unreachable'
	| 'account_not_allowed'

export type WbAuthOutcome = {
	roleResolved: boolean
	reason?: WbAuthReason
}

/**
 * Maps a Clerk token check onto whether this socket's role is authoritative.
 * Empty-email / allowlist is handled before this; `no_token` falls through to
 * the signed-in-without-JWT path so a missing JWT is never a hard denial.
 */
export function resolveWbAuthOutcome(input: {
	signedIn: boolean
	roleCanEdit: boolean
	tokenResult?:
		| { ok: true; profileDegraded: boolean }
		| { ok: false; reason: ClerkVerifyFailureReason }
	hostSecretPresented?: boolean
	hostAccepted?: boolean
}): WbAuthOutcome {
	const tokenResult = input.tokenResult
	if (tokenResult && !(tokenResult.ok === false && tokenResult.reason === 'no_token')) {
		if (!tokenResult.ok) {
			if (tokenResult.reason === 'token_invalid') {
				if (input.roleCanEdit) return { roleResolved: true }
				return { roleResolved: true, reason: 'token_invalid' }
			}
			if (tokenResult.reason === 'account_not_allowed') {
				if (input.roleCanEdit) return { roleResolved: true }
				return { roleResolved: true, reason: 'account_not_allowed' }
			}
			if (input.roleCanEdit) return { roleResolved: true }
			return { roleResolved: false, reason: 'clerk_unreachable' }
		}
		if (tokenResult.profileDegraded && !input.roleCanEdit) {
			return { roleResolved: false, reason: 'clerk_unreachable' }
		}
		return { roleResolved: true }
	}

	if (input.signedIn && !input.roleCanEdit) {
		return { roleResolved: false, reason: 'awaiting_token' }
	}

	if (input.hostSecretPresented && !input.hostAccepted && !input.signedIn) {
		return { roleResolved: true, reason: 'host_mismatch' }
	}

	return { roleResolved: true }
}

export function shouldForceRoleResolved(input: {
	roleResolved: boolean
	connectedAt: number
	now: number
	deadlineMs?: number
}): boolean {
	if (input.roleResolved) return false
	const deadline = input.deadlineMs ?? ROLE_RESOLVE_DEADLINE_MS
	return input.now - input.connectedAt > deadline
}

/** Retry while the role is unresolved, even if a JWT was already sent. */
export function shouldRetryWhiteboardAuth(input: {
	roleResolved: boolean
	tokenAlreadySent: boolean
}): boolean {
	return !input.roleResolved
}

export type AuthResultMessage = {
	type: 'wb:authResult'
	accepted: boolean
	roleResolved: boolean
	role: WhiteboardRole
	reason?: WbAuthReason
}

/** Live canvas writes: Owner/Manager always; Editor only while Group Edit is on. */
export function sessionCanEdit(
	role: WhiteboardRole,
	classCanEdit: boolean,
): boolean {
	if (role === 'owner' || role === 'manager') return true
	if (role === 'editor') return classCanEdit
	return false
}

/** Who `actor` may assign to `target`'s current role. Null = no Roles UI. */
export function assignableRolesFor(
	actor: WhiteboardRole,
	target: WhiteboardRole,
): AssignableRole[] | null {
	if (target === 'owner') return null
	if (actor === 'owner') return ['manager', 'editor', 'viewer']
	if (actor === 'manager') {
		if (target === 'manager') return null
		return ['editor', 'viewer']
	}
	return null
}

export function canAssignRole(
	actor: WhiteboardRole,
	targetCurrent: WhiteboardRole,
	next: WhiteboardRole,
): boolean {
	if (next === 'owner') return false
	const allowed = assignableRolesFor(actor, targetCurrent)
	return Boolean(allowed && isAssignableRole(next) && allowed.includes(next))
}

export type HelloMessage = {
	type: 'wb:hello'
	sessionId: string
	isHost: boolean
	canEdit: boolean
	savedToLibrary: boolean
	owner: OwnerHook
	/** Live room name. Recents/Library is only an index of this value. */
	title: string
	/** When true, Editors may draw. Owner/Manager always may. */
	classCanEdit: boolean
	// PHASE 3.3
	role: WhiteboardRole
	authToken: string
	/** False until Clerk/host proof settles; omitted by older servers. */
	roleResolved?: boolean
}

export type BoardPublicMeta = {
	savedToLibrary: boolean
	/** Can-edit live session or Clerk Owner/Manager/Editor. Unsigned GET: null. */
	cloudOwnerKey: string | null
	createdAt: string | null
	unsavedExpiresAt: string | null
	title: string
	owner: OwnerHook
	classCanEdit: boolean
}

/** First WebSocket message: Clerk JWT and optional scratch host proof. Never put these on the query string. */
export type ConnectAuthMessage = {
	type: 'wb:auth'
	token?: string
	/** Creating-browser scratch Owner proof. Omit after Google claim / `savedToLibrary`. */
	hostSecret?: string
}

/** Guest connect `userId` is a device-install UUID only — never a Google account id. */
export const GUEST_CONNECT_USER_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isGuestConnectUserId(value: string): boolean {
	const id = value.trim()
	if (!id || /^google:/i.test(id)) return false
	return GUEST_CONNECT_USER_ID_RE.test(id)
}

export type FollowSubscribeMessage = {
	type: 'wb:follow'
	targetUserId: string | null
	targetSessionId: string | null
}

export type SceneBoundsMessage = {
	type: 'wb:sceneBounds'
	socketId: string
	bounds: [number, number, number, number]
}

export type SceneSyncMessage = {
	type: 'scene:sync'
	elements: SceneElement[]
	appState: SceneAppState
}

export type SceneUpdateMessage = {
	type: 'scene:update'
	elements: SceneElement[]
	full?: boolean
	databaseJson?: string
	/** Optional client mutation id; old clients omit it. */
	mutationId?: string
}

export type SceneAckMessage = {
	type: 'scene:ack'
	mutationId: string
}

export type SceneRequestMessage = {
	type: 'scene:request'
}

export function isSceneElement(value: unknown): value is SceneElement {
	if (!value || typeof value !== 'object') return false
	const el = value as Record<string, unknown>
	return (
		typeof el.id === 'string' &&
		el.id.length > 0 &&
		el.id.length <= 64 &&
		typeof el.version === 'number' &&
		Number.isFinite(el.version) &&
		typeof el.versionNonce === 'number' &&
		Number.isFinite(el.versionNonce)
	)
}

function collectSceneElements(
	value: unknown,
	max: number,
): { elements: SceneElement[]; overflow: boolean } {
	if (!Array.isArray(value)) return { elements: [], overflow: false }
	const out: SceneElement[] = []
	let overflow = false
	for (const item of value) {
		if (!isSceneElement(item)) continue
		if (out.length >= max) {
			overflow = true
			break
		}
		out.push(item)
	}
	return { elements: out, overflow }
}

/**
 * Parse an incoming editor payload. Overflow is an error — callers must not
 * persist or broadcast a silently trimmed scene.
 */
export function parseSceneElements(value: unknown): SceneElement[] {
	const { elements, overflow } = collectSceneElements(
		value,
		MAX_SCENE_ELEMENTS,
	)
	if (overflow) throw sceneTooLargeError()
	return elements
}

/** Load path: do not drop stored work if a board already exceeds the cap. */
export function parseStoredSceneElements(value: unknown): SceneElement[] {
	return collectSceneElements(value, Number.MAX_SAFE_INTEGER).elements
}

/** Last-write-wins by version, then versionNonce (same idea as reconcileElements). */
export function elementWins(
	incoming: SceneElement,
	existing: SceneElement,
): boolean {
	if (incoming.version !== existing.version) {
		return incoming.version > existing.version
	}
	return incoming.versionNonce > existing.versionNonce
}

export function mergeSceneElements(
	existing: SceneElement[],
	incoming: SceneElement[],
): { next: SceneElement[]; accepted: SceneElement[] } {
	const map = new Map<string, SceneElement>()
	for (const el of existing) map.set(el.id, el)
	const accepted: SceneElement[] = []
	for (const el of incoming) {
		const prev = map.get(el.id)
		if (!prev || elementWins(el, prev)) {
			map.set(el.id, el)
			accepted.push(el)
		}
	}
	return { next: [...map.values()], accepted }
}

export function elementsWithIncreasedVersion(
	elements: readonly SceneElement[],
	lastSeen: Map<string, number>,
): SceneElement[] {
	const dirty: SceneElement[] = []
	for (const el of elements) {
		const prev = lastSeen.get(el.id)
		if (prev === undefined || el.version > prev) {
			dirty.push(el)
		}
	}
	return dirty
}

export function rememberElementVersions(
	elements: readonly SceneElement[],
	lastSeen: Map<string, number>,
): void {
	for (const el of elements) {
		const prev = lastSeen.get(el.id)
		if (prev === undefined || el.version > prev) {
			lastSeen.set(el.id, el.version)
		}
	}
}

export function toDatabaseScene(
	elements: SceneElement[],
	appState: SceneAppState,
): DatabaseScene {
	return {
		type: 'excalidraw',
		version: 2,
		source: 'https://scsfoxchase.tech',
		elements: elements.filter((el) => !el.isDeleted),
		appState,
	}
}

export function parseDatabaseScene(raw: string): DatabaseScene | null {
	if (raw.length > MAX_SCENE_JSON_BYTES) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		const data = parsed as Record<string, unknown>
		if (data.type !== 'excalidraw') return null
		const { elements, overflow } = collectSceneElements(
			data.elements,
			MAX_SCENE_ELEMENTS,
		)
		if (overflow) return null
		const appState =
			data.appState && typeof data.appState === 'object'
				? (data.appState as SceneAppState)
				: {}
		return {
			type: 'excalidraw',
			version: typeof data.version === 'number' ? data.version : 2,
			source:
				typeof data.source === 'string'
					? data.source
					: 'https://scsfoxchase.tech',
			elements,
			appState,
		}
	} catch {
		return null
	}
}

export function stringifyDatabaseScene(scene: DatabaseScene): string {
	return JSON.stringify(scene)
}

export function buildWhiteboardConnectUrl(
	origin: string,
	opts: {
		boardId: string
		sessionId: string
		displayName: string
		userId: string
	},
): string {
	const url = new URL(
		`/api/whiteboard/connect/${encodeURIComponent(opts.boardId)}`,
		origin,
	)
	url.searchParams.set('sessionId', opts.sessionId)
	if (opts.displayName) url.searchParams.set('displayName', opts.displayName)
	const guestUserId = opts.userId.trim()
	if (guestUserId && isGuestConnectUserId(guestUserId)) {
		url.searchParams.set('userId', guestUserId)
	}
	return url.toString()
}

export function boardSessionStorageKey(boardId: string): string {
	return `scsfoxchase.whiteboard.session.${boardId}`
}

export function getOrCreateSessionId(boardId: string): string {
	if (typeof sessionStorage === 'undefined') return crypto.randomUUID()
	try {
		const existing = sessionStorage.getItem(boardSessionStorageKey(boardId))
		if (existing) return existing
		const id = crypto.randomUUID()
		sessionStorage.setItem(boardSessionStorageKey(boardId), id)
		return id
	} catch {
		return crypto.randomUUID()
	}
}
