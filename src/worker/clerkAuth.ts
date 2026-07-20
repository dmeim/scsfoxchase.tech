/**
 * Clerk session verification for Worker `/api/whiteboard/*` routes.
 * Uses @clerk/backend authenticateRequest + optional users.getUser for Google sub.
 */
import { createClerkClient } from '@clerk/backend'

export type ClerkWhiteboardAuth = {
	clerkUserId: string
	accountId: string
	ownerKey: string
	email: string
	displayName: string
	avatarUrl?: string
}

function publishableKey(env: Env): string {
	return (
		env.PUBLIC_CLERK_PUBLISHABLE_KEY ||
		env.CLERK_PUBLISHABLE_KEY ||
		''
	)
}

function parseAllowedDomains(raw: string | undefined): {
	domains: string[]
	emails: string[]
} {
	const domains: string[] = []
	const emails: string[] = []
	for (const part of (raw || '').split(',')) {
		const item = part.trim().toLowerCase()
		if (!item) continue
		if (item.includes('@')) emails.push(item)
		else domains.push(item)
	}
	return { domains, emails }
}

export function isEmailAllowed(email: string, env: Env): boolean {
	const { domains, emails } = parseAllowedDomains(
		env.PUBLIC_CLERK_ALLOWED_DOMAINS,
	)
	if (domains.length === 0 && emails.length === 0) return true
	const normalized = email.trim().toLowerCase()
	if (!normalized) return false
	if (emails.includes(normalized)) return true
	const domain = normalized.split('@')[1]
	return !!domain && domains.includes(domain)
}

function authorizedParties(request: Request): string[] {
	const origin = request.headers.get('Origin')
	const parties = new Set<string>([
		'https://scsfoxchase.tech',
		'https://www.scsfoxchase.tech',
		'http://localhost:4321',
		'http://127.0.0.1:4321',
	])
	if (origin) parties.add(origin)
	return [...parties]
}

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

/**
 * Require a valid Clerk session. Resolves Google sub when available.
 */
export async function requireClerkWhiteboardAuth(
	request: Request,
	env: Env,
): Promise<
	{ ok: true; auth: ClerkWhiteboardAuth } | { ok: false; response: Response }
> {
	const secretKey = env.CLERK_SECRET_KEY
	const pk = publishableKey(env)
	if (!secretKey || !pk) {
		return {
			ok: false,
			response: jsonError(503, 'Clerk is not configured on this Worker'),
		}
	}

	const clerk = createClerkClient({
		secretKey,
		publishableKey: pk,
	})

	const state = await clerk.authenticateRequest(request, {
		authorizedParties: authorizedParties(request),
	})

	if (!state.isAuthenticated) {
		return {
			ok: false,
			response: jsonError(401, 'Sign in required'),
		}
	}

	const sessionAuth = state.toAuth()
	const clerkUserId = sessionAuth.userId
	if (!clerkUserId) {
		return {
			ok: false,
			response: jsonError(401, 'Sign in required'),
		}
	}

	let email = ''
	let displayName = 'Signed-in user'
	let avatarUrl: string | undefined
	let accountId = clerkUserId

	try {
		const user = await clerk.users.getUser(clerkUserId)
		email =
			user.primaryEmailAddress?.emailAddress ||
			user.emailAddresses[0]?.emailAddress ||
			''
		displayName =
			user.fullName?.trim() ||
			[user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
			user.username?.trim() ||
			email.split('@')[0] ||
			'Signed-in user'
		avatarUrl = user.imageUrl || undefined
		const google = user.externalAccounts.find(
			(account) => account.provider === 'google',
		)
		const googleSub = (
			google?.providerUserId ||
			google?.externalId ||
			''
		).trim()
		if (googleSub) accountId = googleSub
		if (!email) {
			const googleEmail = (
				google as { emailAddress?: string | null } | undefined
			)?.emailAddress
			if (googleEmail) email = googleEmail
		}
	} catch {
		// Fall back to Clerk user id if BAPI user fetch fails
	}

	// Empty email must fail when an allowlist is configured (isEmailAllowed
	// returns false for blank email once domains/emails are set).
	if (!isEmailAllowed(email, env)) {
		return {
			ok: false,
			response: jsonError(
				403,
				'This Google account is not allowed for school whiteboards',
			),
		}
	}

	return {
		ok: true,
		auth: {
			clerkUserId,
			accountId,
			ownerKey: `google:${accountId}`,
			email,
			displayName,
			avatarUrl,
		},
	}
}
