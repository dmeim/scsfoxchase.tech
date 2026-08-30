import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildWhiteboardConnectUrl } from '../../src/lib/whiteboard-sync'
import worker from '../../src/worker'
import { handleAdminRequest } from '../../src/worker/adminRoutes'
import { handleAssetRequest } from '../../src/worker/assetRoutes'
import { handleCodeRequest } from '../../src/worker/codeRoutes'
import { handleForceFollowRequest } from '../../src/worker/forceFollowRoutes'
import { handleParticipantRequest } from '../../src/worker/participantRoutes'
import { revokeBoardShareCode } from '../../src/worker/libraryRoutes'
import {
	copyProofHeaders,
	forwardLegacyProofHeaders,
} from '../../src/worker/httpSecurity'
import { authorizedPartiesForToken } from '../../src/worker/clerkAuth'
import {
	bootWorker,
	connectAndAuth,
	disposeWorker,
	newBoardId,
	randomHostSecret,
	TestSocket,
	waitForHello,
	workerFetch,
	WORKER_ORIGIN,
} from './helpers/harness'

const ALLOWED_ORIGIN = 'https://scsfoxchase.tech'
const HOSTILE_ORIGIN = 'https://evil.example'

function legacyJwt(): string {
	return [
		'eyJhbGciOiJIUzI1NiJ9',
		'e'.repeat(48),
		's'.repeat(43),
	].join('.')
}

type ForwardCapture = { request: Request | null }

function forwardingEnv(capture: ForwardCapture, boardId: string): Env {
	const stub = {
		fetch: async (request: Request): Promise<Response> => {
			capture.request = request
			return new Response(JSON.stringify({ savedToLibrary: false }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		},
	}
	const namespace = {
		idFromName: (_name: string) => ({}),
		get: (_id: unknown) => stub,
	}
	return {
		WHITEBOARDS: namespace,
		WHITEBOARD_CODES: { get: async () => JSON.stringify({ boardId }) },
	} as unknown as Env
}

function noOpExecutionContext(): ExecutionContext {
	return {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext
}

async function connectGuest(
	boardId: string,
	userId: string,
): Promise<TestSocket> {
	const sessionId = crypto.randomUUID()
	const response = await workerFetch(
		buildWhiteboardConnectUrl(WORKER_ORIGIN, {
			boardId,
			sessionId,
			displayName: 'Guest test',
			userId,
		}),
		{
			headers: {
				Upgrade: 'websocket',
				Connection: 'Upgrade',
			},
		},
	)
	if (response.status !== 101 || !response.webSocket) {
		throw new Error(`Guest WebSocket upgrade failed: ${response.status}`)
	}
	const socket = new TestSocket(response.webSocket, sessionId, response)
	response.webSocket.accept()
	socket.send({ type: 'wb:auth' })
	await waitForHello(socket)
	return socket
}

function jsonHeaders(extra: Record<string, string> = {}): HeadersInit {
	return {
		Origin: ALLOWED_ORIGIN,
		'Content-Type': 'application/json',
		...extra,
	}
}

describe('whiteboard Worker HTTP boundary', () => {
	const sockets: TestSocket[] = []

	beforeAll(async () => {
		await bootWorker()
	})

	afterEach(() => {
		while (sockets.length > 0) sockets.pop()?.close()
	})

	afterAll(async () => {
		await disposeWorker()
	})

	it('accepts header-only host proof for meta lifetime PATCH', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)

		const response = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`,
			{
				method: 'PATCH',
				headers: jsonHeaders({ 'X-Board-Host': hostSecret }),
				body: JSON.stringify({ savedToLibrary: true }),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect((await response.json()) as { savedToLibrary?: boolean }).toMatchObject({
			savedToLibrary: true,
		})

		const legacyUrl = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`,
		)
		legacyUrl.searchParams.set('hostSecret', hostSecret)
		const legacy = await workerFetch(legacyUrl, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ savedToLibrary: false }),
		})
		expect(legacy.status).toBe(200)

		const headerWins = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`,
		)
		headerWins.searchParams.set('hostSecret', 'legacy-invalid')
		const normal = await workerFetch(headerWins, {
			method: 'PATCH',
			headers: jsonHeaders({ 'X-Board-Host': hostSecret }),
			body: JSON.stringify({ savedToLibrary: true }),
		})
		expect(normal.status).toBe(200)
	})

	it('forwards legacy JWT hostSecret as Authorization and scrubs the meta URL', async () => {
		const boardId = newBoardId()
		const token = legacyJwt()
		const capture: ForwardCapture = { request: null }
		const url = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/meta`,
		)
		url.searchParams.set('hostSecret', token)

		const response = await worker.fetch(
			new Request(url, { headers: jsonHeaders() }),
			forwardingEnv(capture, boardId),
			noOpExecutionContext(),
		)

		expect(response.status).toBe(200)
		expect(capture.request).not.toBeNull()
		const forwarded = capture.request!
		expect(forwarded.headers.get('Authorization')).toBe(`Bearer ${token}`)
		expect(forwarded.headers.get('X-Board-Host')).toBeNull()
		expect(new URL(forwarded.url).searchParams.has('hostSecret')).toBe(false)
		expect(forwarded.url).not.toContain(token)
	})

	it('forwards legacy JWT hostSecret as Authorization and scrubs the share-code URL', async () => {
		const boardId = newBoardId()
		const token = legacyJwt()
		const capture: ForwardCapture = { request: null }
		const url = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/code`,
		)
		url.searchParams.set('hostSecret', token)

		const response = await handleCodeRequest(
			new Request(url, { method: 'GET', headers: jsonHeaders() }),
			forwardingEnv(capture, boardId),
		)

		expect(response?.status).toBe(200)
		expect(capture.request).not.toBeNull()
		const forwarded = capture.request!
		expect(forwarded.headers.get('Authorization')).toBe(`Bearer ${token}`)
		expect(forwarded.headers.get('X-Board-Host')).toBeNull()
		expect(new URL(forwarded.url).searchParams.has('hostSecret')).toBe(false)
		expect(forwarded.url).not.toContain(token)
	})

	it('never replaces an existing Authorization header with a legacy query token', () => {
		const queryToken = legacyJwt()
		const url = new URL(`${WORKER_ORIGIN}/api/whiteboard/boards/test/meta`)
		url.searchParams.set('hostSecret', queryToken)
		const request = new Request(url, {
			headers: jsonHeaders({ Authorization: 'Bearer existing-token' }),
		})
		const headers = copyProofHeaders(request)

		forwardLegacyProofHeaders(request, url, headers)

		expect(headers.get('Authorization')).toBe('Bearer existing-token')
		expect(new URL(url).searchParams.has('hostSecret')).toBe(false)
		expect(url.toString()).not.toContain(queryToken)
	})

	it('keeps Clerk authorized parties fixed against hostile Origin and azp', () => {
		const parties = authorizedPartiesForToken(
			legacyJwt(),
			HOSTILE_ORIGIN,
		)
		expect(parties).toContain(ALLOWED_ORIGIN)
		expect(parties).not.toContain(HOSTILE_ORIGIN)
		expect(parties).not.toContain('https://evil.scsfoxchase.tech')
	})

	it('requires a live session owner-key assertion for google asset writes', async () => {
		const boardId = newBoardId()
		const assetId = crypto.randomUUID()
		const ownerKey = 'google:canonical-owner'
		let reveal: 'match' | 'mismatch' | 'null' | 'error' = 'mismatch'
		const putKeys: string[] = []
		const deleteKeys: string[] = []
		const stub = {
			assertAssetWriteAccess: async () => ({ ok: true as const }),
			fetch: async () => {
				if (reveal === 'error') throw new Error('DO unavailable')
				const cloudOwnerKey =
					reveal === 'match'
						? ownerKey
						: reveal === 'null'
							? null
							: 'google:other-owner'
				return new Response(JSON.stringify({ cloudOwnerKey }), { status: 200 })
			},
		}
		const env = {
			WHITEBOARDS: {
				idFromName: () => ({}),
				get: () => stub,
			},
			WHITEBOARD_ASSETS: {
				put: async (key: string) => putKeys.push(key),
				delete: async (key: string) => deleteKeys.push(key),
			},
		} as unknown as Env
		const request = (method: 'PUT' | 'DELETE') =>
			new Request(
				`${WORKER_ORIGIN}/api/whiteboard/assets/${encodeURIComponent(ownerKey)}/${assetId}`,
				{
					method,
					headers: {
						Origin: ALLOWED_ORIGIN,
						'X-Board-Id': boardId,
						'X-Board-Session': crypto.randomUUID(),
						'X-Board-Auth': 'live-session-token',
						...(method === 'PUT' ? { 'Content-Type': 'image/png' } : {}),
					},
					...(method === 'PUT' ? { body: new Uint8Array([137, 80, 78, 71]) } : {}),
				},
			)

		for (const state of ['mismatch', 'null', 'error'] as const) {
			reveal = state
			const response = await handleAssetRequest(request('PUT'), env)
			expect(response?.status).toBe(403)
		}
		expect(putKeys).toEqual([])

		reveal = 'match'
		const put = await handleAssetRequest(request('PUT'), env)
		expect(put?.status).toBe(201)
		expect(putKeys).toEqual([`assets/${ownerKey}/${assetId}`])

		const deleted = await handleAssetRequest(request('DELETE'), env)
		expect(deleted?.status).toBe(200)
		expect(deleteKeys).toEqual([`assets/${ownerKey}/${assetId}`])
	})

	it('bounds and sanitizes the legacy admin wipe body', async () => {
		const objectId = 'a'.repeat(64)
		const env = {
			WHITEBOARD_ADMIN_SECRET: 'admin-test-secret',
			WHITEBOARDS: {
				idFromString: () => ({}),
				get: () => ({
					wipeStoredData: async () => {
						throw new Error('internal DO details must not escape')
					},
				}),
			},
		} as unknown as Env
		const base = `${WORKER_ORIGIN}/api/whiteboard/admin/wipe-storage`
		const headers = {
			Origin: ALLOWED_ORIGIN,
			Authorization: 'Bearer admin-test-secret',
			'Content-Type': 'application/json',
		}

		const malformed = await handleAdminRequest(
			new Request(base, {
				method: 'POST',
				headers,
				body: new Uint8Array([0xc3, 0x28]),
			}),
			env,
		)
		expect(malformed?.status).toBe(400)
		expect(await malformed?.json()).toEqual({ error: 'Invalid JSON body' })

		const oversized = await handleAdminRequest(
			new Request(base, {
				method: 'POST',
				headers,
				body: JSON.stringify({ objectIds: ['a'.repeat(270_000)] }),
			}),
			env,
		)
		expect(oversized?.status).toBe(413)

		const failed = await handleAdminRequest(
			new Request(base, {
				method: 'POST',
				headers,
				body: JSON.stringify({ objectIds: [objectId] }),
			}),
			env,
		)
		expect(failed?.status).toBe(500)
		const failedBody = await failed!.text()
		expect(failedBody).toContain('Wipe failed')
		expect(failedBody).not.toContain('internal DO details')

		const hostile = await handleAdminRequest(
			new Request(base, {
				method: 'OPTIONS',
				headers: { Origin: HOSTILE_ORIGIN },
			}),
			env,
		)
		expect(hostile?.status).toBe(403)
	})

	it('moves legacy actor proofs to headers without forwarding query credentials', async () => {
		const boardId = newBoardId()
		const targetSessionId = crypto.randomUUID()
		const actorSessionId = crypto.randomUUID()
		const actorAuth = 'legacy-actor-proof'
		const capture: ForwardCapture = { request: null }
		const participantUrl = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/participants/${targetSessionId}`,
		)
		participantUrl.searchParams.set('actorSessionId', actorSessionId)
		participantUrl.searchParams.set('actorAuth', actorAuth)
		const participant = await handleParticipantRequest(
			new Request(participantUrl, {
				method: 'PATCH',
				headers: jsonHeaders(),
				body: JSON.stringify({ role: 'viewer' }),
			}),
			forwardingEnv(capture, boardId),
		)
		expect(participant?.status).toBe(200)
		expect(capture.request).not.toBeNull()
		expect(capture.request!.headers.get('X-Board-Session')).toBe(actorSessionId)
		expect(capture.request!.headers.get('X-Board-Auth')).toBe(actorAuth)
		const forwardedParticipantUrl = new URL(capture.request!.url)
		expect(forwardedParticipantUrl.searchParams.has('actorSessionId')).toBe(false)
		expect(forwardedParticipantUrl.searchParams.has('actorAuth')).toBe(false)

		capture.request = null
		const forceFollowUrl = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/force-follow`,
		)
		forceFollowUrl.searchParams.set('actorSessionId', actorSessionId)
		forceFollowUrl.searchParams.set('actorAuth', actorAuth)
		const forceFollow = await handleForceFollowRequest(
			new Request(forceFollowUrl, {
				method: 'PATCH',
				headers: jsonHeaders(),
				body: JSON.stringify({ forceFollow: false }),
			}),
			forwardingEnv(capture, boardId),
		)
		expect(forceFollow?.status).toBe(200)
		expect(capture.request).not.toBeNull()
		expect(capture.request!.headers.get('X-Board-Session')).toBe(actorSessionId)
		expect(capture.request!.headers.get('X-Board-Auth')).toBe(actorAuth)
		const forwardedForceFollowUrl = new URL(capture.request!.url)
		expect(forwardedForceFollowUrl.searchParams.has('actorSessionId')).toBe(false)
		expect(forwardedForceFollowUrl.searchParams.has('actorAuth')).toBe(false)
	})

	it('only reports share-code revoke after the bounded DO retry succeeds', async () => {
		let transientCalls = 0
		const transientEnv = {
			WHITEBOARDS: {
				idFromName: () => ({}),
				get: () => ({
					revokeShareCodeMapping: async () => {
						transientCalls += 1
						if (transientCalls === 1) throw new Error('transient')
					},
				}),
			},
		} as unknown as Env
		expect(await revokeBoardShareCode(transientEnv, newBoardId())).toBe(true)
		expect(transientCalls).toBe(2)

		let failedCalls = 0
		const failedEnv = {
			WHITEBOARDS: {
				idFromName: () => ({}),
				get: () => ({
					revokeShareCodeMapping: async () => {
						failedCalls += 1
						throw new Error('unavailable')
					},
				}),
			},
		} as unknown as Env
		expect(await revokeBoardShareCode(failedEnv, newBoardId())).toBe(false)
		expect(failedCalls).toBe(3)
	})

	it('uses forwarded actor headers for participant and force-follow PATCHes', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)
		const hello = await waitForHello(owner)
		if (typeof hello.authToken !== 'string') throw new Error('Missing owner token')

		const target = await connectGuest(boardId, crypto.randomUUID())
		sockets.push(target)

		const actorHeaders = {
			...jsonHeaders({
				'X-Board-Session': owner.sessionId,
				'X-Board-Auth': hello.authToken,
			}),
		}
		const participant = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/participants/${target.sessionId}`,
			{
				method: 'PATCH',
				headers: actorHeaders,
				body: JSON.stringify({ role: 'editor' }),
			},
		)
		expect(participant.status).toBe(200)
		expect(await participant.json()).toMatchObject({
			sessionId: target.sessionId,
			role: 'editor',
		})

		const ownerFrameStart = owner.frames.length
		const targetFrameStart = target.frames.length
		const forceFollow = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/force-follow`,
			{
				method: 'PATCH',
				headers: actorHeaders,
				body: JSON.stringify({ forceFollow: false }),
			},
		)
		expect(forceFollow.status).toBe(200)
		expect(await forceFollow.json()).toMatchObject({ forceFollow: false })
		for (const frames of [
			owner.frames.slice(ownerFrameStart),
			target.frames.slice(targetFrameStart),
		]) {
			expect(frames).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'wb:forceFollow',
						forceFollow: false,
					}),
					expect.objectContaining({
						type: 'wb:followedBy',
						followed: false,
					}),
				]),
			)
		}

		const followedStart = owner.frames.length
		target.send({ type: 'wb:follow', targetSessionId: owner.sessionId })
		await owner.waitForFrameAfter(
			followedStart,
			(frame) => frame.type === 'wb:followedBy' && frame.followed === true,
		)

		const unfollowedStart = owner.frames.length
		target.close()
		await owner.waitForFrameAfter(
			unfollowedStart,
			(frame) => frame.type === 'wb:followedBy' && frame.followed === false,
		)
	})

	it('keeps legacy actor query support bounded to compatibility requests', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)
		const hello = await waitForHello(owner)
		if (typeof hello.authToken !== 'string') throw new Error('Missing owner token')
		const target = await connectGuest(boardId, crypto.randomUUID())
		sockets.push(target)

		const legacyUrl = new URL(
			`${WORKER_ORIGIN}/api/whiteboard/boards/${boardId}/participants/${target.sessionId}`,
		)
		legacyUrl.searchParams.set('actorSessionId', owner.sessionId)
		legacyUrl.searchParams.set('actorAuth', hello.authToken)
		const legacy = await workerFetch(legacyUrl, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ role: 'viewer' }),
		})
		expect(legacy.status).toBe(200)
		expect(await legacy.json()).toMatchObject({ role: 'viewer' })

		const normalUrl = new URL(legacyUrl)
		normalUrl.searchParams.set('actorSessionId', 'legacy-should-not-win')
		const normal = await workerFetch(normalUrl, {
			method: 'PATCH',
			headers: jsonHeaders({
				'X-Board-Session': owner.sessionId,
				'X-Board-Auth': hello.authToken,
			}),
			body: JSON.stringify({ role: 'editor' }),
		})
		expect(normal.status).toBe(200)
		expect(await normal.json()).toMatchObject({ role: 'editor' })
	})

	it('returns complete allowed preflight and never reflects hostile origins', async () => {
		const preflight = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/assets/claim`,
			{
				method: 'OPTIONS',
				headers: {
					Origin: ALLOWED_ORIGIN,
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers':
						'authorization, x-board-host, content-type',
				},
			},
		)
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
			ALLOWED_ORIGIN,
		)
		expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST')
		expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain(
			'Authorization',
		)
		expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain(
			'X-Board-Host',
		)
		expect(preflight.headers.get('Access-Control-Max-Age')).toBe('86400')

		const hostile = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/library/boards`,
			{ headers: { Origin: HOSTILE_ORIGIN } },
		)
		expect(hostile.headers.get('Access-Control-Allow-Origin')).toBeNull()
		expect(hostile.headers.get('Cache-Control')).toBe('no-store')
		expect(hostile.headers.get('X-Content-Type-Options')).toBe('nosniff')

		const hostileAdmin = await workerFetch(
			`${WORKER_ORIGIN}/api/whiteboard/admin/wipe-storage`,
			{ headers: { Origin: HOSTILE_ORIGIN } },
		)
		expect(hostileAdmin.headers.get('Access-Control-Allow-Origin')).toBeNull()
		expect(hostileAdmin.headers.get('Cache-Control')).toBe('no-store')
		expect(hostileAdmin.headers.get('X-Content-Type-Options')).toBe('nosniff')
	})
})
