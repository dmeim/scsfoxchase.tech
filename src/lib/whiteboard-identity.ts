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

type WhiteboardAuthStore = {
	identity: WhiteboardIdentity | null
	sessionTokenGetter: (() => Promise<string | null>) | null
	authResolved: boolean
}

/**
 * Shared by every Vite client entry (Clerk island, Excalidraw island, hub/menu
 * scripts). Module-local `let` state is duplicated when those entries bundle
 * this file separately, which made the board-page manage panel think the user
 * was signed out while the hub library used the Clerk island's copy.
 */
function getAuthStore(): WhiteboardAuthStore {
	if (typeof window === 'undefined') {
		return {
			identity: null,
			sessionTokenGetter: null,
			authResolved: false,
		}
	}
	const root = window as Window & { [AUTH_STORE_KEY]?: WhiteboardAuthStore }
	if (!root[AUTH_STORE_KEY]) {
		root[AUTH_STORE_KEY] = {
			identity: null,
			sessionTokenGetter: null,
			authResolved: false,
		}
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
	getter: (() => Promise<string | null>) | null,
): void {
	getAuthStore().sessionTokenGetter = getter
}

export async function getSessionToken(): Promise<string | null> {
	const getter = getAuthStore().sessionTokenGetter
	if (!getter) return null
	try {
		return await getter()
	} catch {
		return null
	}
}

/** Signed-in connect must not race Clerk `getToken()` — empty token → Viewer hello. */
export async function waitForSessionToken(
	tries = 20,
	delayMs = 100,
): Promise<string | null> {
	for (let i = 0; i < tries; i++) {
		const token = await getSessionToken()
		if (token) return token
		if (!isSignedIn()) return null
		await new Promise((resolve) => setTimeout(resolve, delayMs))
	}
	return getSessionToken()
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
		(account) => account.provider === 'google',
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
