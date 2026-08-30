import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clerkMocks = vi.hoisted(() => ({
	authenticateRequest: vi.fn(),
	getUser: vi.fn(),
	waitUntil: vi.fn(),
}))

vi.mock('@clerk/backend', () => ({
	createClerkClient: () => ({
		authenticateRequest: clerkMocks.authenticateRequest,
		users: { getUser: clerkMocks.getUser },
	}),
	verifyToken: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
	waitUntil: clerkMocks.waitUntil,
}))

import { requireClerkWhiteboardAuth } from '../src/worker/clerkAuth'

type Deferred<T> = {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function staleProfile(clerkUserId: string): string {
	return JSON.stringify({
		accountId: `google-${clerkUserId}`,
		email: `${clerkUserId}@example.edu`,
		displayName: 'Cached User',
		fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
	})
}

function freshClerkUser(clerkUserId: string) {
	return {
		primaryEmailAddress: { emailAddress: `${clerkUserId}@example.edu` },
		emailAddresses: [],
		externalAccounts: [
			{ provider: 'oauth_google', providerUserId: `fresh-${clerkUserId}` },
		],
		fullName: 'Fresh User',
		firstName: null,
		lastName: null,
		username: null,
		imageUrl: 'https://example.edu/avatar.png',
	}
}

function authRequest(): Request {
	return new Request('https://scsfoxchase.tech/api/whiteboard/library/boards', {
		headers: { Authorization: 'Bearer session-token' },
	})
}

function authEnv(clerkUserId: string) {
	const put = vi.fn(async () => undefined)
	const env = {
		CLERK_SECRET_KEY: 'test-secret',
		PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test',
		PUBLIC_CLERK_ALLOWED_DOMAINS: 'example.edu',
		WHITEBOARD_CODES: {
			get: vi.fn(async () => staleProfile(clerkUserId)),
			put,
		},
	} as unknown as Env
	return { env, put }
}

function authenticateAs(clerkUserId: string): void {
	clerkMocks.authenticateRequest.mockResolvedValue({
		isAuthenticated: true,
		toAuth: () => ({ userId: clerkUserId }),
	})
}

describe('Clerk stale profile refresh', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'))
		clerkMocks.authenticateRequest.mockReset()
		clerkMocks.getUser.mockReset()
		clerkMocks.waitUntil.mockReset()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('returns stale auth immediately and shares one lifetime-bound refresh', async () => {
		const clerkUserId = 'concurrent-user'
		const pendingUser = deferred<ReturnType<typeof freshClerkUser>>()
		const lifetimePromises: Promise<unknown>[] = []
		const { env, put } = authEnv(clerkUserId)
		authenticateAs(clerkUserId)
		clerkMocks.getUser.mockReturnValue(pendingUser.promise)
		clerkMocks.waitUntil.mockImplementation((promise: Promise<unknown>) => {
			lifetimePromises.push(promise)
		})

		const results = await Promise.all([
			requireClerkWhiteboardAuth(authRequest(), env),
			requireClerkWhiteboardAuth(authRequest(), env),
			requireClerkWhiteboardAuth(authRequest(), env),
		])

		expect(results.every((result) => result.ok)).toBe(true)
		expect(results[0]).toMatchObject({
			ok: true,
			auth: {
				accountId: `google-${clerkUserId}`,
				displayName: 'Cached User',
			},
		})
		expect(clerkMocks.getUser).toHaveBeenCalledTimes(1)
		expect(clerkMocks.waitUntil).toHaveBeenCalledTimes(1)
		expect(lifetimePromises).toHaveLength(1)
		expect(put).not.toHaveBeenCalled()

		pendingUser.resolve(freshClerkUser(clerkUserId))
		await Promise.all(lifetimePromises)

		expect(put).toHaveBeenCalledTimes(1)
		expect(put).toHaveBeenCalledWith(
			`clerkuser:${clerkUserId}`,
			expect.stringContaining(`fresh-${clerkUserId}`),
			{ expirationTtl: 30 * 24 * 60 * 60 },
		)
	})

	it('suppresses immediate refresh retries after a Clerk timeout', async () => {
		const clerkUserId = 'cooldown-user'
		const lifetimePromises: Promise<unknown>[] = []
		const { env } = authEnv(clerkUserId)
		authenticateAs(clerkUserId)
		clerkMocks.getUser.mockReturnValue(new Promise(() => undefined))
		clerkMocks.waitUntil.mockImplementation((promise: Promise<unknown>) => {
			lifetimePromises.push(promise)
		})

		const first = await requireClerkWhiteboardAuth(authRequest(), env)
		expect(first.ok).toBe(true)
		await vi.advanceTimersByTimeAsync(5_001)
		await Promise.all(lifetimePromises)
		expect(clerkMocks.getUser).toHaveBeenCalledTimes(1)

		const second = await requireClerkWhiteboardAuth(authRequest(), env)
		expect(second.ok).toBe(true)
		expect(clerkMocks.getUser).toHaveBeenCalledTimes(1)
		expect(clerkMocks.waitUntil).toHaveBeenCalledTimes(1)

		vi.advanceTimersByTime(60_001)
		await requireClerkWhiteboardAuth(authRequest(), env)
		await vi.advanceTimersByTimeAsync(5_001)
		await Promise.all(lifetimePromises)
		expect(clerkMocks.getUser).toHaveBeenCalledTimes(2)
		expect(clerkMocks.waitUntil).toHaveBeenCalledTimes(2)
	})
})
