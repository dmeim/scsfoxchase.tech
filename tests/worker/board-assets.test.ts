import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	bootWorker,
	connectAndAuth,
	disposeWorker,
	newBoardId,
	PNG_1X1,
	randomHostSecret,
	WORKER_ORIGIN,
	workerFetch,
} from './helpers/harness'

function boardAssetUrl(boardId: string, fileId: string): string {
	return `${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/assets/${fileId}`
}

describe('board-scoped asset PUT / GET', () => {
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

	it('PUT 201s, GET returns identical PNG bytes, and bad writes / missing keys fail closed', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const fileId = crypto.randomUUID()
		const missingId = crypto.randomUUID()
		const socket = await connectAndAuth(boardId, hostSecret)
		sockets.push(socket)

		const created = await workerFetch(boardAssetUrl(boardId, fileId), {
			method: 'PUT',
			headers: {
				'Content-Type': 'image/png',
				'X-Board-Host': hostSecret,
			},
			body: PNG_1X1,
		})
		expect(created.status).toBe(201)

		const fetched = await workerFetch(boardAssetUrl(boardId, fileId))
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_1X1)

		const unauthenticated = await workerFetch(
			boardAssetUrl(boardId, crypto.randomUUID()),
			{
				method: 'PUT',
				headers: { 'Content-Type': 'image/png' },
				body: PNG_1X1,
			},
		)
		expect(unauthenticated.status).toBe(401)

		const wrongType = await workerFetch(
			boardAssetUrl(boardId, crypto.randomUUID()),
			{
				method: 'PUT',
				headers: {
					'Content-Type': 'image/bmp',
					'X-Board-Host': hostSecret,
				},
				body: PNG_1X1,
			},
		)
		expect(wrongType.status).toBe(415)

		const missing = await workerFetch(boardAssetUrl(boardId, missingId))
		expect(missing.status).toBe(404)
	})

	// Image hydrate falls back to this route for boards created before
	// board-scoped keys (`hydrateLegacyOwnerImage`). If the route goes away,
	// those boards silently stop painting their images.
	it('still serves legacy owner-key assets that predate board-scoped keys', async () => {
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

	it('accepts a content-addressed PUT and rejects bytes that do not match the id', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const socket = await connectAndAuth(boardId, hostSecret)
		sockets.push(socket)

		const digest = await crypto.subtle.digest('SHA-256', PNG_1X1)
		const hashId = Array.from(new Uint8Array(digest), (b) =>
			b.toString(16).padStart(2, '0'),
		).join('')
		expect(hashId).toMatch(/^[0-9a-f]{64}$/)

		const created = await workerFetch(boardAssetUrl(boardId, hashId), {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png', 'X-Board-Host': hostSecret },
			body: PNG_1X1,
		})
		expect(created.status).toBe(201)

		const fetched = await workerFetch(boardAssetUrl(boardId, hashId))
		expect(fetched.status).toBe(200)
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_1X1)

		const wrongHash = 'a'.repeat(64)
		const mismatched = await workerFetch(boardAssetUrl(boardId, wrongHash), {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png', 'X-Board-Host': hostSecret },
			body: PNG_1X1,
		})
		expect(mismatched.status).toBe(400)
	})

	it('GET of an uploaded board asset is HTTP 200', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const fileId = crypto.randomUUID()
		const socket = await connectAndAuth(boardId, hostSecret)
		sockets.push(socket)
		const created = await workerFetch(boardAssetUrl(boardId, fileId), {
			method: 'PUT',
			headers: {
				'Content-Type': 'image/png',
				'X-Board-Host': hostSecret,
			},
			body: PNG_1X1,
		})
		expect(created.status).toBe(201)
		const fetched = await workerFetch(boardAssetUrl(boardId, fileId))
		expect(fetched.status).toBe(200)
	})
})
