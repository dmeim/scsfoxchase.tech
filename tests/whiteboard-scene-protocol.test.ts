import { describe, expect, it } from 'vitest'
import {
	MAX_SCENE_ELEMENTS,
	MAX_SCENE_FRAME_BYTES,
	MAX_SCENE_JSON_BYTES,
	parseSceneElements,
	parseDatabaseScene,
	preflightSceneMutationFrame,
	reconnectDelayMs,
	sceneOutboxAcknowledge,
	sceneOutboxQueue,
	sceneOutboxReplay,
	sceneOutboxRetry,
	sceneOutboxStart,
	sceneOutboxTerminalFailure,
	utf8ByteLength,
} from '../src/lib/whiteboard-sync'

const element = {
	id: 'scene-protocol-element',
	version: 1,
	versionNonce: 1,
}

describe('bounded scene protocol primitives', () => {
	it('counts the scene cap in UTF-8 bytes, including Unicode', () => {
		const ascii = 'a'.repeat(MAX_SCENE_JSON_BYTES)
		expect(utf8ByteLength(ascii)).toBe(MAX_SCENE_JSON_BYTES)
		expect(utf8ByteLength('😀')).toBe(4)
		expect(utf8ByteLength('😀'.repeat(500_000))).toBe(MAX_SCENE_JSON_BYTES)
	})

	it('keeps the element cap and rejects every malformed inbound element', () => {
		expect(parseSceneElements([element])).toEqual([element])
		expect(() =>
			parseSceneElements(
				Array.from({ length: MAX_SCENE_ELEMENTS + 1 }, () => element),
			),
		).toThrow()
		expect(() => parseSceneElements([{}])).toThrow(
			'Scene contains a malformed element.',
		)
		expect(() => parseSceneElements({ elements: [element] })).toThrow()
	})

	it('leaves room for a bounded scene envelope before JSON parsing', () => {
		expect(MAX_SCENE_FRAME_BYTES).toBeGreaterThan(MAX_SCENE_JSON_BYTES * 2)
		expect(MAX_SCENE_FRAME_BYTES).toBeLessThan(MAX_SCENE_JSON_BYTES * 2 + 256_000)
	})

	it('preflights the serialized database scene and complete UTF-8 frame', () => {
		const mutation = {
			mutationId: crypto.randomUUID(),
			elements: [element],
			full: true,
		}
		const databaseAtLimit = '😀'.repeat(500_000)
		const atLimit = preflightSceneMutationFrame({
			...mutation,
			databaseJson: databaseAtLimit,
		})
		expect(atLimit.ok).toBe(true)
		const overDatabaseLimit = preflightSceneMutationFrame({
			...mutation,
			databaseJson: `${databaseAtLimit}😀`,
		})
		expect(overDatabaseLimit).toEqual({
			ok: false,
			code: 'scene_too_large',
		})

		const overFrameLimit = preflightSceneMutationFrame({
			...mutation,
			elements: [{ ...element, payload: 'x'.repeat(MAX_SCENE_FRAME_BYTES) }],
		})
		expect(overFrameLimit).toEqual({
			ok: false,
			code: 'scene_too_large',
		})
	})

	it('treats a present empty database scene as malformed', () => {
		expect(parseDatabaseScene('')).toBeNull()
	})

	it('keeps one immutable flight, coalesces B, replays on reconnect, and promotes after ack', () => {
		const flightA = { mutationId: 'A', baseRevision: 4 }
		const pendingB = { label: 'B', baseRevision: 4 }
		let state = { inFlight: null as typeof flightA | null, pending: null as typeof pendingB | null }

		state = sceneOutboxStart(state, flightA)
		state = sceneOutboxQueue(state, pendingB)
		expect(sceneOutboxReplay(state)).toBe(flightA)
		expect(sceneOutboxRetry(state)).toBe(state)
		// A remote update may advance the server while A is in flight, but B's
		// captured base is not silently rebased to that newer revision.
		const remoteRevision = 5
		expect(remoteRevision).toBeGreaterThan(pendingB.baseRevision)
		expect(state.pending?.baseRevision).toBe(4)

		state = sceneOutboxAcknowledge(state, (flight) => flight.mutationId === 'A')
		expect(state).toEqual({ inFlight: null, pending: pendingB })
		// The ack path's next flush starts the coalesced B snapshot.
		const flightB = {
			mutationId: 'B',
			baseRevision: state.pending!.baseRevision,
		}
		state = sceneOutboxStart(state, flightB)
		expect(state).toEqual({ inFlight: flightB, pending: null })
		expect(state.inFlight?.baseRevision).toBe(4)

		state = sceneOutboxQueue(state, { label: 'C', baseRevision: 4 })
		state = sceneOutboxTerminalFailure(state)
		expect(state).toEqual({
			inFlight: null,
			pending: { label: 'C', baseRevision: 4 },
		})
		expect(reconnectDelayMs(0)).toBe(500)
		expect(reconnectDelayMs(7)).toBe(60_000)
	})
})
