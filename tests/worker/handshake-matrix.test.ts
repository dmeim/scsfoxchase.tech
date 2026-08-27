import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	bootWorker,
	collectFrames,
	connect,
	connectAndAuth,
	disposeWorker,
	framesOfType,
	joinCodeCookieHeader,
	listShareCodeKeysForBoard,
	newBoardId,
	randomHostSecret,
	sendWbAuth,
	shareCodeFromKvKey,
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
		return socket
	}

	it('paints the initial scene before auth but waits to send hello', async () => {
		const socket = await openBoard(newBoardId())
		await socket.waitForFrame((frame) => frame.type === 'scene:sync')
		await collectFrames(socket, 250)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(0)

		sendWbAuth(socket)
		const hello = await waitForHello(socket)
		expect(hello.role).toBe('viewer')
		expect(hello.canEdit).toBe(false)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('accepts scratch host proof from the WebSocket header', async () => {
		const hostSecret = randomHostSecret()
		const socket = await openBoard(newBoardId(), { hostSecret })
		sendWbAuth(socket)

		const hello = await waitForHello(socket)
		expect(hello.role).toBe('owner')
		expect(hello.canEdit).toBe(true)
		expect(hello.isHost).toBe(true)
	})

	it('accepts scratch host proof on the first wb:auth message', async () => {
		const hostSecret = randomHostSecret()
		const socket = await openBoard(newBoardId())
		sendWbAuth(socket, { hostSecret })

		const hello = await waitForHello(socket)
		expect(hello.role).toBe('owner')
		expect(hello.canEdit).toBe(true)
		expect(hello.isHost).toBe(true)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('greets an active share-code guest as Editor', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const owner = await connectAndAuth(boardId, hostSecret)
		sockets.push(owner)

		const keys = await listShareCodeKeysForBoard(boardId)
		expect(keys).toHaveLength(1)
		const code = shareCodeFromKvKey(keys[0]!)
		const socket = await openBoard(boardId, {
			headers: { Cookie: joinCodeCookieHeader(boardId, code) },
		})
		sendWbAuth(socket)

		const hello = await waitForHello(socket)
		expect(hello.role).toBe('editor')
		// Group Edit defaults off, so an Editor is identified but frozen.
		expect(hello.canEdit).toBe(false)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('keeps a signed-in socket pending until token or host proof arrives', async () => {
		const hostSecret = randomHostSecret()
		const socket = await openBoard(newBoardId())
		sendWbAuth(socket, { signedIn: true })
		await collectFrames(socket, 250)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(0)

		sendWbAuth(socket, { signedIn: true, hostSecret })
		const hello = await waitForHello(socket)
		expect(hello.role).toBe('owner')
		expect(hello.canEdit).toBe(true)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})

	it('never sends a second hello after the socket is greeted', async () => {
		const boardId = newBoardId()
		const hostSecret = randomHostSecret()
		const socket = await connectAndAuth(boardId, hostSecret)
		sockets.push(socket)

		sendWbAuth(socket, { hostSecret })
		await collectFrames(socket, 250)
		expect(framesOfType(socket, 'wb:hello')).toHaveLength(1)
	})
})
