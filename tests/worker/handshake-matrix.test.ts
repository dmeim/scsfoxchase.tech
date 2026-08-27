import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	isWbAuthReason,
	ROLE_RESOLVE_DEADLINE_MS,
} from '../../src/lib/whiteboard-sync'
import {
	bootWorker,
	connect,
	connectAndAuth,
	disposeWorker,
	framesOfType,
	GARBAGE_CLERK_JWT,
	joinCodeCookieHeader,
	listShareCodeKeysForBoard,
	newBoardId,
	randomHostSecret,
	rectangleElement,
	sendWbAuth,
	shareCodeFromKvKey,
	waitForAuthResult,
	waitForHello,
} from './helpers/harness'

describe('handshake matrix', () => {
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

	async function openBoard(
		boardId: string,
		options?: Parameters<typeof connect>[1],
	) {
		const socket = await connect(boardId, options)
		sockets.push(socket)
		const hello = await waitForHello(socket)
		return { socket, hello }
	}

	it('sends hello as viewer for a signed-out UUID-only connect', async () => {
		const { socket, hello } = await openBoard(newBoardId())

		expect(hello.role).toBe('viewer')
		expect(hello.canEdit).toBe(false)
		expect(hello.roleResolved).toBe(false)

		const mark = socket.frames.length
		sendWbAuth(socket)
		const result = await waitForAuthResult(socket, { after: mark })
		expect(result.role).toBe('viewer')
		expect(result.roleResolved).toBe(true)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('sends hello as an editable Owner when the host secret is on the connect header', async () => {
		const hostSecret = randomHostSecret()
		const { socket, hello } = await openBoard(newBoardId(), { hostSecret })

		expect(hello.role).toBe('owner')
		expect(hello.canEdit).toBe(true)
		expect(hello.isHost).toBe(true)
		expect(hello.roleResolved).toBe(false)

		const mark = socket.frames.length
		sendWbAuth(socket, { hostSecret })
		const result = await waitForAuthResult(socket, { after: mark })
		expect(result.role).toBe('owner')
		expect(result.roleResolved).toBe(true)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('upgrades via wb:role when the host secret arrives on wb:auth, with exactly one hello', async () => {
		const hostSecret = randomHostSecret()
		const { socket, hello } = await openBoard(newBoardId())

		expect(hello.role).toBe('viewer')
		expect(hello.roleResolved).toBe(false)

		const mark = socket.frames.length
		sendWbAuth(socket, { hostSecret })
		const result = await waitForAuthResult(socket, { after: mark })
		const role = await socket.waitForFrameAfter(
			mark,
			(frame) => frame.type === 'wb:role',
		)

		expect(result.role).toBe('owner')
		expect(result.roleResolved).toBe(true)
		expect(role.role).toBe('owner')
		expect(role.canEdit).toBe(true)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('sends hello as Editor when the active share-code cookie is presented', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)

		const keys = await listShareCodeKeysForBoard(boardId)
		expect(keys).toHaveLength(1)
		const code = shareCodeFromKvKey(keys[0]!)

		const { socket, hello } = await openBoard(boardId, {
			headers: { Cookie: joinCodeCookieHeader(boardId, code) },
		})

		expect(hello.role).toBe('editor')
		expect(hello.roleResolved).toBe(false)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)

		const mark = socket.frames.length
		sendWbAuth(socket)
		const result = await waitForAuthResult(socket, { after: mark })
		expect(result.role).toBe('editor')
		expect(result.roleResolved).toBe(true)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('keeps hello pending with awaiting_token when signedIn is true and no JWT is present', async () => {
		const { socket, hello } = await openBoard(newBoardId())

		expect(hello.role).toBe('viewer')
		expect(hello.roleResolved).toBe(false)

		const mark = socket.frames.length
		sendWbAuth(socket, { signedIn: true })
		const result = await waitForAuthResult(socket, { after: mark })

		expect(result.accepted).toBeTypeOf('boolean')
		expect(result.role).toBe('viewer')
		expect(result.roleResolved).toBe(false)
		expect(result.reason).toBe('awaiting_token')
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
		expect(framesOfType(socket, 'wb:role')).toHaveLength(0)
	})

	it('replies to a garbage token with a typed wb:authResult and never a second hello', async () => {
		const { socket, hello } = await openBoard(newBoardId())
		expect(hello.roleResolved).toBe(false)

		const pendingMark = socket.frames.length
		sendWbAuth(socket, { signedIn: true })
		const pending = await waitForAuthResult(socket, { after: pendingMark })
		expect(pending.reason).toBe('awaiting_token')
		expect(pending.roleResolved).toBe(false)

		const tokenMark = socket.frames.length
		sendWbAuth(socket, { signedIn: true, token: GARBAGE_CLERK_JWT })
		const result = await waitForAuthResult(socket, { after: tokenMark })

		expect(isWbAuthReason(result.reason)).toBe(true)
		expect(result.reason === 'token_invalid' || result.reason === 'clerk_unreachable').toBe(
			true,
		)
		if (result.reason === 'token_invalid') {
			expect(result.roleResolved).toBe(true)
		} else {
			expect(result.roleResolved).toBe(false)
		}
		expect(result.role).toBe('viewer')
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
		expect(framesOfType(socket, 'wb:role')).toHaveLength(0)
	})

	it('does not demote a host-secret Owner when a later garbage JWT arrives', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const socket = await connectAndAuth(boardId, hostSecret)
		sockets.push(socket)

		const hello = await waitForHello(socket)
		expect(hello.role).toBe('owner')
		expect(hello.canEdit).toBe(true)
		await waitForAuthResult(socket)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)

		const mark = socket.frames.length
		sendWbAuth(socket, { signedIn: true, token: GARBAGE_CLERK_JWT, hostSecret })
		const result = await waitForAuthResult(socket, { after: mark })

		expect(result.role).toBe('owner')
		expect(result.roleResolved).toBe(true)
		for (const frame of framesOfType(socket, 'wb:role')) {
			expect(frame.role).not.toBe('viewer')
			expect(frame.role).not.toBe('editor')
		}
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)

		const mutationId = crypto.randomUUID()
		const element = rectangleElement()
		socket.send({
			type: 'scene:update',
			elements: [element],
			mutationId,
		})
		await socket.waitForFrame(
			(frame) =>
				frame.type === 'scene:ack' && frame.mutationId === mutationId,
		)
	})

	it('rejects scene:update with role_unresolved while the role is not settled', async () => {
		const { socket, hello } = await openBoard(newBoardId())
		expect(hello.roleResolved).toBe(false)

		const mutationId = crypto.randomUUID()
		const mark = socket.frames.length
		socket.send({
			type: 'scene:update',
			elements: [rectangleElement()],
			mutationId,
		})
		const error = await socket.waitForFrameAfter(
			mark,
			(frame) => frame.type === 'wb:error',
		)
		expect(error.code).toBe('role_unresolved')
		expect(error.mutationId).toBe(mutationId)
		expect(framesOfType(socket, 'scene:ack')).toHaveLength(0)
	})

	it('answers ping while the role is unresolved', async () => {
		const { socket, hello } = await openBoard(newBoardId())
		expect(hello.roleResolved).toBe(false)

		const mark = socket.frames.length
		socket.ping()
		await socket.waitForFrameAfter(mark, (frame) => frame.type === 'pong')
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('answers scene:request while the role is unresolved', async () => {
		const { socket, hello } = await openBoard(newBoardId())
		expect(hello.roleResolved).toBe(false)

		const syncsBefore = framesOfType(socket, 'scene:sync').length
		socket.send({ type: 'scene:request' })
		await socket.waitForFrame(
			(frame) =>
				frame.type === 'scene:sync' &&
				framesOfType(socket, 'scene:sync').length > syncsBefore,
		)
	})

	it('forces roleResolved after the 15s deadline when a waking frame arrives', async () => {
		const { socket, hello } = await openBoard(newBoardId())
		expect(hello.role).toBe('viewer')
		expect(hello.roleResolved).toBe(false)

		await new Promise((resolve) =>
			setTimeout(resolve, ROLE_RESOLVE_DEADLINE_MS + 500),
		)

		const mark = socket.frames.length
		socket.send({ type: 'scene:request' })
		const result = await waitForAuthResult(socket, { after: mark })
		expect(result.roleResolved).toBe(true)
		expect(result.role).toBe('viewer')
		expect(result.reason).toBe('awaiting_token')
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})
})
