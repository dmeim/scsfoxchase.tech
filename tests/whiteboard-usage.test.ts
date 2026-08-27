import { describe, expect, it } from 'vitest'
import {
	RECONNECT_MAX_MS,
	reconnectDelayMs,
} from '../src/lib/whiteboard-sync'

describe('whiteboard usage guards', () => {
	it('backs reconnects off to one attempt per minute during a long outage', () => {
		expect(reconnectDelayMs(0)).toBe(500)
		expect(reconnectDelayMs(1)).toBe(1000)
		expect(reconnectDelayMs(6)).toBe(32_000)
		expect(reconnectDelayMs(7)).toBe(RECONNECT_MAX_MS)
		expect(reconnectDelayMs(100)).toBe(RECONNECT_MAX_MS)
		expect(reconnectDelayMs(Number.NaN)).toBe(500)
	})
})
