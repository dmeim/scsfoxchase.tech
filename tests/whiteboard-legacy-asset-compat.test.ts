import { describe, expect, it, vi } from 'vitest'
import {
	boardAssetR2Key,
	handleAssetRequest,
	r2ObjectKey,
} from '../src/worker/assetRoutes'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const FILE_ID = '22222222-2222-4222-8222-222222222222'
const HOST_SECRET = 'legacy-host-secret'
const LEGACY_BYTES = new Uint8Array([1, 2, 3])

function createHarness(options?: { revealedOwnerKey?: string }) {
	const objects = new Set<string>()
	const bucket = {
		head: vi.fn(async (key: string) =>
			objects.has(key) ? { key } : null,
		),
		put: vi.fn(async (key: string) => {
			objects.add(key)
			return null
		}),
		get: vi.fn(async (key: string) => {
			if (!objects.has(key)) return null
			return {
				key,
				size: LEGACY_BYTES.byteLength,
				httpEtag: '"etag"',
				uploaded: new Date(),
				customMetadata: { kind: 'persistent' },
				writeHttpMetadata(headers: Headers) {
					headers.set('Content-Type', 'image/png')
				},
				body: LEGACY_BYTES,
			}
		}),
		delete: vi.fn(async (key: string | string[]) => {
			for (const item of Array.isArray(key) ? key : [key]) objects.delete(item)
		}),
	}
	const stub = {
		assertAssetWriteAccess: vi.fn(async () => ({ ok: true as const })),
		registerBoardAssetManifest: vi.fn(async (manifest: unknown) => manifest),
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
			body: LEGACY_BYTES,
		},
	)
}

describe('legacy whiteboard canvas upload compatibility', () => {
	it('writes only the owner-key object when a legacy canvas PUT carries X-Board-Id', async () => {
		const { env, bucket, stub, objects } = createHarness()
		const ownerKey = `temp:${BOARD_ID}`
		const ownerKeyR2 = r2ObjectKey(ownerKey, FILE_ID)

		const response = await handleAssetRequest(legacyRequest(ownerKey), env)

		expect(response?.status).toBe(201)
		expect(await response!.json()).toEqual({
			ok: true,
			ownerKey,
			assetId: FILE_ID,
			r2Key: ownerKeyR2,
			size: 3,
			mimeType: 'image/png',
		})
		expect([...objects]).toEqual([ownerKeyR2])
		expect(bucket.put).toHaveBeenCalledTimes(1)
		expect(bucket.put).toHaveBeenCalledWith(
			ownerKeyR2,
			expect.any(Uint8Array),
			expect.any(Object),
		)
		expect(objects.has(boardAssetR2Key(BOARD_ID, FILE_ID))).toBe(false)
		expect(stub.registerBoardAssetManifest).not.toHaveBeenCalled()
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

	it('does not mirror preview uploads', async () => {
		const { env, bucket, stub, objects } = createHarness()
		const ownerKey = `temp:${BOARD_ID}`
		const response = await handleAssetRequest(
			legacyRequest(ownerKey, { 'X-Whiteboard-Kind': 'preview' }),
			env,
		)

		expect(response?.status).toBe(201)
		expect(bucket.put).toHaveBeenCalledTimes(1)
		expect([...objects]).toEqual([r2ObjectKey(ownerKey, FILE_ID)])
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
					body: LEGACY_BYTES,
				},
			),
			env,
		)

		expect(response?.status).toBe(201)
		expect(bucket.put).toHaveBeenCalledTimes(1)
		expect(stub.registerBoardAssetManifest).toHaveBeenCalledTimes(1)
	})

	it('still serves legacy owner-key GET for old library objects', async () => {
		const { env, bucket, objects } = createHarness()
		const ownerKey = 'google:library-owner'
		const key = r2ObjectKey(ownerKey, FILE_ID)
		objects.add(key)

		const response = await handleAssetRequest(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/assets/${encodeURIComponent(ownerKey)}/${FILE_ID}`,
			),
			env,
		)

		expect(response?.status).toBe(200)
		expect(bucket.get).toHaveBeenCalledWith(key, expect.any(Object))
		expect(bucket.get).not.toHaveBeenCalledWith(
			boardAssetR2Key(BOARD_ID, FILE_ID),
			expect.anything(),
		)
		expect(Array.from(new Uint8Array(await response!.arrayBuffer()))).toEqual([
			1, 2, 3,
		])
	})
})
