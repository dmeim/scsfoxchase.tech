const SITEVERIFY_URL =
	'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DEFAULT_TIMEOUT_MS = 8_000
const ACTION_RE = /^[A-Za-z0-9_-]{1,32}$/

export type TurnstileFailureReason =
	| 'invalid-token'
	| 'missing-secret'
	| 'invalid-expected-action'
	| 'missing-hostname-policy'
	| 'upstream-http'
	| 'upstream-content-type'
	| 'upstream-json'
	| 'upstream-shape'
	| 'challenge-failed'
	| 'action-mismatch'
	| 'hostname-mismatch'
	| 'upstream-unavailable'

export type TurnstileVerdict =
	| { ok: true }
	| { ok: false; reason: TurnstileFailureReason }

export type TurnstileVerification = {
	token: unknown
	remoteIp?: string
	expectedAction: string
	allowedHostnames: readonly string[]
	secret?: string
}

export type TurnstileDependencies = {
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

/** Verify one single-use Turnstile token and fail closed on every mismatch. */
export async function verifyTurnstile(
	verification: TurnstileVerification,
	dependencies: TurnstileDependencies = {},
): Promise<TurnstileVerdict> {
	const {
		token,
		remoteIp,
		expectedAction,
		allowedHostnames,
		secret,
	} = verification
	if (typeof token !== 'string' || token.length < 1 || token.length > 2_048) {
		return { ok: false, reason: 'invalid-token' }
	}
	if (typeof secret !== 'string' || !secret) {
		return { ok: false, reason: 'missing-secret' }
	}
	if (!ACTION_RE.test(expectedAction)) {
		return { ok: false, reason: 'invalid-expected-action' }
	}
	if (allowedHostnames.length === 0) {
		return { ok: false, reason: 'missing-hostname-policy' }
	}

	const fetchImpl = dependencies.fetchImpl ?? fetch
	const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const idempotencyKey = crypto.randomUUID()

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const body = new URLSearchParams({
				secret,
				response: token,
				idempotency_key: idempotencyKey,
			})
			if (remoteIp) body.set('remoteip', remoteIp)

			const response = await fetchImpl(SITEVERIFY_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
				signal: controller.signal,
			})
			const retryableStatus =
				response.status === 429 || response.status >= 500
			if (!response.ok) {
				if (retryableStatus && attempt === 0) continue
				return { ok: false, reason: 'upstream-http' }
			}

			const contentType = response.headers.get('Content-Type') || ''
			if (!contentType.toLowerCase().includes('application/json')) {
				return { ok: false, reason: 'upstream-content-type' }
			}

			let result: unknown
			try {
				result = await response.json()
			} catch {
				return { ok: false, reason: 'upstream-json' }
			}
			if (
				!result ||
				typeof result !== 'object' ||
				typeof (result as { success?: unknown }).success !== 'boolean'
			) {
				return { ok: false, reason: 'upstream-shape' }
			}

			const verified = result as {
				success: boolean
				action?: unknown
				hostname?: unknown
			}
			if (!verified.success) {
				return { ok: false, reason: 'challenge-failed' }
			}
			if (verified.action !== expectedAction) {
				return { ok: false, reason: 'action-mismatch' }
			}
			if (
				typeof verified.hostname !== 'string' ||
				!allowedHostnames.includes(verified.hostname)
			) {
				return { ok: false, reason: 'hostname-mismatch' }
			}
			return { ok: true }
		} catch {
			if (attempt === 0) continue
			return { ok: false, reason: 'upstream-unavailable' }
		} finally {
			clearTimeout(timer)
		}
	}

	return { ok: false, reason: 'upstream-unavailable' }
}
