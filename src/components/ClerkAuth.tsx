/**
 * Header Clerk controls — Google-only sign-in / sign-out.
 *
 * Astro 7: `@clerk/astro` peer range stops at Astro 6, so this uses `@clerk/react`
 * islands. Migrate to `@clerk/astro` when Astro 7 support ships.
 *
 * Important: Clerk's `<Show>` returns null while auth is loading, which left the
 * header with no Sign in control. We render Sign in whenever the user is not
 * signed in (including the loading window).
 *
 * Do not leave the button `disabled` forever waiting on SignIn — that maps to
 * CSS `cursor: wait` and looks broken if Clerk/SignIn is slow or fails.
 */
import {
	ClerkFailed,
	ClerkProvider,
	UserButton,
	useAuth,
	useClerk,
	useSignIn,
	useSignUp,
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

const LOAD_TIMEOUT_MS = 6_000

/** Absolute app URL for Clerk OAuth redirect targets. */
function appUrl(path: string): string {
	const origin = window.location.origin
	return `${origin}${path.startsWith('/') ? path : `/${path}`}`
}

function clerkErrorMessage(error: unknown): string {
	if (!error || typeof error !== 'object') return 'Sign in failed. Try again.'
	const err = error as {
		errors?: Array<{ longMessage?: string; message?: string; code?: string }>
		message?: string
	}
	const first = err.errors?.[0]
	return (
		first?.longMessage ||
		first?.message ||
		err.message ||
		'Sign in failed. Try again.'
	)
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

function GoogleSignInButton() {
	const clerk = useClerk()
	const { isLoaded: signInLoaded, signIn } = useSignIn()
	const { isLoaded: signUpLoaded, signUp } = useSignUp()
	const [busy, setBusy] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [loadTimedOut, setLoadTimedOut] = useState(false)

	const resourcesReady = clerk.loaded && signInLoaded && !!signIn
	// Brief wait only — never park on cursor:wait forever if SignIn hangs.
	const waitingForClerk = !resourcesReady && !loadTimedOut

	useEffect(() => {
		if (resourcesReady) {
			setLoadTimedOut(false)
			setErrorMessage((prev) =>
				prev?.startsWith('Sign in is taking too long') ||
				prev?.startsWith('Clerk blocked this origin')
					? null
					: prev,
			)
			return
		}
		const id = window.setTimeout(() => {
			setLoadTimedOut(true)
			const host = window.location.hostname
			const isLocal =
				host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
			setErrorMessage(
				isLocal
					? 'Clerk blocked this origin. Production keys (pk_live_) do not work on localhost — use a Clerk development instance for local auth, or test on https://scsfoxchase.tech.'
					: 'Sign in is taking too long. Refresh the page, or try again.',
			)
		}, LOAD_TIMEOUT_MS)
		return () => window.clearTimeout(id)
	}, [resourcesReady])

	const startGoogleOAuth = async () => {
		if (busy) return

		if (!signInLoaded || !signIn) {
			setErrorMessage(
				loadTimedOut
					? 'Sign in failed to load. Refresh the page.'
					: 'Sign in is still loading…',
			)
			return
		}

		setBusy(true)
		setErrorMessage(null)

		const redirectUrl = appUrl('/sso-callback')
		const redirectUrlComplete = window.location.href
		try {
			sessionStorage.setItem('clerk_return_url', redirectUrlComplete)
		} catch {
			/* ignore */
		}

		try {
			await signIn.authenticateWithRedirect({
				strategy: 'oauth_google',
				redirectUrl,
				redirectUrlComplete,
			})
			// Browser should navigate away; keep busy if it does not.
		} catch (signInError) {
			// First-time Google users may need the sign-up OAuth path.
			const code =
				signInError &&
				typeof signInError === 'object' &&
				'errors' in signInError
					? (
							signInError as {
								errors?: Array<{ code?: string }>
							}
						).errors?.[0]?.code
					: undefined
			const trySignUp =
				signUpLoaded &&
				!!signUp &&
				(code === 'external_account_not_found' ||
					code === 'identification_not_found' ||
					code === 'form_identifier_not_found' ||
					code === 'resource_not_found')

			if (trySignUp && signUp) {
				try {
					await signUp.authenticateWithRedirect({
						strategy: 'oauth_google',
						redirectUrl,
						redirectUrlComplete,
					})
					return
				} catch (signUpError) {
					console.error('Google sign-up OAuth failed', signUpError)
					setErrorMessage(clerkErrorMessage(signUpError))
					setBusy(false)
					return
				}
			}

			console.error('Google sign-in failed', signInError)
			setErrorMessage(clerkErrorMessage(signInError))
			setBusy(false)
		}
	}

	return (
		<>
			<button
				type="button"
				className="header-auth-btn"
				onClick={() => void startGoogleOAuth()}
				disabled={busy || waitingForClerk}
				aria-busy={busy || waitingForClerk}
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
			<ClerkFailed>
				<span className="header-auth-hint" role="alert">
					Sign in unavailable. Refresh and try again.
				</span>
			</ClerkFailed>
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
				<GoogleSignInButton />
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
