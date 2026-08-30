import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runInDurableObject } from 'cloudflare:test'
import { CLIENT_PING_MS } from '../../src/lib/whiteboard-sync'
import {
	boardStub,
	bootWorker,
	connectAndAuth,
	disposeWorker,
	listShareCodeKeysForBoard,
	newBoardId,
	randomHostSecret,
	readSceneUpdatedAt,
	workerFetch,
	WORKER_ORIGIN,
} from './helpers/harness'

const IDLE_MS = CLIENT_PING_MS + 5_000

describe('idle board does not write', () => {
	const sockets: Array<{ close: () => void }> = []

	beforeAll(async () => {
		await bootWorker()
	})

	afterEach(() => {
		while (sockets.length > 0) sockets.pop()?.close()
	})

	afterAll(async () => {
		await disposeWorker()
	})

	it('keeps a fresh Durable Object write-free after GET /meta', async () => {
		const boardId = newBoardId()
		const meta = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`,
		)
		expect(meta.status).toBe(200)
		expect(await meta.json()).toMatchObject({
			savedToLibrary: false,
			createdAt: null,
			unsavedExpiresAt: null,
			title: 'Untitled board',
			classCanEdit: false,
		})
		const snapshot = await runInDurableObject(
			boardStub(boardId),
			async (_instance, state) => ({
				metaKeys: [...(await state.storage.list({ prefix: 'meta:' })).keys()],
				alarm: await state.storage.getAlarm(),
				tables: state.storage.sql
					.exec<{ name: string }>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.toArray()
					.map((row) => row.name),
			}),
		)
		expect(snapshot).toEqual({ metaKeys: [], alarm: null, tables: [] })
		expect(await listShareCodeKeysForBoard(boardId)).toEqual([])
	})

	it('does not move the persisted scene or mint KV keys while idle', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const socket = await connectAndAuth(boardId, hostSecret)
		sockets.push(socket)

		const updatedAtBefore = await readSceneUpdatedAt(boardId)
		const codesBefore = await listShareCodeKeysForBoard(boardId)

		const pingAt = CLIENT_PING_MS
		const started = Date.now()
		socket.ping()
		await socket.waitForFrame((frame) => frame.type === 'pong')
		await new Promise((resolve) => setTimeout(resolve, pingAt))
		socket.ping()
		await socket.waitForFrame(
			(frame) =>
				frame.type === 'pong' &&
				socket.frames.filter((item) => item.type === 'pong').length >= 2,
		)
		const remaining = IDLE_MS - (Date.now() - started)
		if (remaining > 0) {
			await new Promise((resolve) => setTimeout(resolve, remaining))
		}

		const meta = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`,
			{ headers: { 'X-Board-Host': hostSecret } },
		)
		expect(meta.status).toBe(200)

		expect(await readSceneUpdatedAt(boardId)).toBe(updatedAtBefore)
		expect(await listShareCodeKeysForBoard(boardId)).toEqual(codesBefore)
	})
})
