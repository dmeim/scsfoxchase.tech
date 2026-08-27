import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	bootWorker,
	disposeWorker,
	newBoardId,
	PNG_1X1,
	WORKER_ORIGIN,
	workerFetch,
} from './helpers/harness'

function boardAssetUrl(boardId: string, fileId: string): string {
	return `${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/assets/${fileId}`
}

describe('read-only board-scoped asset compatibility', () => {
	beforeAll(async () => {
		await bootWorker()
	})

	afterAll(async () => {
		await disposeWorker()
	})

	it('serves existing UUID and content-hash objects directly from R2', async () => {
		const boardId = newBoardId()
		const ids = [crypto.randomUUID(), 'a'.repeat(64)]

		for (const fileId of ids) {
			await env.WHITEBOARD_ASSETS.put(
				`boards/${boardId}/assets/${fileId}`,
				PNG_1X1,
				{ httpMetadata: { contentType: 'image/png' } },
			)

			const fetched = await workerFetch(boardAssetUrl(boardId, fileId))
			expect(fetched.status).toBe(200)
			expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_1X1)

			const head = await workerFetch(boardAssetUrl(boardId, fileId), {
				method: 'HEAD',
			})
			expect(head.status).toBe(200)
			expect((await head.arrayBuffer()).byteLength).toBe(0)
		}
	})

	it('rejects board-scoped writes and deletes', async () => {
		const url = boardAssetUrl(newBoardId(), crypto.randomUUID())
		const put = await workerFetch(url, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: PNG_1X1,
		})
		expect(put.status).toBe(405)

		const del = await workerFetch(url, { method: 'DELETE' })
		expect(del.status).toBe(405)
	})

	it('returns 404 for a missing board-scoped object', async () => {
		const response = await workerFetch(
			boardAssetUrl(newBoardId(), crypto.randomUUID()),
		)
		expect(response.status).toBe(404)
	})

	it('still serves legacy owner-key assets for pre-rollout boards', async () => {
		const ownerKey = `google:${crypto.randomUUID()}`
		const fileId = crypto.randomUUID()
		await env.WHITEBOARD_ASSETS.put(`assets/${ownerKey}/${fileId}`, PNG_1X1, {
			httpMetadata: { contentType: 'image/png' },
		})

		const fetched = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/assets/${encodeURIComponent(ownerKey)}/${fileId}`,
		)
		expect(fetched.status).toBe(200)
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_1X1)
	})
})
