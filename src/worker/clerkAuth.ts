/**
 * Clerk session verification for Worker `/api/whiteboard/*` routes.
 * Uses @clerk/backend authenticateRequest + verifyToken (WebSocket first-message)
 * and optional users.getUser for Google sub.
 */
import { createClerkClient, verifyToken } from '@clerk/backend'
import { waitUntil } from 'cloudflare:workers'

export type ClerkWhiteboardAuth = {
	clerkUserId: string
	accountId: string
	ownerKey: string
	email: string
	displayName: string
	avatarUrl?: string
}

function publishableKey(env: Env): string {
	return env.PUBLIC_CLERK_PUBLISHABLE_KEY || ''
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

const TRUSTED_AUTHORIZED_PARTIES = [
	'https://scsfoxchase.tech',
	'https://www.scsfoxchase.tech',
	// Custom Clerk Frontend API — session JWTs may set azp to this host.
	'https://clerk.scsfoxchase.tech',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
] as const

function authorizedParties(): string[] {
	return [...TRUSTED_AUTHORIZED_PARTIES]
}

/**
 * Clerk rejects tokens when `authorizedParties` is non-empty and `azp` is
 * missing or not an exact string match. Keep this list fixed; request Origin
 * and token claims must never widen the trusted-party boundary.
 */
export function authorizedPartiesForToken(
	_token?: string,
	_origin?: string | null,
): string[] {
	// Clerk's azp is an issuer-controlled claim. Request Origin and token azp
	// are intentionally not promoted to authorized parties: doing so would let
	// an arbitrary cross-origin request widen the trust boundary.
	return authorizedParties()
}

function isGoogleExternalAccount(account: { provider?: string | null }): boolean {
	const provider = (account.provider || '').toLowerCase()
	// Clerk reports `oauth_google`; custom OAuth credentials can report
	// `oauth_custom_google`. Missing this match flips accountId to the Clerk
	// user id, which changes ownerKey and "loses" the R2 library index.
	return provider === 'google' || provider.endsWith('_google')
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

/**
 * Cached Clerk profile. `users.getUser` is a BAPI network call — doing it on
 * every connect/hello/library request hits Clerk rate limits (SDK retries
 * with backoff → boards appear to hang for a minute) and, worse, a failed
 * fetch used to silently flip `accountId` from the Google sub to the Clerk
 * user id, which changes `ownerKey` and "loses" the R2 library index.
 *
 * Memory (per isolate, 10 min fresh) + KV (`clerkuser:{id}`, 30 days) keep
 * identity stable and keep BAPI off the hot path.
 */
type CachedClerkProfile = {
	accountId: string
	email: string
	displayName: string
	avatarUrl?: string
	profileUpdatedAt?: number
	fetchedAt: number
}

type ClerkProfileResolveOptions = {
	refreshProfile?: boolean
	profileUpdatedAt?: number
}

const PROFILE_MEMORY_FRESH_MS = 10 * 60 * 1000
const PROFILE_KV_TTL_SECONDS = 30 * 24 * 60 * 60
const PROFILE_KV_REFRESH_MS = 24 * 60 * 60 * 1000
const PROFILE_FETCH_TIMEOUT_MS = 5000
const PROFILE_REFRESH_RETRY_COOLDOWN_MS = 60 * 1000
/** Bound explicit profile refreshes without delaying the first real update. */
const PROFILE_EXPLICIT_REFRESH_COOLDOWN_MS = 5 * 1000

const profileMemoryCache = new Map<string, CachedClerkProfile>()
const profileRefreshInFlight = new Map<string, Promise<void>>()
const profileRefreshRetryAfter = new Map<string, number>()
const profileExplicitRefreshInFlight = new Map<
	string,
	Promise<CachedClerkProfile | null>
>()
const profileExplicitRefreshAfter = new Map<string, number>()

function profileKvKey(clerkUserId: string): string {
	return `clerkuser:${clerkUserId}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([
		promise,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
	])
}

async function fetchProfileFromClerk(
	clerk: ReturnType<typeof createClerkClient>,
	clerkUserId: string,
): Promise<CachedClerkProfile | null> {
	try {
		const user = await clerk.users.getUser(clerkUserId)
		let email =
			user.primaryEmailAddress?.emailAddress ||
			user.emailAddresses[0]?.emailAddress ||
			''
		const google = user.externalAccounts.find(isGoogleExternalAccount)
		const googleSub = (
			google?.providerUserId ||
			google?.externalId ||
			''
		).trim()
		if (!email) {
			const googleEmail = (
				google as { emailAddress?: string | null } | undefined
			)?.emailAddress
			if (googleEmail) email = googleEmail
		}
		const displayName =
			user.fullName?.trim() ||
			[user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
			user.username?.trim() ||
			email.split('@')[0] ||
			'Signed-in user'
		return {
			accountId: googleSub || clerkUserId,
			email,
			displayName,
			avatarUrl: user.imageUrl || undefined,
			profileUpdatedAt:
				Number.isSafeInteger(user.updatedAt) && user.updatedAt > 0
					? user.updatedAt
					: undefined,
			fetchedAt: Date.now(),
		}
	} catch {
		return null
	}
}

async function readKvProfile(
	env: Env,
	clerkUserId: string,
): Promise<CachedClerkProfile | null> {
	if (!env.WHITEBOARD_CODES) return null
	try {
		const raw = await env.WHITEBOARD_CODES.get(profileKvKey(clerkUserId))
		if (!raw) return null
		const parsed = JSON.parse(raw) as Partial<CachedClerkProfile>
		if (typeof parsed.accountId !== 'string' || !parsed.accountId) {
			return null
		}
		return {
			accountId: parsed.accountId,
			email: typeof parsed.email === 'string' ? parsed.email : '',
			displayName:
				typeof parsed.displayName === 'string' && parsed.displayName
					? parsed.displayName
					: 'Signed-in user',
			avatarUrl:
				typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : undefined,
			profileUpdatedAt:
				typeof parsed.profileUpdatedAt === 'number' &&
				Number.isSafeInteger(parsed.profileUpdatedAt) &&
				parsed.profileUpdatedAt > 0
					? parsed.profileUpdatedAt
					: undefined,
			fetchedAt:
				typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
		}
	} catch {
		return null
	}
}

async function refreshClerkProfileNow(
	clerk: ReturnType<typeof createClerkClient>,
	clerkUserId: string,
	env: Env,
	now: number,
): Promise<CachedClerkProfile | null> {
	const inFlight = profileExplicitRefreshInFlight.get(clerkUserId)
	if (inFlight) return inFlight
	if (now < (profileExplicitRefreshAfter.get(clerkUserId) ?? 0)) {
		return null
	}
	profileExplicitRefreshAfter.set(
		clerkUserId,
		now + PROFILE_EXPLICIT_REFRESH_COOLDOWN_MS,
	)
	let tracked: Promise<CachedClerkProfile | null>
	tracked = (async () => {
		const fresh = await withTimeout(
			fetchProfileFromClerk(clerk, clerkUserId),
			PROFILE_FETCH_TIMEOUT_MS,
		)
		if (!fresh) return null
		profileMemoryCache.set(clerkUserId, fresh)
		await writeKvProfile(env, clerkUserId, fresh)
		return fresh
	})().finally(() => {
		if (profileExplicitRefreshInFlight.get(clerkUserId) === tracked) {
			profileExplicitRefreshInFlight.delete(clerkUserId)
		}
	})
	profileExplicitRefreshInFlight.set(clerkUserId, tracked)
	return tracked
}

function clientHasNewerProfile(
	profile: CachedClerkProfile,
	options: ClerkProfileResolveOptions | undefined,
): boolean {
	const requested = options?.profileUpdatedAt
	return Boolean(
		typeof requested === 'number' &&
		Number.isSafeInteger(requested) &&
		requested > 0 &&
		requested > (profile.profileUpdatedAt ?? 0),
	)
}

async function writeKvProfile(
	env: Env,
	clerkUserId: string,
	profile: CachedClerkProfile,
): Promise<void> {
	if (!env.WHITEBOARD_CODES) return
	try {
		await env.WHITEBOARD_CODES.put(
			profileKvKey(clerkUserId),
			JSON.stringify(profile),
			{ expirationTtl: PROFILE_KV_TTL_SECONDS },
		)
	} catch {
		// Cache write failures must not fail auth
	}
}

function refreshClerkProfile(
	clerk: ReturnType<typeof createClerkClient>,
	clerkUserId: string,
	env: Env,
	now: number,
): void {
	if (profileRefreshInFlight.has(clerkUserId)) return

	const retryAfter = profileRefreshRetryAfter.get(clerkUserId) ?? 0
	if (now < retryAfter) return
	profileRefreshRetryAfter.delete(clerkUserId)

	let tracked: Promise<void>
	tracked = (async () => {
		const fresh = await withTimeout(
			fetchProfileFromClerk(clerk, clerkUserId),
			PROFILE_FETCH_TIMEOUT_MS,
		)
		if (!fresh) {
			profileRefreshRetryAfter.set(
				clerkUserId,
				Date.now() + PROFILE_REFRESH_RETRY_COOLDOWN_MS,
			)
			return
		}
		profileRefreshRetryAfter.delete(clerkUserId)
		profileMemoryCache.set(clerkUserId, fresh)
		await writeKvProfile(env, clerkUserId, fresh)
	})().finally(() => {
		if (profileRefreshInFlight.get(clerkUserId) === tracked) {
			profileRefreshInFlight.delete(clerkUserId)
		}
	})

	profileRefreshInFlight.set(clerkUserId, tracked)
	waitUntil(tracked)
}

async function resolveClerkProfile(
	clerk: ReturnType<typeof createClerkClient>,
	clerkUserId: string,
	env: Env,
	options?: ClerkProfileResolveOptions,
): Promise<CachedClerkProfile | null> {
	const now = Date.now()
	const memory = profileMemoryCache.get(clerkUserId)
	if (
		memory &&
		(options?.refreshProfile || clientHasNewerProfile(memory, options))
	) {
		const fresh = await refreshClerkProfileNow(clerk, clerkUserId, env, now)
		if (fresh) return fresh
	}
	if (memory && now - memory.fetchedAt < PROFILE_MEMORY_FRESH_MS) {
		return memory
	}

	const kv = await readKvProfile(env, clerkUserId)
	if (kv) {
		profileMemoryCache.set(clerkUserId, kv)
		if (options?.refreshProfile || clientHasNewerProfile(kv, options)) {
			const fresh = await refreshClerkProfileNow(clerk, clerkUserId, env, now)
			if (fresh) return fresh
		}
		if (now - kv.fetchedAt > PROFILE_KV_REFRESH_MS) {
			refreshClerkProfile(clerk, clerkUserId, env, now)
		}
		return kv
	}

	const fresh = await withTimeout(
		fetchProfileFromClerk(clerk, clerkUserId),
		PROFILE_FETCH_TIMEOUT_MS,
	)
	if (fresh) {
		profileMemoryCache.set(clerkUserId, fresh)
		await writeKvProfile(env, clerkUserId, fresh)
		return fresh
	}

	// Stale memory beats an identity flip to the Clerk user id.
	return memory ?? null
}

async function authFromClerkUserId(
	clerk: ReturnType<typeof createClerkClient>,
	clerkUserId: string,
	env: Env,
	options?: ClerkProfileResolveOptions,
): Promise<ClerkWhiteboardAuth | null> {
	const profile = await resolveClerkProfile(clerk, clerkUserId, env, options)
	const accountId = profile?.accountId || clerkUserId
	const email = profile?.email ?? ''

	// Empty email must fail when an allowlist is configured (isEmailAllowed
	// returns false for blank email once domains/emails are set).
	if (!isEmailAllowed(email, env)) return null

	return {
		clerkUserId,
		accountId,
		ownerKey: `google:${accountId}`,
		email,
		displayName: profile?.displayName || 'Signed-in user',
		avatarUrl: profile?.avatarUrl,
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
		authorizedParties: authorizedParties(),
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
	options?: ClerkProfileResolveOptions,
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
		return authFromClerkUserId(clerkClient(env), clerkUserId, env, options)
	} catch {
		return null
	}
}
