/**
 * Durable Object for one whiteboard room (product family: scsfoxchase-tech_whiteboards).
 *
 * PHASE 1 STUB: tldraw TLSocketRoom is gone. This accepts WebSockets and keeps
 * share-code / host / People HTTP working so the Worker still boots. Live
 * Excalidraw scene sync is Phase 2 — do not treat this as the collab protocol.
 */
import { DurableObject } from 'cloudflare:workers'
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// Respond to ping messages at the platform level without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
		)
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
		this.hydrateSockets()
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
			isHost,
			canEdit,
			meta,
		}
		serverWebSocket.serializeAttachment(attachment)
		this.sessionIdToWs.set(sessionId, serverWebSocket)

		this.broadcastParticipants()
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
		await this.ctx.storage.setAlarm(Date.parse(expiresAt))
	}

	private getSessionId(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as SocketAttachment | null
		return attachment?.sessionId ?? null
	}

	override async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer) {
		this.hydrateSockets()
		const sessionId = this.getSessionId(ws)
		if (!sessionId) return
		this.sessionIdToWs.set(sessionId, ws)
		// Phase 1: ignore client payloads. Phase 2 owns Excalidraw scene sync.
	}

	override async webSocketClose(ws: WebSocket) {
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
