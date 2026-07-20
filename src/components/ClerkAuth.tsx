/**
 * Header Clerk controls — Google-only sign-in / sign-out.
 *
 * Astro 7: `@clerk/astro` peer range stops at Astro 6, so this uses `@clerk/react`
 * islands. Migrate to `@clerk/astro` when Astro 7 support ships.
 *
 * Keep this idiomatic: SignInButton + UserButton. Google-only is configured in
 * the Clerk Dashboard (not in custom OAuth redirect code).
 *
 * Note: production Clerk keys (pk_live_) reject localhost origins — test auth on
 * https://scsfoxchase.tech, or use a separate pk_test_ development instance locally.
 */
import {
	ClerkFailed,
	ClerkProvider,
	SignInButton,
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
				<SignInButton mode="modal">
					<button type="button" className="header-auth-btn">
						Sign in
					</button>
				</SignInButton>
			)}
		</div>
	)
}

export default function ClerkAuth() {
	if (!publishableKey) {
		return null
	}

	return (
		<ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
			<ClerkAuthInner />
		</ClerkProvider>
	)
}
