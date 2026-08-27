import { runInDurableObject, SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { parseShareCodeRecord } from '../../../src/worker/shareCode'
import { buildWhiteboardConnectUrl } from '../../../src/lib/whiteboard-sync'

export const WORKER_ORIGIN = 'https://example.com'
export const FRAME_TIMEOUT_MS = 10_000
/** Hello must arrive in a few seconds — the hang this suite exists to catch. */
export const HELLO_TIMEOUT_MS = 5_000
/** Cookie name prefix the Durable Object reads on connect (`scsfoxchase_wbj_{boardId}`). */
export const JOIN_CODE_COOKIE_PREFIX = 'scsfoxchase_wbj_'
export type WorkerFrame = {
	type?: string
	elements?: unknown
	mutationId?: string
	[key: string]: unknown
}

export type ConnectOptions = {
	hostSecret?: string
	headers?: HeadersInit
	sessionId?: string
	displayName?: string
}

type FrameWaiter = {
	predicate: (frame: WorkerFrame) => boolean
	resolve: (frame: WorkerFrame) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout>
}

function parseFrame(data: unknown): WorkerFrame | null {
	const raw =
		typeof data === 'string'
			? data
			: data instanceof ArrayBuffer
				? new TextDecoder().decode(data)
				: null
	if (raw == null) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		return parsed as WorkerFrame
	} catch {
		return null
	}
}

function seenTypes(frames: WorkerFrame[]): string {
	return frames.map((frame) => String(frame.type ?? '<no-type>')).join(', ')
}

export class TestSocket {
	readonly webSocket: WebSocket
	readonly frames: WorkerFrame[] = []
	readonly sessionId: string
	readonly upgradeResponse: Response
	private waiters: FrameWaiter[] = []

	constructor(
		webSocket: WebSocket,
		sessionId: string,
		upgradeResponse: Response,
	) {
		this.webSocket = webSocket
		this.sessionId = sessionId
		this.upgradeResponse = upgradeResponse
		webSocket.addEventListener('message', (event: MessageEvent) => {
			const frame = parseFrame(event.data)
			if (!frame) return
			this.frames.push(frame)
			this.flushWaiters()
		})
	}

	send(payload: unknown): void {
		this.webSocket.send(
			typeof payload === 'string' ? payload : JSON.stringify(payload),
		)
	}

	ping(): void {
		this.webSocket.send('{"type":"ping"}')
	}

	async waitForFrame(
		predicate: (frame: WorkerFrame) => boolean,
		timeoutMs = FRAME_TIMEOUT_MS,
	): Promise<WorkerFrame> {
		const existing = this.frames.find(predicate)
		if (existing) return existing
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer)
				reject(
					new Error(
						`waitForFrame timed out after ${timeoutMs}ms. Seen types: ${seenTypes(this.frames)}`,
					),
				)
			}, timeoutMs)
			this.waiters.push({ predicate, resolve, reject, timer })
		})
	}

	async waitForFrameAfter(
		startLength: number,
		predicate: (frame: WorkerFrame) => boolean,
		timeoutMs = FRAME_TIMEOUT_MS,
	): Promise<WorkerFrame> {
		return this.waitForFrame(
			(frame) =>
				this.frames.indexOf(frame) >= startLength && predicate(frame),
			timeoutMs,
		)
	}

	close(): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer)
		}
		this.waiters = []
		try {
			this.webSocket.close(1000, 'test done')
		} catch {
			// already closed
		}
	}

	private flushWaiters(): void {
		const remaining: FrameWaiter[] = []
		for (const waiter of this.waiters) {
			const match = this.frames.find(waiter.predicate)
			if (match) {
				clearTimeout(waiter.timer)
				waiter.resolve(match)
			} else {
				remaining.push(waiter)
			}
		}
		this.waiters = remaining
	}
}

export function newBoardId(): string {
	return crypto.randomUUID()
}

export function randomHostSecret(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function rectangleElement(id = crypto.randomUUID()) {
	return {
		id,
		type: 'rectangle',
		version: 1,
		versionNonce: 1,
		x: 10,
		y: 20,
		width: 100,
		height: 80,
		isDeleted: false,
	}
}

export function boardStub(boardId: string) {
	return env.WHITEBOARDS.get(env.WHITEBOARDS.idFromName(boardId))
}

export async function workerFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	return SELF.fetch(input, init)
}

/**
 * Pool workers boot the Worker from wrangler.jsonc. Probe an API route so
 * a missing binding or define fails in beforeAll instead of mid-test.
 */
export async function bootWorker(): Promise<void> {
	const response = await workerFetch(`${WORKER_ORIGIN}/api/whiteboard/version`)
	if (!response.ok) {
		throw new Error(
			`Worker boot probe failed: ${response.status} ${await response.text()}`,
		)
	}
}

export async function disposeWorker(): Promise<void> {
	// The vitest pool owns Miniflare lifecycle.
}

export async function upgradeConnect(
	boardId: string,
	options: ConnectOptions = {},
): Promise<Response> {
	const sessionId = options.sessionId ?? crypto.randomUUID()
	const url = buildWhiteboardConnectUrl(WORKER_ORIGIN, {
		boardId,
		sessionId,
		displayName: options.displayName ?? 'Worker test',
		userId: '',
	})
	const headers = new Headers(options.headers)
	if (!headers.has('Upgrade')) headers.set('Upgrade', 'websocket')
	if (!headers.has('Connection')) headers.set('Connection', 'Upgrade')
	if (options.hostSecret) headers.set('X-Board-Host', options.hostSecret)
	return workerFetch(url, { headers })
}

export async function connect(
	boardId: string,
	options: ConnectOptions = {},
): Promise<TestSocket> {
	const sessionId = options.sessionId ?? crypto.randomUUID()
	const response = await upgradeConnect(boardId, { ...options, sessionId })
	const socket = response.webSocket
	if (response.status !== 101 || !socket) {
		throw new Error(
			`WebSocket upgrade failed: ${response.status} ${await response.text()}`,
		)
	}
	const testSocket = new TestSocket(socket, sessionId, response)
	socket.accept()
	return testSocket
}

export async function connectAndAuth(
	boardId: string,
	hostSecret: string,
	options: Omit<ConnectOptions, 'hostSecret'> = {},
): Promise<TestSocket> {
	const socket = await connect(boardId, { ...options, hostSecret })
	socket.send({ type: 'wb:auth', hostSecret })
	await socket.waitForFrame((frame) => frame.type === 'wb:hello')
	return socket
}

export type WbAuthPayload = {
	token?: string
	hostSecret?: string
	signedIn?: boolean
}

export function sendWbAuth(
	socket: TestSocket,
	payload: WbAuthPayload = {},
): void {
	socket.send({ type: 'wb:auth', ...payload })
}

export async function waitForHello(
	socket: TestSocket,
	timeoutMs = HELLO_TIMEOUT_MS,
): Promise<WorkerFrame> {
	return socket.waitForFrame((frame) => frame.type === 'wb:hello', timeoutMs)
}

export function framesOfType(
	socket: TestSocket,
	type: string,
): WorkerFrame[] {
	return socket.frames.filter((frame) => frame.type === type)
}

export function joinCodeCookieHeader(boardId: string, code: string): string {
	return `${JOIN_CODE_COOKIE_PREFIX}${boardId}=${encodeURIComponent(code)}`
}

export async function collectFrames(
	socket: TestSocket,
	ms: number,
): Promise<WorkerFrame[]> {
	const start = socket.frames.length
	await new Promise((resolve) => setTimeout(resolve, ms))
	return socket.frames.slice(start)
}

export function frameHasElement(
	frame: WorkerFrame,
	elementId: string,
): boolean {
	if (!Array.isArray(frame.elements)) return false
	return frame.elements.some(
		(element) =>
			element !== null &&
			typeof element === 'object' &&
			'id' in element &&
			(element as { id: unknown }).id === elementId,
	)
}

export type ShareCodeKvEntry = {
	key: string
	value: string
	expiration: number | null
	metadata: unknown
}

/**
 * Observable KV state for one board's `code:*` mappings. Miniflare does not
 * expose a write counter, so reconnect tests compare this snapshot.
 */
export async function listShareCodeEntriesForBoard(
	boardId: string,
): Promise<ShareCodeKvEntry[]> {
	const entries: ShareCodeKvEntry[] = []
	let cursor: string | undefined
	for (;;) {
		const page = await env.WHITEBOARD_CODES.list({
			prefix: 'code:',
			cursor,
		})
		for (const entry of page.keys) {
			const raw = await env.WHITEBOARD_CODES.get(entry.name)
			const record = parseShareCodeRecord(raw)
			if (record?.boardId !== boardId || raw == null) continue
			entries.push({
				key: entry.name,
				value: raw,
				expiration: entry.expiration ?? null,
				metadata: entry.metadata ?? null,
			})
		}
		if (page.list_complete) break
		cursor = page.cursor
	}
	return entries.sort((a, b) => a.key.localeCompare(b.key))
}

export async function listShareCodeKeysForBoard(
	boardId: string,
): Promise<string[]> {
	const entries = await listShareCodeEntriesForBoard(boardId)
	return entries.map((entry) => entry.key)
}

export function shareCodeFromKvKey(key: string): string {
	return key.startsWith('code:') ? key.slice('code:'.length) : key
}

export async function readSceneUpdatedAt(
	boardId: string,
): Promise<number | null> {
	return runInDurableObject(boardStub(boardId), async (_instance, state) => {
		const row = state.storage.sql
			.exec<{ updated_at: number }>(
				'SELECT updated_at FROM excalidraw_scene WHERE id = 1',
			)
			.toArray()[0]
		return row?.updated_at ?? null
	})
}

/** 1×1 transparent PNG. */
export const PNG_1X1 = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])
