/**
 * Durable Object for one whiteboard room (product family: scsfoxchase-tech_whiteboards).
 * Persists tldraw document state in DO SQLite via @tldraw/sync-core.
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

const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	bindings: { ...defaultBindingSchemas },
})

const HOST_SECRET_HASH_KEY = 'meta:hostSecretHash'

interface SocketAttachment {
	sessionId: string
	snapshot: SessionStateSnapshot | null
	isHost: boolean
}

async function sha256Hex(value: string): Promise<string> {
	const data = new TextEncoder().encode(value)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class WhiteboardBoard extends DurableObject {
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
