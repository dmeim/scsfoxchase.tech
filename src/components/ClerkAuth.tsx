/**
 * Header Clerk controls — Google-only sign-in / sign-out.
 *
 * Astro 7: `@clerk/astro` peer range stops at Astro 6, so this uses `@clerk/react`
 * islands. Migrate to `@clerk/astro` when Astro 7 support ships.
 *
 * Important: Clerk's `<Show>` returns null while auth is loading, which left the
 * header with no Sign in control. We render Sign in whenever the user is not
 * signed in (including the loading window).
 */
import {
	ClerkProvider,
	UserButton,
	useAuth,
	useClerk,
	useUser,
} from '@clerk/react'
import { useEffect, useState } from 'react'
import {
	identityFromClerkUser,
	isEmailAllowed,
	setActiveIdentity,
	setSessionTokenGetter,
} from '../lib/whiteboard-identity'

const publishableKey = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY as
	| string
	| undefined

function AuthBridge() {
	const { isLoaded, isSignedIn, getToken } = useAuth()
	const { user, isLoaded: userLoaded } = useUser()
	const clerk = useClerk()
	const [blockedMessage, setBlockedMessage] = useState<string | null>(null)

	useEffect(() => {
		setSessionTokenGetter(async () => {
			try {
				return (await getToken()) ?? null
			} catch {
				return null
			}
		})
		return () => setSessionTokenGetter(null)
	}, [getToken])

	useEffect(() => {
		if (!isLoaded || !userLoaded) return

		if (!isSignedIn || !user) {
			setActiveIdentity(null)
			setBlockedMessage(null)
			return
		}

		const identity = identityFromClerkUser(user)
		if (!isEmailAllowed(identity.email)) {
			setBlockedMessage(
				'Use a school Google account (@stceciliafc.com) to sign in.',
			)
			setActiveIdentity(null)
			void clerk.signOut({ redirectUrl: window.location.href })
			return
		}

		setBlockedMessage(null)
		setActiveIdentity(identity)
	}, [isLoaded, userLoaded, isSignedIn, user, clerk])

	if (!blockedMessage) return null
	return (
		<span className="header-auth-hint" role="status">
			{blockedMessage}
		</span>
	)
}

function GoogleSignInButton({ ready }: { ready: boolean }) {
	const clerk = useClerk()
	const [busy, setBusy] = useState(false)

	const onClick = async () => {
		if (!ready || busy) return
		setBusy(true)
		try {
			await clerk.authenticateWithRedirect({
				strategy: 'oauth_google',
				redirectUrl: window.location.href,
				redirectUrlComplete: window.location.href,
			})
		} catch (error) {
			console.error('Google sign-in failed', error)
			setBusy(false)
		}
	}

	return (
		<button
			type="button"
			className="header-auth-btn"
			onClick={() => void onClick()}
			disabled={!ready || busy}
			aria-busy={busy || !ready}
		>
			{busy ? 'Signing in…' : 'Sign in'}
		</button>
	)
}

function ClerkAuthInner() {
	const { isLoaded, isSignedIn } = useAuth()
	const showUserButton = isLoaded && isSignedIn

	return (
		<div className="header-auth">
			<AuthBridge />
			{showUserButton ? (
				<UserButton
					appearance={{
						elements: {
							avatarBox: {
								width: '28px',
								height: '28px',
								borderRadius: '2px',
							},
						},
					}}
				/>
			) : (
				<GoogleSignInButton ready={isLoaded} />
			)}
		</div>
	)
}

export default function ClerkAuth() {
	if (!publishableKey) {
		return null
	}

	return (
		<ClerkProvider
			publishableKey={publishableKey}
			afterSignOutUrl="/"
		>
			<ClerkAuthInner />
		</ClerkProvider>
	)
}
