import { describe, expect, it } from 'vitest'
import {
	clerkMatchesCloudOwner,
	resolveClerkAuthFromProfile,
	shouldWriteCloudOwnerFromClerk,
	type ClerkVerifyResult,
	type ClerkWhiteboardAuth,
} from '../src/worker/clerkAuth'
import {
	ROLE_RESOLVE_DEADLINE_MS,
	resolveWbAuthOutcome,
	shouldForceRoleResolved,
	shouldRetryWhiteboardAuth,
	type WbAuthReason,
} from '../src/lib/whiteboard-sync'

const ALLOWLIST_ENV = { PUBLIC_CLERK_ALLOWED_DOMAINS: 'scsfoxchase.tech' }

function authReasonFromClerkResult(result: ClerkVerifyResult): WbAuthReason | undefined {
	return resolveWbAuthOutcome({
		signedIn: true,
		roleCanEdit: false,
		tokenResult: result.ok
			? { ok: true, profileDegraded: result.auth.profileDegraded === true }
			: { ok: false, reason: result.reason },
	}).reason
}

describe('resolveWbAuthOutcome reason mapping', () => {
	it('maps each ClerkVerifyResult failure onto the matching wb:authResult reason', () => {
		expect(
			authReasonFromClerkResult({ ok: false, reason: 'no_token' }),
		).toBe('awaiting_token')
		expect(
			authReasonFromClerkResult({ ok: false, reason: 'token_invalid' }),
		).toBe('token_invalid')
		expect(
			authReasonFromClerkResult({ ok: false, reason: 'clerk_unreachable' }),
		).toBe('clerk_unreachable')
		expect(
			authReasonFromClerkResult({ ok: false, reason: 'account_not_allowed' }),
		).toBe('account_not_allowed')
	})

	it('keeps a signed-in viewer pending when Clerk returned no token', () => {
		const outcome = resolveWbAuthOutcome({
			signedIn: true,
			roleCanEdit: false,
			tokenResult: { ok: false, reason: 'no_token' },
		})
		expect(outcome).toEqual({
			roleResolved: false,
			reason: 'awaiting_token',
		})
	})

	it('does not treat a bad JWT as terminal when host or share-code already grants edit', () => {
		expect(
			resolveWbAuthOutcome({
				signedIn: true,
				roleCanEdit: true,
				tokenResult: { ok: false, reason: 'token_invalid' },
			}),
		).toEqual({ roleResolved: true })
	})

	it('does not deny a degraded profile that still has a stored/share-code edit role', () => {
		expect(
			resolveWbAuthOutcome({
				signedIn: true,
				roleCanEdit: true,
				tokenResult: { ok: true, profileDegraded: true },
			}),
		).toEqual({ roleResolved: true })
	})
})

describe('empty email is not an allowlist denial', () => {
	it('accepts a missing profile when the school allowlist is configured', () => {
		const result = resolveClerkAuthFromProfile(
			'user_clerk',
			null,
			ALLOWLIST_ENV,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.auth.profileDegraded).toBe(true)
		expect(result.auth.email).toBe('')
		expect(result.auth.accountId).toBe('user_clerk')
	})

	it('accepts a resolved profile that has no email address', () => {
		const result = resolveClerkAuthFromProfile(
			'user_clerk',
			{
				accountId: 'google-sub',
				email: '',
				displayName: 'Teacher',
			},
			ALLOWLIST_ENV,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.auth.profileDegraded).toBe(true)
		expect(result.auth.accountId).toBe('google-sub')
		expect(result.auth.ownerKey).toBe('google:google-sub')
	})

	it('still denies a real email that is not on the allowlist', () => {
		const result = resolveClerkAuthFromProfile(
			'user_clerk',
			{
				accountId: 'google-sub',
				email: 'stranger@gmail.com',
				displayName: 'Stranger',
			},
			ALLOWLIST_ENV,
		)
		expect(result).toEqual({ ok: false, reason: 'account_not_allowed' })
	})
})

describe('profileDegraded must not claim cloud ownership', () => {
	const degraded: ClerkWhiteboardAuth = {
		clerkUserId: 'user_clerk',
		accountId: 'user_clerk',
		ownerKey: 'google:user_clerk',
		email: '',
		displayName: 'Signed-in user',
		profileDegraded: true,
	}

	it('does not match the real google:{sub} owner key', () => {
		expect(
			clerkMatchesCloudOwner(degraded, 'google:google-sub'),
		).toBe(false)
		expect(clerkMatchesCloudOwner(degraded, degraded.ownerKey)).toBe(false)
	})

	it('does not write META_CLOUD_OWNER_KEY', () => {
		expect(shouldWriteCloudOwnerFromClerk(degraded)).toBe(false)
	})

	it('a full profile still matches and may write the owner key', () => {
		const full: ClerkWhiteboardAuth = {
			...degraded,
			accountId: 'google-sub',
			ownerKey: 'google:google-sub',
			email: 'teacher@scsfoxchase.tech',
			profileDegraded: false,
		}
		expect(clerkMatchesCloudOwner(full, 'google:google-sub')).toBe(true)
		expect(shouldWriteCloudOwnerFromClerk(full)).toBe(true)
	})
})

describe('role-resolve deadline', () => {
	it('forces resolve when connectedAt is older than ROLE_RESOLVE_DEADLINE_MS', () => {
		expect(
			shouldForceRoleResolved({
				roleResolved: false,
				connectedAt: 0,
				now: ROLE_RESOLVE_DEADLINE_MS + 1,
			}),
		).toBe(true)
	})

	it('does not force resolve at or before the deadline, or once already resolved', () => {
		expect(
			shouldForceRoleResolved({
				roleResolved: false,
				connectedAt: 0,
				now: ROLE_RESOLVE_DEADLINE_MS,
			}),
		).toBe(false)
		expect(
			shouldForceRoleResolved({
				roleResolved: true,
				connectedAt: 0,
				now: ROLE_RESOLVE_DEADLINE_MS + 60_000,
			}),
		).toBe(false)
	})
})

describe('auth retry arming', () => {
	it('keeps retrying while the role is unresolved even after a token was sent', () => {
		expect(
			shouldRetryWhiteboardAuth({
				roleResolved: false,
				tokenAlreadySent: true,
			}),
		).toBe(true)
	})

	it('stops retrying once the role is resolved', () => {
		expect(
			shouldRetryWhiteboardAuth({
				roleResolved: true,
				tokenAlreadySent: false,
			}),
		).toBe(false)
	})
})
