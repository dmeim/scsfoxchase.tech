/**
 * Completes Clerk Google OAuth after redirect from the provider.
 * Mounted on `/sso-callback` — required by SignIn/SignUp.authenticateWithRedirect.
 *
 * Uses AuthenticateWithRedirectCallback so first-time Google users (sign-up
 * transfer) and Turnstile captcha (enabled on this Clerk instance) can finish.
 */
import {
	AuthenticateWithRedirectCallback,
	ClerkFailed,
	ClerkProvider,
} from '@clerk/react'
import { useMemo } from 'react'

const publishableKey = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY as
	| string
	| undefined

function resolveReturnUrl(): string {
	if (typeof window === 'undefined') return '/'
	try {
		const stored = sessionStorage.getItem('clerk_return_url')
		if (stored && stored.startsWith(window.location.origin)) return stored
	} catch {
		/* ignore */
	}
	return `${window.location.origin}/`
}

function SsoCallbackInner() {
	const fallback = useMemo(() => resolveReturnUrl(), [])

	return (
		<div className="sso-callback" role="status" aria-live="polite">
			<p>Finishing sign-in…</p>
			<ClerkFailed>
				<p className="header-auth-hint" role="alert">
					Sign-in could not finish. <a href="/">Return home</a> and try
					again.
				</p>
			</ClerkFailed>
			<AuthenticateWithRedirectCallback
				signInFallbackRedirectUrl={fallback}
				signUpFallbackRedirectUrl={fallback}
				signInForceRedirectUrl={fallback}
				signUpForceRedirectUrl={fallback}
			/>
		</div>
	)
}

export default function SsoCallback() {
	if (!publishableKey) {
		return (
			<p className="header-auth-hint" role="alert">
				Sign-in is not configured.
			</p>
		)
	}

	// Own ClerkProvider — Astro islands do not share React trees with Header.
	// Header omits ClerkAuth on /sso-callback so this is the only provider.
	return (
		<ClerkProvider publishableKey={publishableKey}>
			<SsoCallbackInner />
		</ClerkProvider>
	)
}
