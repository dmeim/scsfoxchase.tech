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
import { useCallback, useEffect, useState } from 'react'
import {
	identityFromClerkUser,
	isEmailAllowed,
	markAuthResolved,
	markAuthResolvedAfterTokenSettle,
	setActiveIdentity,
	setSessionTokenGetter,
} from '../lib/whiteboard-identity'
import { iconLogIn } from '../scripts/icons'
import { ReactButton } from './ui/ReactButton'

const publishableKey = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY as
	| string
	| undefined

function SignInLabel() {
	return (
		<>
			<span
				className="header-chip-icon"
				aria-hidden="true"
				dangerouslySetInnerHTML={{ __html: iconLogIn }}
			/>
			Sign in
		</>
	)
}

/** Syncs Clerk session → whiteboard identity. No header UI (hints clutter the nav). */
function AuthBridge() {
	const { isLoaded, isSignedIn, getToken } = useAuth()
	const { user, isLoaded: userLoaded } = useUser()
	const clerk = useClerk()
	const userProfileSignature = user
		? [
				user.id,
				user.fullName ?? '',
				user.firstName ?? '',
				user.lastName ?? '',
				user.username ?? '',
				user.imageUrl ?? '',
				user.primaryEmailAddress?.emailAddress ?? '',
				user.updatedAt?.getTime() ?? 0,
			].join('\0')
		: ''

	useEffect(() => {
		setSessionTokenGetter(async (options) => {
			try {
				return (
					(await getToken(
						options?.skipCache ? { skipCache: true } : undefined,
					)) ?? null
				)
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
			markAuthResolved()
			return
		}

		const identity = identityFromClerkUser(user)
		if (!isEmailAllowed(identity.email)) {
			setActiveIdentity(null)
			markAuthResolved()
			void clerk.signOut({ redirectUrl: window.location.href })
			return
		}

		setActiveIdentity(identity)
		void markAuthResolvedAfterTokenSettle(() => getToken())
	}, [
		isLoaded,
		userLoaded,
		isSignedIn,
		user,
		userProfileSignature,
		clerk,
		getToken,
	])

	return null
}

/** If Clerk never loads, still unlock hub create / library (treat as signed out). */
function AuthReadyOnClerkFailed({ onFailed }: { onFailed: () => void }) {
	useEffect(() => {
		markAuthResolved()
		onFailed()
	}, [onFailed])
	return null
}

function ClerkAuthInner() {
	const { isLoaded, isSignedIn } = useAuth()
	const [signInUnavailable, setSignInUnavailable] = useState(false)
	const markUnavailable = useCallback(() => setSignInUnavailable(true), [])
	const showUserButton = !signInUnavailable && isLoaded && isSignedIn

	return (
		<div className="header-auth">
			<AuthBridge />
			<ClerkFailed>
				<AuthReadyOnClerkFailed onFailed={markUnavailable} />
			</ClerkFailed>
			{signInUnavailable ? (
				<ReactButton
					type="button"
					variant="glass"
					size="small"
					className="header-auth-btn"
					disabled
					title="Sign in unavailable"
					aria-label="Sign in unavailable"
				>
					<SignInLabel />
				</ReactButton>
			) : showUserButton ? (
				<UserButton
					appearance={{
						elements: {
							avatarBox: 'header-auth-avatar',
							userButtonTrigger: 'header-auth-user-btn',
						},
					}}
				/>
			) : (
				<SignInButton mode="modal">
					<ReactButton
						type="button"
						variant="glass"
						size="small"
						className="header-auth-btn"
						disabled={!isLoaded}
						aria-busy={!isLoaded || undefined}
						aria-label={isLoaded ? 'Sign in' : 'Sign in loading'}
					>
						<SignInLabel />
					</ReactButton>
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
