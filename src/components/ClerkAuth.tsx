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
	useSignIn,
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

/** Absolute app URL for Clerk OAuth redirect targets. */
function appUrl(path: string): string {
	const origin = window.location.origin
	return `${origin}${path.startsWith('/') ? path : `/${path}`}`
}

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
	const { isLoaded: signInLoaded, signIn } = useSignIn()
	const [busy, setBusy] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)

	const onClick = async () => {
		if (!ready || !signInLoaded || !signIn || busy) return
		setBusy(true)
		setErrorMessage(null)
		try {
			// Must use SignIn.authenticateWithRedirect — not clerk.* (that API does not exist).
			await signIn.authenticateWithRedirect({
				strategy: 'oauth_google',
				redirectUrl: appUrl('/sso-callback'),
				redirectUrlComplete: window.location.href,
			})
		} catch (error) {
			console.error('Google sign-in failed', error)
			setErrorMessage('Sign in failed. Try again.')
			setBusy(false)
		}
	}

	return (
		<>
			<button
				type="button"
				className="header-auth-btn"
				onClick={() => void onClick()}
				disabled={!ready || !signInLoaded || busy}
				aria-busy={busy || !ready || !signInLoaded}
			>
				{busy ? 'Signing in…' : 'Sign in'}
			</button>
			{errorMessage ? (
				<span className="header-auth-hint" role="alert">
					{errorMessage}
				</span>
			) : null}
		</>
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
