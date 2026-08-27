import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	bootWorker,
	connectAndAuth,
	disposeWorker,
	listShareCodeEntriesForBoard,
	newBoardId,
	randomHostSecret,
} from './helpers/harness'

describe('reconnect does not write share-code KV', () => {
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

	it('does not add or change code:* keys when reconnecting to a board that already has a share code', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()

		const first = await connectAndAuth(boardId, hostSecret)
		sockets.push(first)
		const before = await listShareCodeEntriesForBoard(boardId)
		expect(before).toHaveLength(1)
		expect(before[0]?.key.startsWith('code:')).toBe(true)

		first.close()
		sockets.pop()

		const second = await connectAndAuth(boardId, hostSecret)
		sockets.push(second)
		const after = await listShareCodeEntriesForBoard(boardId)

		expect(after).toEqual(before)
	})
})
