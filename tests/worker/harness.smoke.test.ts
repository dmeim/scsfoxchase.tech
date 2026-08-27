import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	bootWorker,
	disposeWorker,
	newBoardId,
	upgradeConnect,
	workerFetch,
	WORKER_ORIGIN,
} from './helpers/harness'

describe('worker harness smoke', () => {
	beforeAll(async () => {
		await bootWorker()
	})

	afterAll(async () => {
		await disposeWorker()
	})

	it('responds to a basic HTTP request', async () => {
		const response = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/version`,
		)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { sha?: unknown }
		expect(typeof body.sha).toBe('string')
	})

	it('upgrades a WebSocket to /api/whiteboard/connect/{uuid}', async () => {
		const response = await upgradeConnect(newBoardId())
		expect(response.status).toBe(101)
		expect(response.webSocket).toBeTruthy()
		response.webSocket?.accept()
		response.webSocket?.close(1000, 'smoke')
	})

	it('rejects a non-UUID board id with 400', async () => {
		const response = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/connect/not-a-uuid`,
			{
				headers: {
					Upgrade: 'websocket',
					Connection: 'Upgrade',
				},
			},
		)
		expect(response.status).toBe(400)
	})

	it('rejects connect without Upgrade: websocket with 426', async () => {
		const response = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/connect/${newBoardId()}`,
		)
		expect(response.status).toBe(426)
	})
})
