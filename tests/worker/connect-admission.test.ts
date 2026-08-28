import { runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import worker from '../../src/worker'
import {
	admitWhiteboardConnect,
	consumeLocalConnectAdmission,
	CONNECT_RATE_LIMIT,
	LOCAL_CONNECT_BUCKET_MAX,
	LOCAL_CONNECT_WINDOW_MS,
	localConnectAdmissionSize,
	resetLocalConnectAdmissionForTests,
	trustedConnectRateLimitKey,
	isValidConnectSessionId,
} from '../../src/worker/connectAdmission'
import {
	boardStub,
	connect,
	connectAndAuth,
	frameHasElement,
	listShareCodeKeysForBoard,
	newBoardId,
	randomHostSecret,
	rectangleElement,
	upgradeConnect,
	waitForHello,
	WORKER_ORIGIN,
} from './helpers/harness'

afterEach(() => {
	resetLocalConnectAdmissionForTests()
})

describe('whiteboard connection admission', () => {
	it('accepts only strict UUID session handles and keys by CF-Connecting-IP', () => {
		const valid = crypto.randomUUID()
		expect(isValidConnectSessionId(valid)).toBe(true)
		expect(isValidConnectSessionId(`${valid}x`)).toBe(false)
		expect(isValidConnectSessionId('not-a-session')).toBe(false)
		expect(
			trustedConnectRateLimitKey(
				new Request(`${WORKER_ORIGIN}/api/whiteboard/connect`, {
					headers: {
						'CF-Connecting-IP': '203.0.113.7',
						'X-Forwarded-For': '198.51.100.9',
					},
				}),
			),
		).toBe('203.0.113.7')
	})

	it('keeps the local fallback at its hard cap and prunes expired keys', () => {
		const started = 10_000
		for (let index = 0; index < LOCAL_CONNECT_BUCKET_MAX; index += 1) {
			const result = consumeLocalConnectAdmission(`ip-${index}`, started)
			expect(result.allowed).toBe(true)
		}
		expect(localConnectAdmissionSize()).toBe(LOCAL_CONNECT_BUCKET_MAX)

		// A new distinct key evicts before insertion, so the map never observes
		// 4097 entries even at the exact boundary.
		expect(consumeLocalConnectAdmission('new-ip', started).allowed).toBe(true)
		expect(localConnectAdmissionSize()).toBe(LOCAL_CONNECT_BUCKET_MAX)
		expect(
			consumeLocalConnectAdmission(
				'after-expiry',
				started + LOCAL_CONNECT_WINDOW_MS,
			).allowed,
		).toBe(true)
		expect(localConnectAdmissionSize()).toBe(1)
	})

	it('uses the platform limiter and fails closed if it is unavailable', async () => {
		const keys: string[] = []
		const request = new Request(`${WORKER_ORIGIN}/api/whiteboard/connect`, {
			headers: { 'CF-Connecting-IP': '192.0.2.20' },
		})
		await expect(
			admitWhiteboardConnect(request, {
				WHITEBOARD_CONNECT_LIMITER: {
					limit: async ({ key }) => {
						keys.push(key)
						return { success: true }
					},
				},
			}),
		).resolves.toBeNull()
		expect(keys).toEqual(['192.0.2.20'])

		const rejected = await admitWhiteboardConnect(request, {
			WHITEBOARD_CONNECT_LIMITER: {
				limit: async () => ({ success: false }),
			},
		})
		expect(rejected?.status).toBe(429)

		const unavailable = await admitWhiteboardConnect(request, {
			WHITEBOARD_CONNECT_LIMITER: {
				limit: async () => {
					throw new Error('ignored')
				},
			},
		})
		expect(unavailable?.status).toBe(503)
	})

	it('stops a random UUID flood before resolving more Durable Object stubs', async () => {
		let resolved = 0
		const env = {
			WHITEBOARDS: {
				idFromName: (name: string) => name,
				get: () => {
					resolved += 1
					return { fetch: async () => new Response('accepted') }
				},
			},
		} as unknown as Env
		const ctx = {
			waitUntil: () => undefined,
			passThroughOnException: () => undefined,
		} as unknown as ExecutionContext
		for (let index = 0; index < CONNECT_RATE_LIMIT + 1; index += 1) {
			const response = await worker.fetch(
				new Request(
					`${WORKER_ORIGIN}/api/whiteboard/connect/${crypto.randomUUID()}?sessionId=${crypto.randomUUID()}`,
					{
						headers: {
							Upgrade: 'websocket',
							'CF-Connecting-IP': '198.51.100.200',
							'X-Board-Host': `untrusted-${index}`,
						},
					},
				),
				env,
				ctx,
			)
			if (index === CONNECT_RATE_LIMIT) expect(response.status).toBe(429)
		}
		expect(resolved).toBe(CONNECT_RATE_LIMIT)
	})

	it('keeps random unauthenticated upgrades write-free, including arbitrary host headers', async () => {
		const boardId = newBoardId()
		const socket = await connect(boardId, {
			headers: {
				'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
				'X-Board-Host': 'arbitrary-untrusted-header',
			},
		})
		await socket.waitForFrame((frame) => frame.type === 'scene:sync')

		const snapshot = await runInDurableObject(
			boardStub(boardId),
			async (_instance, state) => ({
				metaKeys: [...(await state.storage.list({ prefix: 'meta:' })).keys()],
				alarm: await state.storage.getAlarm(),
				tables: state.storage
					.sql.exec<{ name: string }>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.toArray()
					.map((row) => row.name),
			}),
		)
		expect(snapshot.metaKeys).toEqual([])
		expect(snapshot.alarm).toBeNull()
		expect(snapshot.tables).toEqual([])
		expect(await listShareCodeKeysForBoard(boardId)).toEqual([])
		socket.close()
	})

	it('initializes exactly on first-message host proof and lets an existing viewer read scene', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connect(boardId, {
			headers: { 'CF-Connecting-IP': '192.0.2.41' },
		})
		owner.send({ type: 'wb:auth', hostSecret })
		const hello = await waitForHello(owner)
		expect(hello.role).toBe('owner')
		const element = rectangleElement()
		owner.send({ type: 'scene:update', elements: [element], full: true })
		const viewer = await connect(boardId, {
			headers: { 'CF-Connecting-IP': '192.0.2.42' },
		})
		const sync = await viewer.waitForFrame(
			(frame) => frame.type === 'scene:sync' && frameHasElement(frame, element.id),
		)
		expect(frameHasElement(sync, element.id)).toBe(true)
		const keys = await listShareCodeKeysForBoard(boardId)
		expect(keys).toHaveLength(1)
		owner.close()
		viewer.close()
	})

	it('rejects a new pending socket once the per-board pending cap is reached', async () => {
		const boardId = newBoardId()
		const sockets: Array<{ close: () => void }> = []
		try {
			for (let index = 0; index < 32; index += 1) {
				const socket = await connect(boardId, {
					headers: { 'CF-Connecting-IP': `203.0.113.${index + 1}` },
				})
				sockets.push(socket)
			}
			const rejected = await upgradeConnect(boardId, {
				headers: { 'CF-Connecting-IP': '203.0.113.250' },
			})
			expect(rejected.status).toBe(429)
		} finally {
			for (const socket of sockets) socket.close()
		}
	})

	it('preserves the classroom burst allowance in the fallback', () => {
		for (let index = 0; index < CONNECT_RATE_LIMIT; index += 1) {
			expect(consumeLocalConnectAdmission('classroom', index)).toMatchObject({
				allowed: true,
			})
		}
		expect(consumeLocalConnectAdmission('classroom', CONNECT_RATE_LIMIT)).toMatchObject({
			allowed: false,
		})
	})
})
