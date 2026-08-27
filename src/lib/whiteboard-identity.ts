/**
 * Whiteboard auth identity + dual-mode owner keys (Phase 4b).
 *
 * Account key preference: Google OAuth `sub` (Clerk externalAccounts.providerUserId)
 * when present; otherwise Clerk `user.id`. Owner key is always `google:{accountId}`.
 *
 * `@clerk/astro` does not support Astro 7 yet — client uses `@clerk/react`;
 * Worker verifies sessions with `@clerk/backend`.
 */

export type WhiteboardIdentity = {
	/** Stable account id used in ownerKey (Google sub preferred). */
	accountId: string
	ownerKey: string
	email: string
	displayName: string
	avatarUrl?: string
	/** Clerk user id (session subject). */
	clerkUserId: string
}

const AUTH_EVENT = 'scsfoxchase:whiteboard-auth'
const AUTH_READY_EVENT = 'scsfoxchase:whiteboard-auth-ready'
const AUTH_STORE_KEY = '__scsfoxchaseWhiteboardAuth'

/** Clerk `getToken` hang budget. Empty token is OK; callers must still resolve. */
export const AUTH_GET_TOKEN_SETTLE_MS = 2_000

export type SessionTokenGetterOptions = {
	skipCache?: boolean
}

type WhiteboardAuthStore = {
	identity: WhiteboardIdentity | null
	sessionTokenGetter: ((options?: SessionTokenGetterOptions) => Promise<string | null>) | null
	authResolved: boolean
	/** Last non-empty JWT from a settled `getToken`. Sync peek for first `wb:auth`. */
	lastToken: string | null
}

function emptyAuthStore(): WhiteboardAuthStore {
	return {
		identity: null,
		sessionTokenGetter: null,
		authResolved: false,
		lastToken: null,
	}
}

/**
 * Shared by every Vite client entry (Clerk island, Excalidraw island, hub/menu
 * scripts). Module-local `let` state is duplicated when those entries bundle
 * this file separately, which made the board-page manage panel think the user
 * was signed out while the hub library used the Clerk island's copy.
 */
function getAuthStore(): WhiteboardAuthStore {
	if (typeof window === 'undefined') {
		return emptyAuthStore()
	}
	const root = window as Window & { [AUTH_STORE_KEY]?: WhiteboardAuthStore }
	if (!root[AUTH_STORE_KEY]) {
		root[AUTH_STORE_KEY] = emptyAuthStore()
	}
	return root[AUTH_STORE_KEY]
}

function identityKey(identity: WhiteboardIdentity | null): string {
	if (!identity) return ''
	return `${identity.accountId}\0${identity.clerkUserId}\0${identity.ownerKey}`
}

export function isClerkConfigured(): boolean {
	const key = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY as string | undefined
	return Boolean(key?.trim())
}

export function getActiveIdentity(): WhiteboardIdentity | null {
	return getAuthStore().identity
}

export function isSignedIn(): boolean {
	return getAuthStore().identity !== null
}

/**
 * Whether Clerk has settled enough to trust signed-in vs local mode.
 * When Clerk is not configured, always true (local-only mode).
 */
export function isAuthResolved(): boolean {
	if (!isClerkConfigured()) return true
	return getAuthStore().authResolved
}

/**
 * Mark Clerk auth as settled (signed in or confirmed signed out).
 * Idempotent — only the first call fires AUTH_READY listeners.
 */
export function markAuthResolved(): void {
	const store = getAuthStore()
	if (store.authResolved) return
	store.authResolved = true
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new Event(AUTH_READY_EVENT))
	}
}

/** Subscribe once Clerk has settled (or immediately if already resolved / no Clerk). */
export function onAuthReady(listener: () => void): () => void {
	if (typeof window === 'undefined') return () => {}
	if (isAuthResolved()) {
		queueMicrotask(listener)
		return () => {}
	}
	const handler = () => listener()
	window.addEventListener(AUTH_READY_EVENT, handler, { once: true })
	return () => window.removeEventListener(AUTH_READY_EVENT, handler)
}

/** Resolves when auth is ready to drive dual-mode owner keys. */
export function whenAuthReady(): Promise<void> {
	if (isAuthResolved()) return Promise.resolve()
	return new Promise((resolve) => {
		onAuthReady(() => resolve())
	})
}

export function setActiveIdentity(identity: WhiteboardIdentity | null): void {
	const store = getAuthStore()
	const changed = identityKey(store.identity) !== identityKey(identity)
	store.identity = identity
	if (!identity) store.lastToken = null
	if (!changed || typeof window === 'undefined') return
	window.dispatchEvent(
		new CustomEvent(AUTH_EVENT, { detail: identity }),
	)
}

export function onAuthChange(
	listener: (identity: WhiteboardIdentity | null) => void,
): () => void {
	if (typeof window === 'undefined') return () => {}
	const handler = (event: Event) => {
		const detail = (event as CustomEvent<WhiteboardIdentity | null>).detail
		const identity = detail ?? null
		getAuthStore().identity = identity
		listener(identity)
	}
	window.addEventListener(AUTH_EVENT, handler)
	return () => window.removeEventListener(AUTH_EVENT, handler)
}

export function setSessionTokenGetter(
	getter: ((options?: SessionTokenGetterOptions) => Promise<string | null>) | null,
): void {
	getAuthStore().sessionTokenGetter = getter
}

function nonEmptyToken(value: string | null | undefined): string | null {
	const token = value?.trim() ?? ''
	return token || null
}

function rememberToken(value: string | null | undefined): string | null {
	const token = nonEmptyToken(value)
	if (token) getAuthStore().lastToken = token
	return token
}

/** Cache a settled Clerk JWT so the next WebSocket `open` can send it without waiting. */
export function cacheSessionToken(value: string | null | undefined): void {
	rememberToken(value)
}

/** Last settled JWT, if any. Never awaits Clerk. */
export function peekSessionToken(): string | null {
	return getAuthStore().lastToken
}

/**
 * Resolve with `fallback` if `promise` has not settled in `ms`. Rejects become
 * `fallback` so a hanging Clerk `getToken` cannot block `whenAuthReady`.
 */
export function raceSettled<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T,
): Promise<T> {
	return new Promise((resolve) => {
		let settled = false
		const finish = (value: T) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(value)
		}
		const timer = setTimeout(() => finish(fallback), ms)
		promise.then(
			(value) => finish(value),
			() => finish(fallback),
		)
	})
}

export async function getSessionToken(): Promise<string | null> {
	const store = getAuthStore()
	const getter = store.sessionTokenGetter
	if (!getter) return store.lastToken
	try {
		return rememberToken(await getter()) ?? store.lastToken
	} catch {
		return store.lastToken
	}
}

/** Force Clerk to skip its JWT cache. Use only on auth retry, never the first frame. */
export async function getSessionTokenFresh(
	timeoutMs = AUTH_GET_TOKEN_SETTLE_MS,
): Promise<string | null> {
	const store = getAuthStore()
	const getter = store.sessionTokenGetter
	const fetchFresh = async () => {
		if (!getter) return store.lastToken
		try {
			return rememberToken(await getter({ skipCache: true })) ?? store.lastToken
		} catch {
			return store.lastToken
		}
	}
	return raceSettled(
		fetchFresh().then((value) => nonEmptyToken(value)),
		timeoutMs,
		peekSessionToken(),
	)
}

/** `getSessionToken` that cannot hang past `timeoutMs` (empty / cached token OK). */
export async function getSessionTokenSettled(
	timeoutMs = AUTH_GET_TOKEN_SETTLE_MS,
): Promise<string | null> {
	return raceSettled(
		getSessionToken().then((value) => nonEmptyToken(value)),
		timeoutMs,
		peekSessionToken(),
	)
}

/**
 * AuthBridge path: wait briefly for Clerk `getToken`, then always
 * `markAuthResolved`. A hang or empty JWT must not block `whenAuthReady`.
 */
export async function markAuthResolvedAfterTokenSettle(
	getToken: () => Promise<string | null | undefined>,
	timeoutMs = AUTH_GET_TOKEN_SETTLE_MS,
): Promise<string> {
	const clerkUserId = getAuthStore().identity?.clerkUserId ?? ''
	const token = await raceSettled(
		Promise.resolve()
			.then(getToken)
			.then((value) => value ?? '')
			.catch(() => ''),
		timeoutMs,
		'',
	)
	if (
		clerkUserId &&
		getAuthStore().identity?.clerkUserId === clerkUserId &&
		token.trim()
	) {
		cacheSessionToken(token)
	}
	markAuthResolved()
	return token
}

/**
 * Poll Clerk briefly for a session JWT, giving up after `tries`. Always
 * bounded: the board socket must stay responsive while Clerk is still
 * loading, so it sends `wb:auth` without a token and re-sends on its own
 * backoff once one exists (see `sendConnectAuth` in `WhiteboardCanvas.tsx`).
 */
export async function waitForSessionToken(
	tries = 20,
	delayMs = 100,
): Promise<string | null> {
	for (let i = 0; ; i++) {
		const token = nonEmptyToken(await getSessionToken())
		if (token) return token
		if (!isSignedIn()) return null
		if (i >= tries) return null
		await new Promise((resolve) => setTimeout(resolve, delayMs))
	}
}

/** Account ids / owner keys that may appear on Recents, DO meta, or hello. */
export function identityMatchIds(identity: WhiteboardIdentity): string[] {
	return [
		...new Set(
			[
				identity.accountId,
				identity.clerkUserId,
				identity.ownerKey,
				googleOwnerKey(identity.accountId),
				googleOwnerKey(identity.clerkUserId),
			].filter((id) => Boolean(id) && id !== 'google:'),
		),
	]
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
	const token = await getSessionToken()
	if (!token) return {}
	return { Authorization: `Bearer ${token}` }
}

/**
 * Parse PUBLIC_CLERK_ALLOWED_DOMAINS (comma-separated domains and/or full emails).
 * Empty / unset → allow all Google accounts (document in DEPLOYMENT.md).
 */
export function parseAllowedDomains(raw: string | undefined | null): {
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

export function isEmailAllowed(
	email: string,
	rawAllowlist = import.meta.env.PUBLIC_CLERK_ALLOWED_DOMAINS as
		| string
		| undefined,
): boolean {
	const { domains, emails } = parseAllowedDomains(rawAllowlist)
	if (domains.length === 0 && emails.length === 0) return true
	const normalized = email.trim().toLowerCase()
	if (!normalized) return false
	if (emails.includes(normalized)) return true
	const domain = normalized.split('@')[1]
	return !!domain && domains.includes(domain)
}

type ClerkLikeUser = {
	id: string
	fullName?: string | null
	firstName?: string | null
	lastName?: string | null
	username?: string | null
	imageUrl?: string | null
	primaryEmailAddress?: { emailAddress: string } | null
	emailAddresses?: Array<{ emailAddress: string }>
	externalAccounts?: Array<{
		provider: string
		providerUserId?: string | null
		externalId?: string | null
		emailAddress?: string | null
	}>
}

/**
 * Build whiteboard identity from a Clerk User resource.
 * Prefers Google providerUserId as accountId; falls back to Clerk user.id.
 */
export function identityFromClerkUser(user: ClerkLikeUser): WhiteboardIdentity {
	const google = user.externalAccounts?.find(
		(account) => {
			const provider = (account.provider || '').toLowerCase()
			// clerk-js reports `google`; backend/custom OAuth can report
			// `oauth_google` / `oauth_custom_google`. Must match the Worker
			// (`isGoogleExternalAccount`) or ownerKey flips between clients.
			return provider === 'google' || provider.endsWith('_google')
		},
	)
	const googleSub =
		(google?.providerUserId || google?.externalId || '').trim() || null
	const accountId = googleSub || user.id
	// Clerk instance may disable the email_address attribute for password flows
	// while still returning Google email on the external account.
	const email =
		user.primaryEmailAddress?.emailAddress ||
		user.emailAddresses?.[0]?.emailAddress ||
		google?.emailAddress ||
		''
	const displayName =
		user.fullName?.trim() ||
		[user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
		user.username?.trim() ||
		email.split('@')[0] ||
		'Signed-in user'

	return {
		accountId,
		ownerKey: `google:${accountId}`,
		email,
		displayName,
		avatarUrl: user.imageUrl || undefined,
		clerkUserId: user.id,
	}
}

export function googleOwnerKey(accountId: string): string {
	return `google:${accountId}`
}
