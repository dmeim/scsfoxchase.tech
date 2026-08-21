/**
 * Clerk session verification for Worker `/api/whiteboard/*` routes.
 * Uses @clerk/backend authenticateRequest + verifyToken (WebSocket first-message)
 * and optional users.getUser for Google sub.
 */
import { createClerkClient, verifyToken } from '@clerk/backend'

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
		// Custom Clerk Frontend API — session JWTs may set azp to this host.
		'https://clerk.scsfoxchase.tech',
		'http://localhost:4321',
		'http://127.0.0.1:4321',
	])
	if (origin) parties.add(origin)
	return [...parties]
}

function isTrustedAzpHost(host: string): boolean {
	const h = host.toLowerCase()
	if (
		h === 'scsfoxchase.tech' ||
		h === 'www.scsfoxchase.tech' ||
		h === 'clerk.scsfoxchase.tech' ||
		h === 'localhost' ||
		h === '127.0.0.1'
	) {
		return true
	}
	return h.endsWith('.scsfoxchase.tech')
}

function decodeJwtAzp(token: string): string | null {
	const parts = token.split('.')
	if (parts.length < 2 || !parts[1]) return null
	try {
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
		const pad = '='.repeat((4 - (b64.length % 4)) % 4)
		const json = atob(b64 + pad)
		const payload = JSON.parse(json) as { azp?: unknown }
		return typeof payload.azp === 'string' && payload.azp.trim()
			? payload.azp.trim()
			: null
	} catch {
		return null
	}
}

/**
 * Clerk rejects tokens when `authorizedParties` is non-empty and `azp` is
 * missing or not an exact string match. Include the token's own azp when its
 * host is this school site (or localhost).
 */
function authorizedPartiesForToken(
	token: string,
	origin?: string | null,
): string[] | undefined {
	const headers = new Headers()
	if (origin) headers.set('Origin', origin)
	const parties = new Set(
		authorizedParties(
			new Request('https://scsfoxchase.tech/api/whiteboard/connect', {
				method: 'GET',
				headers,
			}),
		),
	)
	const azp = decodeJwtAzp(token)
	if (!azp) return undefined
	try {
		const host = new URL(azp).hostname
		if (isTrustedAzpHost(host)) parties.add(azp)
	} catch {
		if (isTrustedAzpHost(azp)) parties.add(azp)
	}
	return [...parties]
}

function isGoogleExternalAccount(account: { provider?: string | null }): boolean {
	const provider = (account.provider || '').toLowerCase()
	return provider === 'google' || provider === 'oauth_google'
}

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function clerkClient(env: Env) {
	return createClerkClient({
		secretKey: env.CLERK_SECRET_KEY || '',
		publishableKey: publishableKey(env),
	})
}

async function authFromClerkUserId(
	clerk: ReturnType<typeof createClerkClient>,
	clerkUserId: string,
	env: Env,
): Promise<ClerkWhiteboardAuth | null> {
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
		const google = user.externalAccounts.find(isGoogleExternalAccount)
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
	if (!isEmailAllowed(email, env)) return null

	return {
		clerkUserId,
		accountId,
		ownerKey: `google:${accountId}`,
		email,
		displayName,
		avatarUrl,
	}
}

function subFromVerifyTokenResult(result: unknown): string {
	if (!result || typeof result !== 'object') return ''
	const rec = result as { data?: unknown; errors?: unknown; sub?: unknown }
	if (Array.isArray(rec.errors) && rec.errors.length > 0) return ''
	const inner =
		rec.data && typeof rec.data === 'object' ? rec.data : rec
	if (!inner || typeof inner !== 'object') return ''
	const sub = (inner as { sub?: unknown }).sub
	return typeof sub === 'string' ? sub : ''
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

	const clerk = clerkClient(env)

	const state = await clerk.authenticateRequest(request, {
		authorizedParties: authorizedParties(request),
	})

	if (!state.isAuthenticated) {
		const authorization = request.headers.get('Authorization')?.trim() || ''
		if (authorization.toLowerCase().startsWith('bearer ')) {
			const token = authorization.slice(7).trim()
			const fromToken = token
				? await verifyClerkWhiteboardToken(
						token,
						env,
						request.headers.get('Origin'),
					)
				: null
			if (fromToken) return { ok: true, auth: fromToken }
		}
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

	const auth = await authFromClerkUserId(clerk, clerkUserId, env)
	if (!auth) {
		return {
			ok: false,
			response: jsonError(
				403,
				'This Google account is not allowed for school whiteboards',
			),
		}
	}

	return { ok: true, auth }
}

/**
 * Optional Clerk check for WebSocket connect / public meta.
 * Returns null when unsigned, misconfigured, or not allowed — never throws.
 */
export async function tryClerkWhiteboardAuth(
	request: Request,
	env: Env,
): Promise<ClerkWhiteboardAuth | null> {
	const authorization = request.headers.get('Authorization')?.trim()
	const cookie = request.headers.get('Cookie') || ''
	if (!authorization && !/__session/i.test(cookie)) return null
	try {
		const result = await requireClerkWhiteboardAuth(request, env)
		return result.ok ? result.auth : null
	} catch {
		return null
	}
}

/**
 * Verify a Clerk session JWT from a WebSocket first-message or forwarded Bearer.
 * Do not put this token on a query string (access logs). Uses `verifyToken`
 * (signature + expiry) instead of wrapping the JWT in a fake Request for
 * `authenticateRequest`, which can fail handshake/azp on Durable Object sockets.
 */
export async function verifyClerkWhiteboardToken(
	token: string,
	env: Env,
	origin?: string | null,
): Promise<ClerkWhiteboardAuth | null> {
	const value = token.trim()
	if (!value) return null
	const secretKey = env.CLERK_SECRET_KEY
	const pk = publishableKey(env)
	if (!secretKey || !pk) return null
	try {
		const verified = await verifyToken(value, {
			secretKey,
			authorizedParties: authorizedPartiesForToken(value, origin),
		})
		const clerkUserId = subFromVerifyTokenResult(verified)
		if (!clerkUserId) return null
		return authFromClerkUserId(clerkClient(env), clerkUserId, env)
	} catch {
		return null
	}
}
