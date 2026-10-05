import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildWhiteboardConnectUrl } from '../../src/lib/whiteboard-sync'
import {
	boardStub,
	bootWorker,
	connectAndAuth,
	disposeWorker,
	newBoardId,
	PNG_1X1,
	randomHostSecret,
	rectangleElement,
	TestSocket,
	WORKER_ORIGIN,
	workerFetch,
} from './helpers/harness'

function mediaUrl(boardId: string, fileId: string): string {
	return `${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/assets/${fileId}`
}

async function seedScene(
	boardId: string,
	elements: unknown[],
	ownerKey?: string,
	legacy = false,
): Promise<void> {
	await runInDurableObject(boardStub(boardId), async (_instance, state) => {
		await state.storage.put('meta:boardId', boardId)
		await state.storage.put('meta:savedToLibrary', Boolean(ownerKey))
		if (ownerKey) await state.storage.put('meta:cloudOwnerKey', ownerKey)
		const column = legacy ? 'live_json' : 'scene_json'
		state.storage.sql.exec(
			`CREATE TABLE excalidraw_scene (id INTEGER PRIMARY KEY, ${column} TEXT, updated_at INTEGER)`,
		)
		state.storage.sql.exec(
			`INSERT INTO excalidraw_scene (id, ${column}, updated_at) VALUES (1, ?, ?)`,
			JSON.stringify({ elements, appState: {} }),
			123,
		)
	})
}

async function storageSnapshot(boardId: string) {
	return runInDurableObject(boardStub(boardId), async (_instance, state) => ({
		meta: [...(await state.storage.list({ prefix: 'meta:' })).entries()],
		alarm: await state.storage.getAlarm(),
		schema: state.storage.sql.exec<{ sql: string }>(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		).toArray(),
	}))
}

const sockets: TestSocket[] = []
beforeAll(bootWorker)
afterEach(() => {
	while (sockets.length) sockets.pop()?.close()
})
afterAll(disposeWorker)

describe('reference-checked board legacy images', () => {
	it('serves saved legacy images by UUID without exposing the hidden owner, including HEAD, range and ETag', async () => {
		const boardId = newBoardId()
		const fileId = crypto.randomUUID()
		const ownerKey = `google:${crypto.randomUUID()}`
		await seedScene(boardId, [{ ...rectangleElement(), type: 'image', fileId }], ownerKey, true)
		await env.WHITEBOARD_ASSETS.put(`assets/${ownerKey}/${fileId}`, PNG_1X1, {
			httpMetadata: { contentType: 'image/png' },
		})
		const before = await storageSnapshot(boardId)
		const fetched = await workerFetch(mediaUrl(boardId, fileId))
		expect(fetched.status).toBe(200)
		expect(fetched.headers.get('Content-Type')).toBe('image/png')
		expect(fetched.headers.get('Accept-Ranges')).toBe('bytes')
		expect([...fetched.headers.values()].join(' ')).not.toContain(ownerKey)
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_1X1)
		const etag = fetched.headers.get('ETag')!
		expect(etag).toBeTruthy()

		const head = await workerFetch(mediaUrl(boardId, fileId), { method: 'HEAD' })
		expect(head.status).toBe(200)
		expect(head.headers.get('ETag')).toBe(etag)
		expect((await head.arrayBuffer()).byteLength).toBe(0)
		const range = await workerFetch(mediaUrl(boardId, fileId), {
			headers: { Range: 'bytes=0-7' },
		})
		expect(range.status).toBe(206)
		expect(range.headers.get('Content-Range')).toBe(`bytes 0-7/${PNG_1X1.length}`)
		expect(new Uint8Array(await range.arrayBuffer())).toEqual(PNG_1X1.slice(0, 8))
		const conditional = await workerFetch(mediaUrl(boardId, fileId), {
			headers: { 'If-None-Match': etag },
		})
		expect(conditional.status).toBe(304)
		expect(await storageSnapshot(boardId)).toEqual(before)
		const viewer = await connectAndAuth(boardId, '')
		sockets.push(viewer)
		expect((await viewer.waitForFrame((frame) => frame.type === 'wb:hello')).role).toBe('viewer')
		const meta = await workerFetch(`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`)
		expect((await meta.json() as { cloudOwnerKey: unknown }).cloudOwnerKey).toBeNull()
		expect((await workerFetch(mediaUrl(boardId, fileId))).status).toBe(200)
	})

	it('denies unreferenced, deleted, non-image and foreign-owner files', async () => {
		const boardId = newBoardId()
		const ownerKey = `google:${crypto.randomUUID()}`
		const foreignOwner = `google:${crypto.randomUUID()}`
		const ids = Array.from({ length: 4 }, () => crypto.randomUUID())
		await seedScene(boardId, [
			{ ...rectangleElement(), type: 'image', fileId: ids[1], isDeleted: true },
			{ ...rectangleElement(), fileId: ids[2] },
			{ ...rectangleElement(), type: 'image', fileId: ids[3] },
		], ownerKey)
		for (const [index, id] of ids.entries()) {
			const storedOwner = index === 3 ? foreignOwner : ownerKey
			await env.WHITEBOARD_ASSETS.put(`assets/${storedOwner}/${id}`, PNG_1X1)
			const response = await workerFetch(
				`${mediaUrl(boardId, id)}?owner=${encodeURIComponent(storedOwner)}`,
				{ headers: { 'X-Board-Owner': storedOwner } },
			)
			expect(response.status).toBe(404)
		}
	})

	it('uses temp fallback only for valid board image references and leaves scratch metadata unchanged', async () => {
		const boardId = newBoardId()
		const fileId = crypto.randomUUID()
		const unrelated = crypto.randomUUID()
		await seedScene(boardId, [{ ...rectangleElement(), type: 'image', fileId }])
		for (const id of [fileId, unrelated]) {
			await env.WHITEBOARD_ASSETS.put(`assets/temp:${boardId}/${id}`, PNG_1X1)
		}
		const before = await storageSnapshot(boardId)
		expect((await workerFetch(mediaUrl(boardId, fileId))).status).toBe(200)
		expect((await workerFetch(mediaUrl(boardId, unrelated))).status).toBe(404)
		expect(await storageSnapshot(boardId)).toEqual(before)
	})

	it('tries only the persisted cloud owner before the board temp fallback', async () => {
		const boardId = newBoardId()
		const fileId = crypto.randomUUID()
		const ownerKey = `google:${crypto.randomUUID()}`
		await seedScene(boardId, [{ ...rectangleElement(), type: 'image', fileId }], ownerKey)
		await env.WHITEBOARD_ASSETS.put(`assets/temp:${boardId}/${fileId}`, PNG_1X1)
		const before = await storageSnapshot(boardId)
		const fetched = await workerFetch(mediaUrl(boardId, fileId))
		expect(fetched.status).toBe(200)
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_1X1)
		expect(await storageSnapshot(boardId)).toEqual(before)
		expect(await boardStub(boardId).referencedImageOwners({ boardId, fileId })).toEqual({
			ownerKeys: [ownerKey, `temp:${boardId}`], savedToLibrary: true,
		})
		expect(await boardStub(boardId).referencedImageOwners({ boardId: newBoardId(), fileId })).toEqual({
			ownerKeys: [], savedToLibrary: false,
		})
	})

	it('does not initialize unknown UUIDs or accept expired scratch references', async () => {
		const unknown = newBoardId()
		const fileId = crypto.randomUUID()
		await env.WHITEBOARD_ASSETS.put(`assets/temp:${unknown}/${fileId}`, PNG_1X1)
		expect((await workerFetch(mediaUrl(unknown, fileId))).status).toBe(404)
		expect(await storageSnapshot(unknown)).toEqual({ meta: [], alarm: null, schema: [] })

		const expired = newBoardId()
		await seedScene(expired, [{ ...rectangleElement(), type: 'image', fileId }])
		await runInDurableObject(boardStub(expired), async (_instance, state) => {
			await state.storage.put('meta:unsavedExpiresAt', new Date(0).toISOString())
		})
		await env.WHITEBOARD_ASSETS.put(`assets/temp:${expired}/${fileId}`, PNG_1X1)
		const before = await storageSnapshot(expired)
		expect((await workerFetch(mediaUrl(expired, fileId))).status).toBe(404)
		expect(await storageSnapshot(expired)).toEqual(before)
	})
})

async function openGuest(boardId: string): Promise<TestSocket> {
	const sessionId = crypto.randomUUID()
	const url = buildWhiteboardConnectUrl(WORKER_ORIGIN, {
		boardId, sessionId, userId: crypto.randomUUID(), displayName: 'Test guest',
	})
	const response = await workerFetch(url, { headers: { Upgrade: 'websocket' } })
	if (response.status !== 101 || !response.webSocket) throw new Error('Upgrade failed')
	const socket = new TestSocket(response.webSocket, sessionId, response)
	sockets.push(socket)
	response.webSocket.accept()
	socket.send({ type: 'wb:auth' })
	await socket.waitForFrame((frame) => frame.type === 'wb:hello')
	return socket
}

describe('authoritative Group Edit broadcasts', () => {
	for (const withEditor of [false, true]) {
		it(`notifies Owner and Manager${withEditor ? ' and updates Editors' : ' even without Editors'}`, async () => {
			const boardId = newBoardId()
			const hostSecret = randomHostSecret()
			const owner = await connectAndAuth(boardId, hostSecret)
			sockets.push(owner)
			const manager = await openGuest(boardId)
			const editor = withEditor ? await openGuest(boardId) : null
			for (const [socket, role] of [[manager, 'manager'], ...(editor ? [[editor, 'editor']] : [])] as Array<[TestSocket, string]>) {
				const response = await workerFetch(
					`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/participants/${socket.sessionId}`,
					{
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json', 'X-Board-Host': hostSecret },
						body: JSON.stringify({ role }),
					},
				)
				expect(response.status).toBe(200)
				await socket.waitForFrame((frame) => frame.type === 'wb:role' && frame.role === role)
			}

			for (const allowEdits of [true, false]) {
				const clients = [owner, manager, ...(editor ? [editor] : [])]
				const starts = clients.map((socket) => socket.frames.length)
				const response = await workerFetch(`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json', 'X-Board-Host': hostSecret },
					body: JSON.stringify({ classCanEdit: allowEdits }),
				})
				expect(response.status).toBe(200)
				for (const [index, socket] of clients.entries()) {
					const gate = await socket.waitForFrameAfter(starts[index]!, (frame) => frame.type === 'wb:editGate')
					expect(gate).toEqual({ type: 'wb:editGate', allowEdits })
				}
				if (editor) {
					await editor.waitForFrameAfter(starts[2]!, (frame) => frame.type === 'wb:role' && frame.canEdit === allowEdits)
				}
			}
		})
	}
})
