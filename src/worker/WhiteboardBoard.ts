/**
 * Durable Object for one whiteboard room (product family: scsfoxchase-tech_whiteboards).
 * Persists tldraw document state in DO SQLite via @tldraw/sync-core.
 * Phase 5: also owns active share code + DO alarm expiry (KV index for join).
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
const ACTIVE_CODE_KEY = 'meta:activeCode'
const CODE_EXPIRES_AT_KEY = 'meta:codeExpiresAt'
const CODE_MINT_LOG_KEY = 'meta:codeMintLog'

/** Max mint/rotate attempts per board in a rolling window. */
const MINT_RATE_LIMIT = 12
const MINT_RATE_WINDOW_MS = 10 * 60 * 1000
const MINT_SAMPLE_ATTEMPTS = 24

interface SocketAttachment {
	sessionId: string
	snapshot: SessionStateSnapshot | null
	isHost: boolean
}

type CodeState = {
	code: string
	expiresAt: string
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

export class WhiteboardBoard extends DurableObject<Env> {
	private room: TLSocketRoom<TLRecord, void> | null = null
	/** Map sessionId → ws so onSessionSnapshot can serialize to the right socket. */
	private readonly sessionIdToWs = new Map<string, WebSocket>()

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// Respond to ping messages at the platform level without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
		)
	}

	private getOrCreateRoom(): TLSocketRoom<TLRecord, void> {
		if (!this.room) {
			const sql = new DurableObjectSqliteSyncWrapper(this.ctx.storage, {
				tablePrefix: 'tldraw_',
			})
			const storage = new SQLiteSyncStorage<TLRecord>({ sql })

			this.room = new TLSocketRoom<TLRecord, void>({
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
					}
					ws.serializeAttachment({ ...prev, snapshot })
				},
			})

			// Resume any sessions that survived hibernation.
			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as SocketAttachment | null
				if (!attachment?.sessionId) continue
				if (attachment.snapshot) {
					this.room.handleSocketResume({
						sessionId: attachment.sessionId,
						socket: ws,
						snapshot: attachment.snapshot,
					})
				}
			}
		}
		return this.room
	}

	/**
	 * Store host secret hash on first connect that supplies a secret;
	 * verify on later connects. Phase 3 still treats everyone as editor.
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

		return new Response('Not found', { status: 404 })
	}

	private async handleConnect(request: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('sessionId')
		if (!sessionId) {
			return new Response('Missing sessionId', { status: 400 })
		}

		const hostSecret = url.searchParams.get('hostSecret')
		const isHost = await this.resolveHost(hostSecret)

		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		this.ctx.acceptWebSocket(serverWebSocket)

		const attachment: SocketAttachment = {
			sessionId,
			snapshot: null,
			isHost,
		}
		serverWebSocket.serializeAttachment(attachment)

		this.getOrCreateRoom().handleSocketConnect({
			sessionId,
			socket: serverWebSocket,
		})

		return new Response(null, { status: 101, webSocket: clientWebSocket })
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
		this.getOrCreateRoom().handleSocketMessage(sessionId, message)
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
		const attachment = ws.deserializeAttachment() as SocketAttachment | null
		if (!attachment?.sessionId) return

		this.sessionIdToWs.delete(attachment.sessionId)

		const room = this.getOrCreateRoom()

		// If the DO was hibernating, resume briefly so presence can be cleared.
		if (attachment.snapshot && !room.getSessionSnapshot(attachment.sessionId)) {
			room.handleSocketResume({
				sessionId: attachment.sessionId,
				socket: ws,
				snapshot: attachment.snapshot,
			})
		}

		room[method](attachment.sessionId)
	}
}
