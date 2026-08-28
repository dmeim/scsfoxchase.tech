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
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 60_000
export const FULL_RESYNC_EVERY = 20
export const MAX_SCENE_ELEMENTS = 4000
export const MAX_SCENE_JSON_BYTES = 2_000_000
/**
 * A scene update may contain one bounded live scene and one bounded database
 * scene, plus a small JSON envelope. Keep the pre-parse guard below that
 * combined worst case while leaving room for envelope/UTF-8 overhead.
 */
export const MAX_SCENE_FRAME_BYTES =
	MAX_SCENE_JSON_BYTES * 2 + 128 * 1024
export const SCENE_TOO_LARGE_CODE = 'scene_too_large' as const
export const SCENE_PERSIST_FAILED_CODE = 'persist_failed' as const
export const SCENE_MALFORMED_CODE = 'malformed_scene' as const
export const SCENE_TOO_LARGE_MESSAGE =
	'This board is too large to save. The last change was not stored.'
export const SCENE_PERSIST_FAILED_MESSAGE =
	'Could not save this board. The last change was not stored.'
export const SCENE_MALFORMED_MESSAGE =
	'This board update was invalid and was not stored.'

/** Exponential reconnect backoff with a one-minute outage ceiling. */
export function reconnectDelayMs(attempt: number): number {
	const safeAttempt = Number.isFinite(attempt)
		? Math.max(0, Math.min(30, Math.floor(attempt)))
		: 0
	return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** safeAttempt)
}

export type SceneErrorCode =
	| typeof SCENE_TOO_LARGE_CODE
	| typeof SCENE_PERSIST_FAILED_CODE
	| typeof SCENE_MALFORMED_CODE

export type SceneErrorMessage = {
	type: 'wb:error'
	code: SceneErrorCode
	message: string
	mutationId: string | null
	terminal: boolean
}

export class ScenePersistError extends Error {
	readonly code: SceneErrorCode
	readonly terminal: boolean
	constructor(
		code: SceneErrorCode,
		message: string,
		terminal = code !== SCENE_PERSIST_FAILED_CODE,
	) {
		super(message)
		this.name = 'ScenePersistError'
		this.code = code
		this.terminal = terminal
	}
}

export function sceneTooLargeError(): ScenePersistError {
	return new ScenePersistError(SCENE_TOO_LARGE_CODE, SCENE_TOO_LARGE_MESSAGE)
}

export function sceneMalformedError(
	message = SCENE_MALFORMED_MESSAGE,
): ScenePersistError {
	return new ScenePersistError(SCENE_MALFORMED_CODE, message)
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
	/** Monotonic scene revision used to order database appState writes. */
	revision?: number
}

export type SceneUpdateMessage = {
	type: 'scene:update'
	elements: SceneElement[]
	/** Required for new clients; omitted only for rolling-deploy compatibility. */
	mutationId?: string
	full?: boolean
	databaseJson?: string
	/** Revision observed by the sender before creating this mutation. */
	baseRevision?: number
	/** Server revision on broadcasts; absent on rolling-deploy peers. */
	revision?: number
}

/** The wire payload used by current clients for one durable mutation. */
export type SceneMutationFrame = {
	type: 'scene:update'
	mutationId: string
	elements: readonly SceneElement[]
	full: boolean
	databaseJson?: string
	/** Required for appState ordering by current clients. */
	baseRevision?: number
}

/** Mutable-ref state for the client outbox; one flight plus one latest queue. */
export type SceneOutboxState<InFlight, Pending> = {
	inFlight: InFlight | null
	pending: Pending | null
}

export function sceneOutboxStart<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
	inFlight: InFlight,
): SceneOutboxState<InFlight, Pending> {
	if (state.inFlight !== null) return state
	return { inFlight, pending: null }
}

/** Keep only the newest local snapshot while a mutation is in flight. */
export function sceneOutboxQueue<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
	pending: Pending,
): SceneOutboxState<InFlight, Pending> {
	return { inFlight: state.inFlight, pending }
}

/** An ack retires only its matching immutable flight; pending remains queued. */
export function sceneOutboxAcknowledge<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
	matches: (inFlight: InFlight) => boolean,
): SceneOutboxState<InFlight, Pending> {
	if (state.inFlight === null || !matches(state.inFlight)) return state
	return { inFlight: null, pending: state.pending }
}

/** Transient persistence failure/reconnect: retain both flight and pending. */
export function sceneOutboxRetry<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
): SceneOutboxState<InFlight, Pending> {
	return state
}

/** Replay exactly the immutable flight on a new socket. */
export function sceneOutboxReplay<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
): InFlight | null {
	return state.inFlight
}

/** Terminal preflight/protocol failure drops only the rejected flight. */
export function sceneOutboxTerminalFailure<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
): SceneOutboxState<InFlight, Pending> {
	return { inFlight: null, pending: state.pending }
}

export function sceneOutboxClearPending<InFlight, Pending>(
	state: SceneOutboxState<InFlight, Pending>,
): SceneOutboxState<InFlight, Pending> {
	return { inFlight: state.inFlight, pending: null }
}

export type SceneAckStatus = 'applied' | 'duplicate' | 'noop'

export type SceneAckMessage = {
	type: 'scene:ack'
	mutationId: string
	status: SceneAckStatus
	revision?: number
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
		Number.isSafeInteger(el.version) &&
		el.version >= 0 &&
		typeof el.versionNonce === 'number' &&
		Number.isSafeInteger(el.versionNonce) &&
		el.versionNonce >= 0
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
	if (!Array.isArray(value)) {
		throw sceneMalformedError('Scene elements must be an array.')
	}
	if (value.length > MAX_SCENE_ELEMENTS) throw sceneTooLargeError()
	const elements: SceneElement[] = []
	for (const item of value) {
		if (!isSceneElement(item)) {
			throw sceneMalformedError('Scene contains a malformed element.')
		}
		elements.push(item)
	}
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
	if (utf8ByteLength(raw) > MAX_SCENE_JSON_BYTES) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		const data = parsed as Record<string, unknown>
		if (data.type !== 'excalidraw') return null
		const elements = parseSceneElements(data.elements)
		const appState =
			data.appState &&
			typeof data.appState === 'object' &&
			!Array.isArray(data.appState)
			? (data.appState as SceneAppState)
			: null
		if (!appState) return null
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

/** Count the bytes that will cross the WebSocket/storage boundary. */
export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

/**
 * Build and preflight a scene mutation before it crosses the WebSocket. The
 * database scene has its own storage limit and the complete envelope has a
 * separate frame limit; checking both here keeps a local oversize terminal.
 */
export function preflightSceneMutationFrame(
	mutation: Omit<SceneMutationFrame, 'type'> | SceneMutationFrame,
):
	| { ok: true; json: string }
	| {
			ok: false
			code: typeof SCENE_TOO_LARGE_CODE | typeof SCENE_MALFORMED_CODE
	  } {
	try {
		if (
			mutation.databaseJson !== undefined &&
			utf8ByteLength(mutation.databaseJson) > MAX_SCENE_JSON_BYTES
		) {
			return { ok: false, code: SCENE_TOO_LARGE_CODE }
		}
		const json = JSON.stringify({
			type: 'scene:update',
			mutationId: mutation.mutationId,
			elements: mutation.elements,
			full: mutation.full,
			...(mutation.databaseJson !== undefined
				? { databaseJson: mutation.databaseJson }
				: {}),
			...(mutation.baseRevision !== undefined
				? { baseRevision: mutation.baseRevision }
				: {}),
		})
		if (utf8ByteLength(json) > MAX_SCENE_FRAME_BYTES) {
			return { ok: false, code: SCENE_TOO_LARGE_CODE }
		}
		return { ok: true, json }
	} catch {
		return { ok: false, code: SCENE_MALFORMED_CODE }
	}
}

export const MUTATION_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isMutationId(value: unknown): value is string {
	return typeof value === 'string' && MUTATION_ID_RE.test(value)
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
