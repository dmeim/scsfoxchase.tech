/**
 * Durable Object for one whiteboard room (product family: scsfoxchase-tech_whiteboards).
 * Persists tldraw document state in DO SQLite via @tldraw/sync-core.
 * Phase 5: also owns active share code + DO alarm expiry (KV index for join).
 * Phase 6: per-session canEdit + live participant list for the manage panel.
 * Force-follow: host can lock all guests to the host camera.
 */
import {
	DurableObjectSqliteSyncWrapper,
	SQLiteSyncStorage,
	TLSocketRoom,
	type SessionStateSnapshot,
} from '@tldraw/sync-core'
import {
	createTLSchema,
	defaultBindingSchemas,
	defaultShapeSchemas,
	type TLRecord,
} from '@tldraw/tlschema'
import { DurableObject } from 'cloudflare:workers'
import {
	isExpiredIso,
	kvCodeKey,
	sampleShareCode,
	SHARE_CODE_TTL_MS,
	SHARE_CODE_TTL_SECONDS,
} from './shareCode'

const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	bindings: { ...defaultBindingSchemas },
})

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
	snapshot: SessionStateSnapshot | null
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

/** Internal access to mutate isReadonly on a live session (no public setter). */
type RoomWithSessions = {
	room: {
		sessions: Map<string, { isReadonly: boolean }>
	}
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
		snapshot: raw?.snapshot ?? null,
		isHost,
		canEdit: raw?.canEdit !== false,
		meta: {
			displayName: meta.displayName ?? '',
			userId: meta.userId ?? '',
			isHost: Boolean(meta.isHost || isHost),
		},
	}
}

export class WhiteboardBoard extends DurableObject<Env> {
	private room: TLSocketRoom<TLRecord, SessionMeta> | null = null
	/** Map sessionId → ws so onSessionSnapshot can serialize to the right socket. */
	private readonly sessionIdToWs = new Map<string, WebSocket>()
	/** Sessions that have completed sync handshake (Connected). */
	private readonly announcedSessions = new Set<string>()
	/** Cached force-follow flag (null until first storage read). */
	private forceFollowCache: boolean | null = null

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// Respond to ping messages at the platform level without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
		)
	}

	private getOrCreateRoom(): TLSocketRoom<TLRecord, SessionMeta> {
		if (!this.room) {
			const sql = new DurableObjectSqliteSyncWrapper(this.ctx.storage, {
				tablePrefix: 'tldraw_',
			})
			const storage = new SQLiteSyncStorage<TLRecord>({ sql })

			this.room = new TLSocketRoom<TLRecord, SessionMeta>({
				schema,
				storage,
				// Cloudflare keeps sockets alive across hibernation; disable room idle prune.
				clientTimeout: Infinity,
				onSessionSnapshot: (sessionId, snapshot) => {
					const ws = this.sessionIdToWs.get(sessionId)
					if (!ws) return
					const prev = (ws.deserializeAttachment() as SocketAttachment | null) ?? {
						sessionId,
						snapshot: null,
						isHost: false,
						canEdit: true,
						meta: { displayName: '', userId: '', isHost: false },
					}
					ws.serializeAttachment({ ...prev, snapshot })
				},
				onSessionRemoved: (_room, { sessionId }) => {
					this.sessionIdToWs.delete(sessionId)
					this.announcedSessions.delete(sessionId)
					this.broadcastParticipants()
				},
			})

			// Resume any sessions that survived hibernation.
			for (const ws of this.ctx.getWebSockets()) {
				const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
				if (!raw?.sessionId) continue
				const attachment = normalizeAttachment(raw, raw.sessionId)
				ws.serializeAttachment(attachment)
				if (attachment.snapshot) {
					this.room.handleSocketResume({
						sessionId: attachment.sessionId,
						socket: ws,
						snapshot: {
							...attachment.snapshot,
							isReadonly: !attachment.canEdit,
						},
						meta: attachment.meta,
					})
					this.sessionIdToWs.set(attachment.sessionId, ws)
					this.announcedSessions.add(attachment.sessionId)
				}
			}
		}
		return this.room
	}

	/**
	 * Store host secret hash on first connect that supplies a secret;
	 * verify on later connects.
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
		const url = new URL(request.url)
		const connectMatch = url.pathname.match(
			/^\/api\/whiteboard\/connect\/([^/]+)\/?$/i,
		)
		if (connectMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
			return this.handleConnect(request, url)
		}

		const codeMatch = url.pathname.match(
			/^\/api\/whiteboard\/boards\/([^/]+)\/code\/?$/i,
		)
		if (codeMatch) {
			const boardId =
				url.searchParams.get('boardId') || decodeURIComponent(codeMatch[1]!)
			return this.handleCodeHttp(request, url, boardId)
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

	private async handleConnect(request: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('sessionId')
		if (!sessionId) {
			return new Response('Missing sessionId', { status: 400 })
		}

		const hostSecret = url.searchParams.get('hostSecret')
		const isHost = await this.resolveHost(hostSecret)
		// Default canEdit true for new guests; host always can edit.
		const canEdit = true
		const meta: SessionMeta = {
			displayName: sanitizeDisplayName(url.searchParams.get('displayName')),
			userId: sanitizeUserId(url.searchParams.get('userId')),
			isHost,
		}

		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		this.ctx.acceptWebSocket(serverWebSocket)

		const attachment: SocketAttachment = {
			sessionId,
			snapshot: null,
			isHost,
			canEdit,
			meta,
		}
		serverWebSocket.serializeAttachment(attachment)
		this.sessionIdToWs.set(sessionId, serverWebSocket)

		this.getOrCreateRoom().handleSocketConnect({
			sessionId,
			socket: serverWebSocket,
			isReadonly: !canEdit,
			meta,
		})

		// Push the live People list to everyone (including the newcomer).
		this.broadcastParticipants()
		// Force-follow state (Connected sessions only; also re-sent on announce).
		void this.broadcastForceFollow()

		return new Response(null, { status: 101, webSocket: clientWebSocket })
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

		const ws = this.sessionIdToWs.get(sessionId)
		if (!ws) {
			// Fall back to room sessions in case map is stale after hibernation.
			const room = this.getOrCreateRoom()
			const found = room.getSessions().some((s) => s.sessionId === sessionId)
			if (!found) {
				return json(404, { error: 'Session not connected' })
			}
		}

		const attachment = ws
			? ((ws.deserializeAttachment() as SocketAttachment | null) ?? null)
			: null

		if (attachment?.isHost || this.isSessionHost(sessionId)) {
			// Host cannot be demoted.
			if (!canEdit) {
				return json(400, { error: 'Host edit permission cannot be turned off' })
			}
			// Host already canEdit; still return current row.
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

	/** Prefer a connected host session's tldraw userId for startFollowingUser. */
	private resolveHostUserId(): string {
		for (const row of this.listParticipants()) {
			if (row.isHost && row.userId) return row.userId
		}
		return ''
	}

	private async broadcastForceFollow(): Promise<void> {
		const room = this.getOrCreateRoom()
		const forceFollow = await this.getForceFollow()
		const hostUserId = this.resolveHostUserId()
		const payload = {
			type: 'wb:forceFollow' as const,
			forceFollow,
			hostUserId,
		}
		for (const sessionId of this.sessionIdToWs.keys()) {
			const session = room
				.getSessions()
				.find((s) => s.sessionId === sessionId)
			if (!session?.isConnected) continue
			try {
				room.sendCustomMessage(sessionId, payload)
			} catch {
				// Session may have raced out mid-broadcast.
			}
		}
	}

	private isSessionHost(sessionId: string): boolean {
		const room = this.getOrCreateRoom()
		const session = room.getSessions().find((s) => s.sessionId === sessionId)
		return Boolean(session?.meta?.isHost)
	}

	private participantFromSession(sessionId: string): ParticipantPublic | null {
		const room = this.getOrCreateRoom()
		const session = room.getSessions().find((s) => s.sessionId === sessionId)
		if (!session) return null

		const ws = this.sessionIdToWs.get(sessionId)
		const attachment = ws
			? ((ws.deserializeAttachment() as SocketAttachment | null) ?? null)
			: null

		const canEdit = attachment ? attachment.canEdit : !session.isReadonly
		const meta = attachment?.meta ?? session.meta

		return {
			sessionId,
			userId: meta?.userId ?? '',
			displayName: meta?.displayName ?? '',
			canEdit,
			isHost: Boolean(meta?.isHost || attachment?.isHost),
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
		const room = this.getOrCreateRoom()
		const participants = this.listParticipants()
		for (const sessionId of this.sessionIdToWs.keys()) {
			const session = room
				.getSessions()
				.find((s) => s.sessionId === sessionId)
			// Custom messages only deliver once the sync handshake reaches Connected.
			if (!session?.isConnected) continue
			try {
				room.sendCustomMessage(sessionId, {
					type: 'wb:participants',
					yourSessionId: sessionId,
					participants,
				})
			} catch {
				// Session may have raced out mid-broadcast.
			}
		}
	}

	/**
	 * Update server-side isReadonly (blocks document diffs) and notify the client.
	 */
	private applyCanEdit(sessionId: string, canEdit: boolean): void {
		const room = this.getOrCreateRoom()

		const internal = (room as unknown as RoomWithSessions).room
		const live = internal.sessions.get(sessionId)
		if (live) {
			live.isReadonly = !canEdit
		}

		const ws = this.sessionIdToWs.get(sessionId)
		if (ws) {
			const prev = (ws.deserializeAttachment() as SocketAttachment | null) ?? {
				sessionId,
				snapshot: null,
				isHost: false,
				canEdit: true,
				meta: { displayName: '', userId: '', isHost: false },
			}
			const nextSnapshot = prev.snapshot
				? { ...prev.snapshot, isReadonly: !canEdit }
				: null
			ws.serializeAttachment({
				...prev,
				canEdit,
				snapshot: nextSnapshot,
			})
		}

		try {
			room.sendCustomMessage(sessionId, {
				type: 'wb:canEdit',
				canEdit,
			})
		} catch {
			// ignore
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
		await this.ctx.storage.setAlarm(Date.parse(expiresAt))

		return { code, expiresAt }
	}

	private async revokeActiveCode(): Promise<void> {
		const code = await this.ctx.storage.get<string>(ACTIVE_CODE_KEY)
		if (code) {
			await this.env.WHITEBOARD_CODES.delete(kvCodeKey(code))
		}
		await this.ctx.storage.delete(ACTIVE_CODE_KEY)
		await this.ctx.storage.delete(CODE_EXPIRES_AT_KEY)
		try {
			await this.ctx.storage.deleteAlarm()
		} catch {
			// no alarm set
		}
	}

	/** KV TTL + DO alarm: clear active code when expired. */
	override async alarm(): Promise<void> {
		const expiresAt = await this.ctx.storage.get<string>(CODE_EXPIRES_AT_KEY)
		if (!expiresAt || isExpiredIso(expiresAt)) {
			await this.revokeActiveCode()
			return
		}
		// Alarm fired early — reschedule (shouldn't happen often).
		await this.ctx.storage.setAlarm(Date.parse(expiresAt))
	}

	private getSessionId(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as SocketAttachment | null
		return attachment?.sessionId ?? null
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const sessionId = this.getSessionId(ws)
		if (!sessionId) return

		this.sessionIdToWs.set(sessionId, ws)
		const room = this.getOrCreateRoom()
		room.handleSocketMessage(sessionId, message)

		// First Connected transition → refresh People lists (custom msgs need Connected).
		if (!this.announcedSessions.has(sessionId)) {
			const session = room
				.getSessions()
				.find((s) => s.sessionId === sessionId)
			if (session?.isConnected) {
				this.announcedSessions.add(sessionId)
				this.broadcastParticipants()
				void this.broadcastForceFollow()
			}
		}
	}

	override async webSocketClose(ws: WebSocket) {
		this.handleWebSocketEnd(ws, 'handleSocketClose')
	}

	override async webSocketError(ws: WebSocket) {
		this.handleWebSocketEnd(ws, 'handleSocketError')
	}

	private handleWebSocketEnd(
		ws: WebSocket,
		method: 'handleSocketClose' | 'handleSocketError',
	) {
		const raw = ws.deserializeAttachment() as Partial<SocketAttachment> | null
		if (!raw?.sessionId) return
		const attachment = normalizeAttachment(raw, raw.sessionId)

		this.sessionIdToWs.delete(attachment.sessionId)
		this.announcedSessions.delete(attachment.sessionId)

		const room = this.getOrCreateRoom()

		// If the DO was hibernating, resume briefly so presence can be cleared.
		if (attachment.snapshot && !room.getSessionSnapshot(attachment.sessionId)) {
			room.handleSocketResume({
				sessionId: attachment.sessionId,
				socket: ws,
				snapshot: {
					...attachment.snapshot,
					isReadonly: !attachment.canEdit,
				},
				meta: attachment.meta,
			})
		}

		room[method](attachment.sessionId)
		// onSessionRemoved also broadcasts; call again in case removal is deferred.
		this.broadcastParticipants()
	}
}
