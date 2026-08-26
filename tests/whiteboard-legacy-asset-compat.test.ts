import { describe, expect, it, vi } from 'vitest'
import {
	boardAssetR2Key,
	handleAssetRequest,
	r2ObjectKey,
} from '../src/worker/assetRoutes'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const FILE_ID = '22222222-2222-4222-8222-222222222222'
const HOST_SECRET = 'legacy-host-secret'

function createHarness(options?: {
	manifestFails?: boolean
	revealedOwnerKey?: string
}) {
	const objects = new Set<string>()
	const bucket = {
		head: vi.fn(async (key: string) =>
			objects.has(key) ? { key } : null,
		),
		put: vi.fn(async (key: string) => {
			objects.add(key)
			return null
		}),
		delete: vi.fn(async (key: string | string[]) => {
			for (const item of Array.isArray(key) ? key : [key]) objects.delete(item)
		}),
	}
	const stub = {
		assertAssetWriteAccess: vi.fn(async () => ({ ok: true as const })),
		registerBoardAssetManifest: options?.manifestFails
			? vi.fn(async () => {
					throw new Error('manifest unavailable')
				})
			: vi.fn(async (manifest: unknown) => manifest),
		fetch: vi.fn(async () =>
			Response.json({ cloudOwnerKey: options?.revealedOwnerKey ?? null }),
		),
	}
	const env = {
		WHITEBOARD_ASSETS: bucket,
		WHITEBOARDS: {
			idFromName: vi.fn((id: string) => id),
			get: vi.fn(() => stub),
		},
	} as unknown as Env

	return { env, bucket, stub, objects }
}

function legacyRequest(ownerKey: string, extraHeaders?: HeadersInit): Request {
	return new Request(
		`https://scsfoxchase.tech/api/whiteboard/assets/${encodeURIComponent(ownerKey)}/${FILE_ID}`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': 'image/png',
				'X-Board-Id': BOARD_ID,
				'X-Board-Host': HOST_SECRET,
				...extraHeaders,
			},
			body: new Uint8Array([1, 2, 3]),
		},
	)
}

describe('legacy whiteboard canvas upload compatibility', () => {
	it('makes the canonical object and manifest ready before returning 201', async () => {
		const { env, bucket, stub, objects } = createHarness()
		const ownerKey = `temp:${BOARD_ID}`

		const response = await handleAssetRequest(legacyRequest(ownerKey), env)

		expect(response?.status).toBe(201)
		expect([...objects]).toEqual([
			r2ObjectKey(ownerKey, FILE_ID),
			boardAssetR2Key(BOARD_ID, FILE_ID),
		])
		expect(bucket.put).toHaveBeenCalledTimes(2)
		expect(stub.registerBoardAssetManifest).toHaveBeenCalledWith({
			boardId: BOARD_ID,
			fileId: FILE_ID,
			r2Key: boardAssetR2Key(BOARD_ID, FILE_ID),
			mimeType: 'image/png',
			size: 3,
		})
	})

	it('rejects a google owner key that does not belong to the verified board', async () => {
		const { env, bucket } = createHarness({
			revealedOwnerKey: 'google:actual-owner',
		})
		const request = legacyRequest('google:different-owner', {
			'X-Board-Host': '',
			'X-Board-Session': 'live-editor-session',
			'X-Board-Auth': 'live-editor-proof',
		})

		const response = await handleAssetRequest(request, env)

		expect(response?.status).toBe(403)
		expect(bucket.put).not.toHaveBeenCalled()
	})

	it('fails closed when a legacy google canvas upload supplies an invalid board id', async () => {
		const { env, bucket } = createHarness()
		const response = await handleAssetRequest(
			legacyRequest('google:owner', { 'X-Board-Id': 'not-a-board-id' }),
			env,
		)

		expect(response?.status).toBe(400)
		expect(bucket.put).not.toHaveBeenCalled()
	})

	it('cleans up newly created objects when manifest registration fails', async () => {
		const { env, bucket, objects } = createHarness({ manifestFails: true })
		const ownerKey = `temp:${BOARD_ID}`

		const response = await handleAssetRequest(legacyRequest(ownerKey), env)

		expect(response?.status).toBe(503)
		expect(bucket.delete).toHaveBeenCalledTimes(2)
		expect(objects.size).toBe(0)
	})

	it('does not mirror preview uploads', async () => {
		const { env, bucket, stub } = createHarness()
		const response = await handleAssetRequest(
			legacyRequest(`temp:${BOARD_ID}`, { 'X-Whiteboard-Kind': 'preview' }),
			env,
		)

		expect(response?.status).toBe(201)
		expect(bucket.put).toHaveBeenCalledTimes(1)
		expect(stub.registerBoardAssetManifest).not.toHaveBeenCalled()
	})

	it('leaves the current board-scoped upload path unchanged', async () => {
		const { env, bucket, stub } = createHarness()
		const response = await handleAssetRequest(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${BOARD_ID}/assets/${FILE_ID}`,
				{
					method: 'PUT',
					headers: {
						'Content-Type': 'image/png',
						'X-Board-Id': BOARD_ID,
						'X-Board-Host': HOST_SECRET,
					},
					body: new Uint8Array([1, 2, 3]),
				},
			),
			env,
		)

		expect(response?.status).toBe(201)
		expect(bucket.put).toHaveBeenCalledTimes(1)
		expect(stub.registerBoardAssetManifest).toHaveBeenCalledTimes(1)
	})
})
