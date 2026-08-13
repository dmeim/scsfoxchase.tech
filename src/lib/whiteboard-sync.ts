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
export const MAX_SCENE_ELEMENTS = 4000
export const MAX_SCENE_JSON_BYTES = 2_000_000

/** DO storage: first secret to connect is ephemeral Owner (Phase 3 roles). */
export const META_HOST_SECRET_HASH_KEY = 'meta:hostSecretHash'
export const META_SAVED_TO_LIBRARY_KEY = 'meta:savedToLibrary'
export const META_CLOUD_OWNER_KEY = 'meta:cloudOwnerKey'
export const META_TEMP_ASSET_PREFIX_KEY = 'meta:tempAssetPrefix'
export const META_UNSAVED_EXPIRES_AT_KEY = 'meta:unsavedExpiresAt'
export const META_CREATED_AT_KEY = 'meta:createdAt'
export const META_BOARD_ID_KEY = 'meta:boardId'

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
	cloudOwnerKey: string | null
	isHost: boolean
}

export type HelloMessage = {
	type: 'wb:hello'
	sessionId: string
	isHost: boolean
	canEdit: boolean
	savedToLibrary: boolean
	owner: OwnerHook
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

export function parseSceneElements(value: unknown): SceneElement[] {
	if (!Array.isArray(value)) return []
	const out: SceneElement[] = []
	for (const item of value) {
		if (!isSceneElement(item)) continue
		out.push(item)
		if (out.length >= MAX_SCENE_ELEMENTS) break
	}
	return out
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
		const elements = parseSceneElements(data.elements)
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
		hostSecret: string | null
		displayName: string
		userId: string
	},
): string {
	const url = new URL(
		`/api/whiteboard/connect/${encodeURIComponent(opts.boardId)}`,
		origin,
	)
	url.searchParams.set('sessionId', opts.sessionId)
	if (opts.hostSecret) url.searchParams.set('hostSecret', opts.hostSecret)
	if (opts.displayName) url.searchParams.set('displayName', opts.displayName)
	if (opts.userId) url.searchParams.set('userId', opts.userId)
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
