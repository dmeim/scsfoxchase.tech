/**
 * Completes Clerk Google OAuth after redirect from the provider.
 * Mounted on `/sso-callback` — required by SignIn.authenticateWithRedirect.
 */
import {
	AuthenticateWithRedirectCallback,
	ClerkProvider,
} from '@clerk/react'

const publishableKey = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY as
	| string
	| undefined

export default function SsoCallback() {
	if (!publishableKey) {
		return (
			<p className="header-auth-hint" role="alert">
				Sign-in is not configured.
			</p>
		)
	}

	return (
		<ClerkProvider publishableKey={publishableKey}>
			<div className="sso-callback" role="status" aria-live="polite">
				<p>Finishing sign-in…</p>
				<AuthenticateWithRedirectCallback />
			</div>
		</ClerkProvider>
	)
}
