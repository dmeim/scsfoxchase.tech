import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	AUTH_GET_TOKEN_SETTLE_MS,
	getSessionTokenSettled,
	markAuthResolved,
	markAuthResolvedAfterTokenSettle,
	peekSessionToken,
	raceSettled,
	setActiveIdentity,
	setSessionTokenGetter,
	whenAuthReady,
	type WhiteboardIdentity,
} from '../src/lib/whiteboard-identity'

function signedInIdentity(
	clerkUserId = 'user_hang_test',
): WhiteboardIdentity {
	return {
		accountId: clerkUserId,
		ownerKey: `google:${clerkUserId}`,
		email: 'teacher@scsfoxchase.tech',
		displayName: 'Teacher',
		clerkUserId,
	}
}

function installAuthWindow(): EventTarget {
	const target = new EventTarget()
	vi.stubGlobal('window', target)
	return target
}

beforeEach(() => {
	installAuthWindow()
	vi.stubEnv('PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_whiteboard_hang')
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('raceSettled', () => {
	it('returns fallback when the promise never settles', async () => {
		vi.useFakeTimers()
		const pending = raceSettled(new Promise<string>(() => {}), 2_000, '')
		await vi.advanceTimersByTimeAsync(2_000)
		await expect(pending).resolves.toBe('')
	})

	it('returns the value when the promise settles first', async () => {
		vi.useFakeTimers()
		const pending = raceSettled(
			Promise.resolve('jwt-token'),
			2_000,
			'',
		)
		await vi.advanceTimersByTimeAsync(2_000)
		await expect(pending).resolves.toBe('jwt-token')
	})
})

describe('getSessionTokenSettled', () => {
	it('returns null if getToken never settles', async () => {
		vi.useFakeTimers()
		setSessionTokenGetter(() => new Promise(() => {}))
		const pending = getSessionTokenSettled(AUTH_GET_TOKEN_SETTLE_MS)
		await vi.advanceTimersByTimeAsync(AUTH_GET_TOKEN_SETTLE_MS)
		await expect(pending).resolves.toBeNull()
	})
})

describe('whenAuthReady / getToken hang', () => {
	it('still resolves if getToken would hang (timeout path)', async () => {
		vi.useFakeTimers()
		const ready = whenAuthReady()
		const settle = markAuthResolvedAfterTokenSettle(
			() => new Promise(() => {}),
			AUTH_GET_TOKEN_SETTLE_MS,
		)
		await vi.advanceTimersByTimeAsync(AUTH_GET_TOKEN_SETTLE_MS)
		await expect(settle).resolves.toBe('')
		expect(peekSessionToken()).toBeNull()
		await ready
	})

	it('caches a token that settles before the timeout then unblocks whenAuthReady', async () => {
		vi.useFakeTimers()
		setActiveIdentity(signedInIdentity())
		const ready = whenAuthReady()
		const settle = markAuthResolvedAfterTokenSettle(
			async () => ' cached-jwt ',
			AUTH_GET_TOKEN_SETTLE_MS,
		)
		await expect(settle).resolves.toBe(' cached-jwt ')
		expect(peekSessionToken()).toBe('cached-jwt')
		await ready
		await vi.advanceTimersByTimeAsync(AUTH_GET_TOKEN_SETTLE_MS)
	})

	it('does not cache a late token after sign-out', async () => {
		setActiveIdentity(signedInIdentity())
		let resolveToken!: (value: string) => void
		const tokenPromise = new Promise<string>((resolve) => {
			resolveToken = resolve
		})
		const settle = markAuthResolvedAfterTokenSettle(
			() => tokenPromise,
			AUTH_GET_TOKEN_SETTLE_MS,
		)
		setActiveIdentity(null)
		resolveToken('stale-jwt')
		await expect(settle).resolves.toBe('stale-jwt')
		expect(peekSessionToken()).toBeNull()
	})

	it('markAuthResolved is enough after a timeout even without the helper', async () => {
		vi.useFakeTimers()
		const ready = whenAuthReady()
		const token = raceSettled(
			new Promise<string>(() => {}),
			AUTH_GET_TOKEN_SETTLE_MS,
			'',
		)
		await vi.advanceTimersByTimeAsync(AUTH_GET_TOKEN_SETTLE_MS)
		expect(await token).toBe('')
		markAuthResolved()
		await ready
	})
})
