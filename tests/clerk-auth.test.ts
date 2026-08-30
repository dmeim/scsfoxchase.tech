import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clerkMocks = vi.hoisted(() => ({
	authenticateRequest: vi.fn(),
	getUser: vi.fn(),
	verifyToken: vi.fn(),
	waitUntil: vi.fn(),
}))

vi.mock('@clerk/backend', () => ({
	createClerkClient: () => ({
		authenticateRequest: clerkMocks.authenticateRequest,
		users: { getUser: clerkMocks.getUser },
	}),
	verifyToken: clerkMocks.verifyToken,
}))

vi.mock('cloudflare:workers', () => ({
	waitUntil: clerkMocks.waitUntil,
}))

import {
	requireClerkWhiteboardAuth,
	verifyClerkWhiteboardToken,
} from '../src/worker/clerkAuth'

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
		profileUpdatedAt: Date.now() - 60_000,
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
		updatedAt: Date.now(),
	}
}

function authRequest(): Request {
	return new Request('https://scsfoxchase.tech/api/whiteboard/library/boards', {
		headers: { Authorization: 'Bearer session-token' },
	})
}

function authEnv(clerkUserId: string) {
	const put = vi.fn(async () => undefined)
	const get = vi.fn(async () => staleProfile(clerkUserId))
	const env = {
		CLERK_SECRET_KEY: 'test-secret',
		PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test',
		PUBLIC_CLERK_ALLOWED_DOMAINS: 'example.edu',
		WHITEBOARD_CODES: {
			get,
			put,
		},
	} as unknown as Env
	return { env, get, put }
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
		clerkMocks.verifyToken.mockReset()
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

	it('refreshes Clerk immediately when a connected user reports a profile update', async () => {
		const clerkUserId = 'profile-update-user'
		const { env, put } = authEnv(clerkUserId)
		clerkMocks.verifyToken.mockResolvedValue({ sub: clerkUserId })
		clerkMocks.getUser.mockResolvedValue(freshClerkUser(clerkUserId))

		const auth = await verifyClerkWhiteboardToken(
			'session-token',
			env,
			'https://scsfoxchase.tech',
			{ refreshProfile: true },
		)

		expect(auth).toMatchObject({
			clerkUserId,
			accountId: `fresh-${clerkUserId}`,
			displayName: 'Fresh User',
		})
		expect(clerkMocks.getUser).toHaveBeenCalledTimes(1)
		expect(put).toHaveBeenCalledWith(
			`clerkuser:${clerkUserId}`,
			expect.stringContaining('Fresh User'),
			{ expirationTtl: 30 * 24 * 60 * 60 },
		)
	})

	it('refreshes a newer Clerk profile revision on a later board visit', async () => {
		const clerkUserId = 'newer-profile-revision-user'
		const { env } = authEnv(clerkUserId)
		clerkMocks.verifyToken.mockResolvedValue({ sub: clerkUserId })
		clerkMocks.getUser.mockResolvedValue(freshClerkUser(clerkUserId))

		const auth = await verifyClerkWhiteboardToken(
			'session-token',
			env,
			'https://scsfoxchase.tech',
			{ profileUpdatedAt: Date.now() },
		)

		expect(auth?.displayName).toBe('Fresh User')
		expect(clerkMocks.getUser).toHaveBeenCalledTimes(1)
	})

	it('keeps the cache hot when the Clerk profile revision is unchanged', async () => {
		const clerkUserId = 'same-profile-revision-user'
		const { env, get } = authEnv(clerkUserId)
		clerkMocks.verifyToken.mockResolvedValue({ sub: clerkUserId })
		get.mockResolvedValue(
			JSON.stringify({
				accountId: `google-${clerkUserId}`,
				email: `${clerkUserId}@example.edu`,
				displayName: 'Cached User',
				profileUpdatedAt: Date.now() - 60_000,
				fetchedAt: Date.now(),
			}),
		)

		const auth = await verifyClerkWhiteboardToken(
			'session-token',
			env,
			'https://scsfoxchase.tech',
			{ profileUpdatedAt: Date.now() - 60_000 },
		)

		expect(auth?.displayName).toBe('Cached User')
		expect(clerkMocks.getUser).not.toHaveBeenCalled()
	})
})
