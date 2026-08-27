import { evictDurableObject } from 'cloudflare:test'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	boardStub,
	bootWorker,
	connect,
	connectAndAuth,
	disposeWorker,
	frameHasElement,
	newBoardId,
	randomHostSecret,
	rectangleElement,
} from './helpers/harness'

describe('scene survives a cold Durable Object', () => {
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

	it('reloads a persisted rectangle after eviction', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const element = rectangleElement()
		const mutationId = crypto.randomUUID()

		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)

		owner.send({
			type: 'scene:update',
			elements: [element],
			mutationId,
		})
		await owner.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === mutationId,
		)
		owner.close()

		await evictDurableObject(boardStub(boardId), { webSockets: 'close' })

		const cold = await connect(boardId, { hostSecret })
		sockets.push(cold)
		const sync = await cold.waitForFrame(
			(frame) =>
				frame.type === 'scene:sync' && frameHasElement(frame, element.id),
		)
		expect(frameHasElement(sync, element.id)).toBe(true)
	})
})
