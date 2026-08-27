import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	bootWorker,
	collectFrames,
	connectAndAuth,
	disposeWorker,
	frameHasElement,
	newBoardId,
	randomHostSecret,
	rectangleElement,
} from './helpers/harness'

describe('writer is excluded from full scene broadcasts', () => {
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

	it('echoes the update to the other socket, not a scene:sync back to the writer', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const element = rectangleElement()
		const mutationId = crypto.randomUUID()

		const writer = await connectAndAuth(boardId, hostSecret)
		const peer = await connectAndAuth(boardId, hostSecret)
		sockets.push(writer, peer)

		const writerMark = writer.frames.length
		writer.send({
			type: 'scene:update',
			elements: [element],
			mutationId,
		})

		await writer.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === mutationId,
		)
		const peerFrame = await peer.waitForFrame(
			(frame) =>
				(frame.type === 'scene:update' || frame.type === 'scene:sync') &&
				frameHasElement(frame, element.id),
		)
		expect(frameHasElement(peerFrame, element.id)).toBe(true)

		await collectFrames(writer, 750)
		const echoedSync = writer.frames
			.slice(writerMark)
			.filter((frame) => frame.type === 'scene:sync')
		expect(echoedSync).toEqual([])
	})
})
