import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	MAX_SCENE_ELEMENTS,
	MAX_SCENE_FRAME_BYTES,
	SCENE_EDIT_NOT_ALLOWED_MESSAGE,
} from '../../src/lib/whiteboard-sync'
import {
	bootWorker,
	connectAndAuth,
	disposeWorker,
	frameHasElement,
	joinCodeCookieHeader,
	listShareCodeKeysForBoard,
	newBoardId,
	randomHostSecret,
	readSceneUpdatedAt,
	rectangleElement,
	shareCodeFromKvKey,
	workerFetch,
} from './helpers/harness'

describe('reliable scene mutation protocol', () => {
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

	it('persists before ack, excludes the writer, and dedupes the same ID', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const writer = await connectAndAuth(boardId, hostSecret)
		const peer = await connectAndAuth(boardId, hostSecret)
		sockets.push(writer, peer)
		const mutationId = crypto.randomUUID()
		const element = {
			id: crypto.randomUUID(),
			type: 'rectangle',
			version: 1,
			versionNonce: 1,
		}
		const update = {
			type: 'scene:update',
			mutationId,
			elements: [element],
			full: true,
		}
		const writerStart = writer.frames.length
		writer.send(update)
		const ack = await writer.waitForFrame(
			(frame) => frame.type === 'scene:ack' && frame.mutationId === mutationId,
		)
		expect(ack.status).toBe('applied')
		const peerFrame = await peer.waitForFrame(
			(frame) =>
				(frame.type === 'scene:update' || frame.type === 'scene:sync') &&
				frameHasElement(frame, element.id),
		)
		expect(frameHasElement(peerFrame, element.id)).toBe(true)
		expect(
			writer.frames.slice(writerStart).filter((frame) => frame.type === 'scene:update'),
		).toEqual([])

		const updatedAt = await readSceneUpdatedAt(boardId)
		writer.send(update)
		const duplicate = await writer.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' &&
				frame.mutationId === mutationId &&
				frame.status === 'duplicate',
		)
		expect(duplicate.status).toBe('duplicate')
		expect(await readSceneUpdatedAt(boardId)).toBe(updatedAt)
		writer.send({
			...update,
			elements: [{ ...element, versionNonce: 2 }],
		})
		const mismatch = await writer.waitForFrame(
			(frame) =>
				frame.type === 'wb:error' && frame.mutationId === mutationId,
		)
		expect(mismatch.code).toBe('malformed_scene')
		expect(mismatch.terminal).toBe(true)

		// Only the latest receipt is retained in the scene row. After another
		// mutation, an older replay is safely absorbed by element LWW and the
		// persisted base revision prevents stale database appState restoration.
		const interveningId = crypto.randomUUID()
		const intervening = { ...element, id: crypto.randomUUID() }
		writer.send({
			type: 'scene:update',
			mutationId: interveningId,
			elements: [intervening],
			full: false,
		})
		await writer.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === interveningId,
		)
		const afterIntervening = await readSceneUpdatedAt(boardId)
		writer.send(update)
		const oldReplay = await writer.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' &&
				frame.mutationId === mutationId &&
				frame.status === 'noop',
		)
		expect(oldReplay.status).toBe('noop')
		expect(await readSceneUpdatedAt(boardId)).toBe(afterIntervening)
	})

	it('rejects malformed elements without broadcasting', async () => {
		const boardId = newBoardId()
		const socket = await connectAndAuth(boardId, randomHostSecret())
		sockets.push(socket)
		const mutationId = crypto.randomUUID()
		socket.send({
			type: 'scene:update',
			mutationId,
			elements: [{ id: 'bad' }],
		})
		const error = await socket.waitForFrame(
			(frame) => frame.type === 'wb:error' && frame.mutationId === mutationId,
		)
		expect(error.code).toBe('malformed_scene')
		expect(error.terminal).toBe(true)
	})

	it('terminally rejects a frozen Editor mutation and accepts a later edit after re-enable', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)
		const [codeKey] = await listShareCodeKeysForBoard(boardId)
		if (!codeKey) throw new Error('Missing share code')

		const editor = await connectAndAuth(boardId, '', {
			headers: {
				Cookie: joinCodeCookieHeader(boardId, shareCodeFromKvKey(codeKey)),
			},
		})
		sockets.push(editor)

		const setGroupEdit = async (classCanEdit: boolean) => {
			const response = await workerFetch(
				`https://example.com/api/whiteboard/boards/${boardId}/meta`,
				{
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/json',
						'X-Board-Host': hostSecret,
					},
					body: JSON.stringify({ classCanEdit }),
				},
			)
			expect(response.status).toBe(200)
		}

		await setGroupEdit(true)
		await editor.waitForFrame(
			(frame) => frame.type === 'wb:role' && frame.canEdit === true,
		)
		await setGroupEdit(false)
		await editor.waitForFrame(
			(frame) => frame.type === 'wb:role' && frame.canEdit === false,
		)

		const rejectedMutationId = crypto.randomUUID()
		const rejectedElement = rectangleElement()
		const rejectedStart = editor.frames.length
		editor.send({
			type: 'scene:update',
			mutationId: rejectedMutationId,
			elements: [rejectedElement],
			full: true,
		})
		const rejected = await editor.waitForFrameAfter(
			rejectedStart,
			(frame) =>
				frame.type === 'wb:error' && frame.mutationId === rejectedMutationId,
			500,
		)
		expect(rejected).toMatchObject({
			code: 'edit_not_allowed',
			message: SCENE_EDIT_NOT_ALLOWED_MESSAGE,
			terminal: true,
		})
		const resyncStart = editor.frames.length
		editor.send({ type: 'scene:request' })
		const authoritative = await editor.waitForFrameAfter(
			resyncStart,
			(frame) => frame.type === 'scene:sync',
		)
		expect(frameHasElement(authoritative, rejectedElement.id)).toBe(false)
		expect(
			editor.frames
				.slice(rejectedStart)
				.some(
					(frame) =>
						frame.type === 'scene:ack' &&
						frame.mutationId === rejectedMutationId,
				),
		).toBe(false)

		await setGroupEdit(true)
		await editor.waitForFrame(
			(frame) =>
				frame.type === 'wb:role' &&
				frame.canEdit === true &&
				editor.frames.indexOf(frame) >= rejectedStart,
		)
		const acceptedMutationId = crypto.randomUUID()
		editor.send({
			type: 'scene:update',
			mutationId: acceptedMutationId,
			elements: [rectangleElement()],
			full: false,
		})
		const accepted = await editor.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === acceptedMutationId,
		)
		expect(accepted.status).toBe('applied')
	})

	it('parses and broadcasts an appState-only mutation without rewriting identical state', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const writer = await connectAndAuth(boardId, hostSecret)
		const peer = await connectAndAuth(boardId, hostSecret)
		sockets.push(writer, peer)
		const element = rectangleElement()
		const database = (appState: Record<string, unknown>) =>
			JSON.stringify({
				type: 'excalidraw',
				version: 2,
				source: 'https://scsfoxchase.tech',
				elements: [element],
				appState,
			})

		const firstId = crypto.randomUUID()
		writer.send({
			type: 'scene:update',
			mutationId: firstId,
			elements: [element],
			full: true,
			baseRevision: 0,
			databaseJson: database({ viewBackgroundColor: '#fff' }),
		})
		await writer.waitForFrame(
			(frame) => frame.type === 'scene:ack' && frame.mutationId === firstId,
		)

		const updatedAt = await readSceneUpdatedAt(boardId)
		const secondId = crypto.randomUUID()
		writer.send({
			type: 'scene:update',
			mutationId: secondId,
			elements: [],
			full: false,
			baseRevision: 1,
			databaseJson: database({ viewBackgroundColor: '#000' }),
		})
		await writer.waitForFrame(
			(frame) => frame.type === 'scene:ack' && frame.mutationId === secondId,
		)
		const sync = await peer.waitForFrame(
			(frame) =>
				frame.type === 'scene:sync' &&
				(frame.appState as Record<string, unknown>)?.viewBackgroundColor ===
					'#000',
		)
		expect(frameHasElement(sync, element.id)).toBe(true)
		expect(await readSceneUpdatedAt(boardId)).toBeGreaterThanOrEqual(updatedAt ?? 0)

		const noOpId = crypto.randomUUID()
		writer.send({
			type: 'scene:update',
			mutationId: noOpId,
			elements: [],
			full: false,
			baseRevision: 2,
			databaseJson: database({ viewBackgroundColor: '#000' }),
		})
		const noOp = await writer.waitForFrame(
			(frame) => frame.type === 'scene:ack' && frame.mutationId === noOpId,
		)
		expect(noOp.status).toBe('noop')

		// The latest-only receipt has now been replaced by the second mutation.
		// Replaying the first mutation must not restore its stale database appState.
		const replayStart = writer.frames.length
		writer.send({
			type: 'scene:update',
			mutationId: firstId,
			elements: [element],
			full: true,
			baseRevision: 0,
			databaseJson: database({ viewBackgroundColor: '#fff' }),
		})
		const replay = await writer.waitForFrameAfter(
			replayStart,
			(frame) =>
				frame.type === 'scene:ack' &&
				frame.mutationId === firstId &&
				frame.status === 'noop',
		)
		expect(replay.status).toBe('noop')
		writer.send({ type: 'scene:request' })
		const current = await writer.waitForFrameAfter(
			writer.frames.length,
			(frame) =>
				frame.type === 'scene:sync' &&
				(frame.appState as Record<string, unknown>)?.viewBackgroundColor ===
					'#000',
		)
		expect(
			(current.appState as Record<string, unknown>).viewBackgroundColor,
		).toBe('#000')
	})

	it('keeps legacy no-ID oversize and fatal UTF-8 frames terminal', async () => {
		const boardId = newBoardId()
		const socket = await connectAndAuth(boardId, randomHostSecret())
		sockets.push(socket)
		socket.webSocket.send('x'.repeat(MAX_SCENE_FRAME_BYTES + 1))
		const oversized = await socket.waitForFrame(
			(frame) => frame.type === 'wb:error' && frame.mutationId === null,
		)
		expect(oversized.code).toBe('scene_too_large')
		expect(oversized.terminal).toBe(true)

		socket.webSocket.send(Uint8Array.from([0xff, 0xfe]))
		const utf8 = await socket.waitForFrameAfter(
			socket.frames.length,
			(frame) => frame.type === 'wb:error' && frame.mutationId === null,
		)
		expect(utf8.code).toBe('malformed_scene')
		expect(utf8.terminal).toBe(true)
	})

	it('accepts exact text and binary frame limits and rejects the next byte', async () => {
		const boardId = newBoardId()
		const socket = await connectAndAuth(boardId, randomHostSecret())
		sockets.push(socket)
		const textMutationId = crypto.randomUUID()
		const textBase = JSON.stringify({
			type: 'scene:update',
			mutationId: textMutationId,
			elements: [],
			full: false,
		})
		const textExact = `${textBase}${' '.repeat(
			MAX_SCENE_FRAME_BYTES - new TextEncoder().encode(textBase).byteLength,
		)}`
		expect(new TextEncoder().encode(textExact).byteLength).toBe(
			MAX_SCENE_FRAME_BYTES,
		)
		const textStart = socket.frames.length
		socket.webSocket.send(textExact)
		const textAck = await socket.waitForFrameAfter(
			textStart,
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === textMutationId,
		)
		expect(textAck.status).toBe('noop')

		const binaryMutationId = crypto.randomUUID()
		const binaryBase = JSON.stringify({
			type: 'scene:update',
			mutationId: binaryMutationId,
			elements: [],
			full: false,
		})
		const binaryExact = `${binaryBase}${' '.repeat(
			MAX_SCENE_FRAME_BYTES - new TextEncoder().encode(binaryBase).byteLength,
		)}`
		expect(new TextEncoder().encode(binaryExact).byteLength).toBe(
			MAX_SCENE_FRAME_BYTES,
		)
		const binaryStart = socket.frames.length
		socket.webSocket.send(new TextEncoder().encode(binaryExact))
		const binaryAck = await socket.waitForFrameAfter(
			binaryStart,
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === binaryMutationId,
		)
		expect(binaryAck.status).toBe('noop')

		const tooLargeStart = socket.frames.length
		socket.webSocket.send(`${textExact} `)
		const error = await socket.waitForFrameAfter(
			tooLargeStart,
			(frame) => frame.type === 'wb:error',
		)
		expect(error.code).toBe('scene_too_large')
		expect(error.terminal).toBe(true)
	})

	it('accepts exactly 4,000 elements and rejects 4,001', async () => {
		const boardId = newBoardId()
		const socket = await connectAndAuth(boardId, randomHostSecret())
		sockets.push(socket)
		const elements = Array.from({ length: MAX_SCENE_ELEMENTS }, (_, index) => ({
			...rectangleElement(),
			id: `element-${index}`,
		}))
		const mutationId = crypto.randomUUID()
		socket.send({
			type: 'scene:update',
			mutationId,
			elements,
			full: true,
		})
		const ack = await socket.waitForFrame(
			(frame) => frame.type === 'scene:ack' && frame.mutationId === mutationId,
		)
		expect(ack.status).toBe('applied')

		const tooManyId = crypto.randomUUID()
		socket.send({
			type: 'scene:update',
			mutationId: tooManyId,
			elements: [...elements, rectangleElement()],
		})
		const error = await socket.waitForFrame(
			(frame) => frame.type === 'wb:error' && frame.mutationId === tooManyId,
		)
		expect(error.code).toBe('scene_too_large')
		expect(error.terminal).toBe(true)
	})
})
