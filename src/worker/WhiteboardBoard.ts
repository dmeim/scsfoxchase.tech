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
import {
	FULL_RESYNC_EVERY,
	MAX_SCENE_JSON_BYTES,
	META_BOARD_ID_KEY,
	META_CLOUD_OWNER_KEY,
	META_CREATED_AT_KEY,
	META_SAVED_TO_LIBRARY_KEY,
	META_TEMP_ASSET_PREFIX_KEY,
	META_UNSAVED_EXPIRES_AT_KEY,
	UNSAVED_BOARD_TTL_MS,
	mergeSceneElements,
	parseDatabaseScene,
	parseSceneElements,
	stringifyDatabaseScene,
	toDatabaseScene,
	type OwnerHook,
	type SceneAppState,
	type SceneElement,
} from '../lib/whiteboard-sync'
import {
	isExpiredIso,
	kvCodeKey,
	sampleShareCode,
	SHARE_CODE_TTL_MS,
	SHARE_CODE_TTL_SECONDS,
} from './shareCode'

const HOST_SECRET_HASH_KEY = 'meta:hostSecretHash'
const FORCE_FOLLOW_KEY = 'meta:forceFollow'
const ACTIVE_CODE_KEY = 'meta:activeCode'
const CODE_EXPIRES_AT_KEY = 'meta:codeExpiresAt'
const CODE_MINT_LOG_KEY = 'meta:codeMintLog'

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
	meta: SessionMeta
}

type CodeState = {
	code: string
	expiresAt: string
}

type ParticipantPublic = {
	sessionId: string
	userId: string
	displayName: string
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

function sanitizeDisplayName(raw: string | null): string {
	if (!raw) return ''
	return raw.trim().slice(0, 48)
}

function sanitizeUserId(raw: string | null): string {
	if (!raw) return ''
	return raw.trim().slice(0, 128)
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

/** Normalize attachments from older deploys that lacked canEdit/meta. */
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
	return {
		sessionId: raw?.sessionId ?? sessionId,
		isHost,
		canEdit: raw?.canEdit !== false,
		meta: {
			displayName: meta.displayName ?? '',
			userId: meta.userId ?? '',
			isHost: Boolean(meta.isHost || isHost),
		},
	}
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
	private forceFollowCache: boolean | null = null
	private socketsHydrated = false
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
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS excalidraw_scene (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					database_json TEXT NOT NULL,
					live_json TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`)
		})
	}

	/** Rebuild the session map after hibernation. */
	private hydrateSockets(): void {
		if (this.socketsHydrated) return
		this.socketsHydrated = true
		for (const ws of this.ctx.getWebSockets()) {
			const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
			if (!raw?.sessionId) continue
			const attachment = normalizeAttachment(raw, raw.sessionId)
			ws.serializeAttachment(attachment)
			this.sessionIdToWs.set(attachment.sessionId, ws)
		}
	}

	/**
	 * Store host secret hash on first connect that supplies a secret;
	 * verify on later connects. Creating browser is ephemeral Owner.
	 */
	private async resolveHost(hostSecret: string | null): Promise<boolean> {
		if (!hostSecret) return false
		const hash = await sha256Hex(hostSecret)
		const existing = await this.ctx.storage.get<string>(HOST_SECRET_HASH_KEY)
		if (!existing) {
			await this.ctx.storage.put(HOST_SECRET_HASH_KEY, hash)
			return true
		}
		return existing === hash
	}

	private async assertHost(hostSecret: string | null): Promise<boolean> {
		if (!hostSecret) return false
		const hash = await sha256Hex(hostSecret)
		const existing = await this.ctx.storage.get<string>(HOST_SECRET_HASH_KEY)
		return Boolean(existing && existing === hash)
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

		const hostSecret = url.searchParams.get('hostSecret')
		const isHost = await this.resolveHost(hostSecret)
		// Phase 2: every connected session may edit. Phase 3.3 enforces roles.
		const canEdit = true
		const meta: SessionMeta = {
			displayName: sanitizeDisplayName(url.searchParams.get('displayName')),
			userId: sanitizeUserId(url.searchParams.get('userId')),
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
			meta,
		}
		serverWebSocket.serializeAttachment(attachment)
		this.sessionIdToWs.set(sessionId, serverWebSocket)

		await this.ensureBoardLifetime(boardId)
		const owner = await this.readOwnerHook(isHost)
		const savedToLibrary = await this.isSavedToLibrary()
		sendJson(serverWebSocket, {
			type: 'wb:hello',
			sessionId,
			isHost,
			canEdit,
			savedToLibrary,
			owner,
		})
		await this.sendFullScene(serverWebSocket)

		this.broadcastParticipants()
		void this.broadcastForceFollow()

		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}

	private async handleMetaHttp(
		request: Request,
		url: URL,
		boardId: string,
	): Promise<Response> {
		if (request.method === 'GET') {
			await this.ensureBoardLifetime(boardId)
			return json(200, await this.readPublicMeta())
		}

		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' })
		}

		const hostSecret = url.searchParams.get('hostSecret')
		if (!(await this.assertHost(hostSecret))) {
			return json(403, { error: 'Host secret required' })
		}

		let body: {
			savedToLibrary?: unknown
			cloudOwnerKey?: unknown
			tempAssetPrefix?: unknown
		}
		try {
			body = (await request.json()) as typeof body
		} catch {
			return json(400, { error: 'Invalid JSON body' })
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

		if ('cloudOwnerKey' in body) {
			if (body.cloudOwnerKey === null) {
				await this.ctx.storage.delete(META_CLOUD_OWNER_KEY)
			} else if (typeof body.cloudOwnerKey === 'string') {
				const key = sanitizeOwnerKey(body.cloudOwnerKey)
				if (!key) return json(400, { error: 'Invalid cloudOwnerKey' })
				await this.ctx.storage.put(META_CLOUD_OWNER_KEY, key)
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
		return json(200, await this.readPublicMeta())
	}

	private async readPublicMeta(): Promise<{
		savedToLibrary: boolean
		cloudOwnerKey: string | null
		createdAt: string | null
		unsavedExpiresAt: string | null
		owner: OwnerHook
	}> {
		const savedToLibrary = await this.isSavedToLibrary()
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		return {
			savedToLibrary,
			cloudOwnerKey,
			createdAt: (await this.ctx.storage.get<string>(META_CREATED_AT_KEY)) ?? null,
			unsavedExpiresAt:
				(await this.ctx.storage.get<string>(META_UNSAVED_EXPIRES_AT_KEY)) ??
				null,
			owner: await this.readOwnerHook(false),
		}
	}

	private async readOwnerHook(isHost: boolean): Promise<OwnerHook> {
		const cloudOwnerKey =
			(await this.ctx.storage.get<string>(META_CLOUD_OWNER_KEY)) ?? null
		const saved = await this.isSavedToLibrary()
		const google =
			saved && typeof cloudOwnerKey === 'string' && cloudOwnerKey.startsWith('google:')
		return {
			kind: google ? 'google' : 'ephemeral',
			cloudOwnerKey,
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

	private async loadScene(): Promise<LiveScene> {
		if (this.sceneLoaded && this.sceneCache) return this.sceneCache
		this.sceneLoaded = true
		const row = this.ctx.storage.sql
			.exec<{ live_json: string; database_json: string }>(
				'SELECT live_json, database_json FROM excalidraw_scene WHERE id = 1',
			)
			.toArray()[0]
		if (!row) {
			this.sceneCache = { elements: [], appState: {} }
			return this.sceneCache
		}
		try {
			const live = JSON.parse(row.live_json) as unknown
			if (Array.isArray(live)) {
				this.sceneCache = { elements: parseSceneElements(live), appState: {} }
			} else if (live && typeof live === 'object') {
				const rec = live as Record<string, unknown>
				this.sceneCache = {
					elements: parseSceneElements(rec.elements),
					appState:
						rec.appState && typeof rec.appState === 'object'
							? (rec.appState as SceneAppState)
							: {},
				}
			}
		} catch {
			this.sceneCache = null
		}
		if (!this.sceneCache) {
			const database = parseDatabaseScene(row.database_json)
			this.sceneCache = database
				? { elements: database.elements, appState: database.appState }
				: { elements: [], appState: {} }
		}
		if (!this.sceneCache.appState || Object.keys(this.sceneCache.appState).length === 0) {
			const database = parseDatabaseScene(row.database_json)
			if (database) this.sceneCache.appState = database.appState
		}
		return this.sceneCache
	}

	private persistScene(
		scene: LiveScene,
		databaseJson: string | undefined,
	): void {
		const parsed = databaseJson ? parseDatabaseScene(databaseJson) : null
		const database = parsed
			? stringifyDatabaseScene(parsed)
			: stringifyDatabaseScene(toDatabaseScene(scene.elements, scene.appState))
		if (database.length > MAX_SCENE_JSON_BYTES) return
		const liveJson = JSON.stringify({
			elements: scene.elements,
			appState: scene.appState,
		})
		if (liveJson.length > MAX_SCENE_JSON_BYTES) return
		this.ctx.storage.sql.exec(
			`INSERT INTO excalidraw_scene (id, database_json, live_json, updated_at)
			 VALUES (1, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   database_json = excluded.database_json,
			   live_json = excluded.live_json,
			   updated_at = excluded.updated_at`,
			database,
			liveJson,
			Date.now(),
		)
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
		this.persistScene(nextScene, databaseJson)

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

	private async handleParticipantPatch(
		request: Request,
		url: URL,
		sessionId: string,
	): Promise<Response> {
		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' })
		}

		const hostSecret = url.searchParams.get('hostSecret')
		if (!(await this.assertHost(hostSecret))) {
			return json(403, { error: 'Host secret required' })
		}

		const canEditParam = url.searchParams.get('canEdit')
		const canEdit = canEditParam === '1' || canEditParam === 'true'

		this.hydrateSockets()
		const ws = this.sessionIdToWs.get(sessionId)
		if (!ws) {
			return json(404, { error: 'Session not connected' })
		}

		const attachment = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			sessionId,
		)

		if (attachment.isHost || attachment.meta.isHost) {
			if (!canEdit) {
				return json(400, { error: 'Host edit permission cannot be turned off' })
			}
			const row = this.participantFromSession(sessionId)
			return json(200, row ?? { sessionId, canEdit: true, isHost: true, userId: '', displayName: '' })
		}

		this.applyCanEdit(sessionId, canEdit)
		const row = this.participantFromSession(sessionId)
		if (!row) {
			return json(404, { error: 'Session not connected' })
		}
		return json(200, row)
	}

	private async handleForceFollowPatch(
		request: Request,
		url: URL,
	): Promise<Response> {
		if (request.method !== 'PATCH') {
			return json(405, { error: 'Method not allowed' })
		}

		const hostSecret = url.searchParams.get('hostSecret')
		if (!(await this.assertHost(hostSecret))) {
			return json(403, { error: 'Host secret required' })
		}

		const forceFollowParam = url.searchParams.get('forceFollow')
		const forceFollow =
			forceFollowParam === '1' || forceFollowParam === 'true'

		await this.setForceFollow(forceFollow)
		const hostUserId = this.resolveHostUserId()
		void this.broadcastForceFollow()
		return json(200, { forceFollow, hostUserId })
	}

	private async getForceFollow(): Promise<boolean> {
		if (this.forceFollowCache !== null) return this.forceFollowCache
		const stored = await this.ctx.storage.get<boolean>(FORCE_FOLLOW_KEY)
		this.forceFollowCache = Boolean(stored)
		return this.forceFollowCache
	}

	private async setForceFollow(forceFollow: boolean): Promise<void> {
		this.forceFollowCache = forceFollow
		if (forceFollow) {
			await this.ctx.storage.put(FORCE_FOLLOW_KEY, true)
		} else {
			await this.ctx.storage.delete(FORCE_FOLLOW_KEY)
		}
	}

	private resolveHostUserId(): string {
		for (const row of this.listParticipants()) {
			if (row.isHost && row.userId) return row.userId
		}
		return ''
	}

	private async broadcastForceFollow(): Promise<void> {
		const forceFollow = await this.getForceFollow()
		const hostUserId = this.resolveHostUserId()
		const payload = {
			type: 'wb:forceFollow' as const,
			forceFollow,
			hostUserId,
		}
		for (const ws of this.sessionIdToWs.values()) {
			sendJson(ws, payload)
		}
	}

	private participantFromSession(sessionId: string): ParticipantPublic | null {
		const ws = this.sessionIdToWs.get(sessionId)
		if (!ws) return null
		const attachment = normalizeAttachment(
			ws.deserializeAttachment() as Partial<SocketAttachment> | null,
			sessionId,
		)
		return {
			sessionId,
			userId: attachment.meta.userId,
			displayName: attachment.meta.displayName,
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
			rows.push({
				sessionId,
				userId: attachment.meta.userId,
				displayName: attachment.meta.displayName,
				canEdit: attachment.canEdit,
				isHost: attachment.isHost || attachment.meta.isHost,
			})
		}
		return rows
	}

	private broadcastParticipants(): void {
		const participants = this.listParticipants()
		for (const [sessionId, ws] of this.sessionIdToWs) {
			sendJson(ws, {
				type: 'wb:participants',
				yourSessionId: sessionId,
				participants,
			})
		}
	}

	private applyCanEdit(sessionId: string, canEdit: boolean): void {
		const ws = this.sessionIdToWs.get(sessionId)
		if (ws) {
			const prev = normalizeAttachment(
				ws.deserializeAttachment() as Partial<SocketAttachment> | null,
				sessionId,
			)
			ws.serializeAttachment({
				...prev,
				canEdit,
			})
			sendJson(ws, {
				type: 'wb:canEdit',
				canEdit,
			})
		}
		this.broadcastParticipants()
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
		const type = data.type

		if (type === 'scene:request') {
			await this.sendFullScene(ws)
			return
		}

		if (type === 'scene:update') {
			const elements = parseSceneElements(data.elements)
			const databaseJson =
				typeof data.databaseJson === 'string' &&
				data.databaseJson.length <= MAX_SCENE_JSON_BYTES
					? data.databaseJson
					: undefined
			await this.applySceneUpdate(
				sessionId,
				elements,
				databaseJson,
				data.full === true,
			)
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
		this.broadcastParticipants()
	}
}
