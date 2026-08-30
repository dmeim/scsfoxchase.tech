import { runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import worker from '../../src/worker'
import {
	admitWhiteboardConnect,
	BOARD_CONNECT_RATE_LIMIT,
	consumeLocalConnectAdmission,
	CONNECT_RATE_LIMIT,
	LOCAL_CONNECT_BUCKET_MAX,
	LOCAL_CONNECT_WINDOW_MS,
	localConnectAdmissionSize,
	resetLocalConnectAdmissionForTests,
	trustedBoardConnectRateLimitKey,
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

const BOARD_A = '11111111-1111-4111-8111-111111111111'
const BOARD_B = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
	resetLocalConnectAdmissionForTests()
})

describe('whiteboard connection admission', () => {
	it('accepts only strict UUID session handles and creates stable layered keys', () => {
		const valid = crypto.randomUUID()
		expect(isValidConnectSessionId(valid)).toBe(true)
		expect(isValidConnectSessionId(`${valid}x`)).toBe(false)
		expect(isValidConnectSessionId('not-a-session')).toBe(false)
		const request = new Request(`${WORKER_ORIGIN}/api/whiteboard/connect`, {
			headers: {
				'CF-Connecting-IP': '203.0.113.7',
				'X-Forwarded-For': '198.51.100.9',
			},
		})
		expect(trustedConnectRateLimitKey(request)).toBe('203.0.113.7')
		expect(trustedBoardConnectRateLimitKey(request, BOARD_A.toUpperCase())).toBe(
			`${BOARD_A}:203.0.113.7`,
		)
		expect(trustedBoardConnectRateLimitKey(request, BOARD_B)).not.toBe(
			trustedBoardConnectRateLimitKey(request, BOARD_A),
		)
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

	it('uses both platform limiters with independent keys', async () => {
		const ipKeys: string[] = []
		const boardKeys: string[] = []
		const request = new Request(`${WORKER_ORIGIN}/api/whiteboard/connect`, {
			headers: { 'CF-Connecting-IP': '192.0.2.20' },
		})
		await expect(
			admitWhiteboardConnect(request, {
				WHITEBOARD_CONNECT_LIMITER: {
					limit: async ({ key }) => {
						ipKeys.push(key)
						return { success: true }
					},
				},
				WHITEBOARD_BOARD_CONNECT_LIMITER: {
					limit: async ({ key }) => {
						boardKeys.push(key)
						return { success: true }
					},
				},
			}, BOARD_A),
		).resolves.toBeNull()
		expect(ipKeys).toEqual(['192.0.2.20'])
		expect(boardKeys).toEqual([`${BOARD_A}:192.0.2.20`])
	})

	it('rejects either exhausted layer and fails closed on partial configuration', async () => {
		const request = new Request(`${WORKER_ORIGIN}/api/whiteboard/connect`, {
			headers: { 'CF-Connecting-IP': '192.0.2.21' },
		})
		const allows = { limit: async () => ({ success: true }) }
		const rejects = { limit: async () => ({ success: false }) }

		const ipRejected = await admitWhiteboardConnect(request, {
			WHITEBOARD_CONNECT_LIMITER: {
				limit: async () => ({ success: false }),
			},
			WHITEBOARD_BOARD_CONNECT_LIMITER: allows,
		}, BOARD_A)
		expect(ipRejected?.status).toBe(429)

		const boardRejected = await admitWhiteboardConnect(request, {
			WHITEBOARD_CONNECT_LIMITER: allows,
			WHITEBOARD_BOARD_CONNECT_LIMITER: rejects,
		}, BOARD_A)
		expect(boardRejected?.status).toBe(429)

		const partial = await admitWhiteboardConnect(request, {
			WHITEBOARD_CONNECT_LIMITER: allows,
		}, BOARD_A)
		expect(partial?.status).toBe(503)

		const unavailable = await admitWhiteboardConnect(request, {
			WHITEBOARD_CONNECT_LIMITER: {
				limit: async () => {
					throw new Error('ignored')
				},
			},
			WHITEBOARD_BOARD_CONNECT_LIMITER: allows,
		}, BOARD_A)
		expect(unavailable?.status).toBe(503)
	})

	it('stops a random UUID flood before resolving more Durable Object stubs', async () => {
		let resolved = 0
		let ipAdmissions = 0
		const env = {
			WHITEBOARD_CONNECT_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					expect(key).toBe('198.51.100.200')
					ipAdmissions += 1
					return { success: ipAdmissions <= 3 }
				},
			},
			WHITEBOARD_BOARD_CONNECT_LIMITER: {
				limit: async () => ({ success: true }),
			},
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
		for (let index = 0; index < 5; index += 1) {
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
			if (index >= 3) expect(response.status).toBe(429)
		}
		expect(resolved).toBe(3)
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

	it('enforces the 600-request IP-wide fallback ceiling', () => {
		for (let index = 0; index < CONNECT_RATE_LIMIT; index += 1) {
			expect(consumeLocalConnectAdmission('classroom', index)).toMatchObject({
				allowed: true,
			})
		}
		expect(consumeLocalConnectAdmission('classroom', CONNECT_RATE_LIMIT)).toMatchObject({
			allowed: false,
		})
	})

	it('enforces 240 per IP and board without blocking another board', async () => {
		const request = new Request(`${WORKER_ORIGIN}/api/whiteboard/connect`, {
			headers: { 'CF-Connecting-IP': '203.0.113.44' },
		})
		for (let index = 0; index < BOARD_CONNECT_RATE_LIMIT; index += 1) {
			await expect(admitWhiteboardConnect(request, {}, BOARD_A)).resolves.toBeNull()
		}
		await expect(admitWhiteboardConnect(request, {}, BOARD_A)).resolves.toMatchObject({
			status: 429,
		})
		await expect(admitWhiteboardConnect(request, {}, BOARD_B)).resolves.toBeNull()
	})
})
