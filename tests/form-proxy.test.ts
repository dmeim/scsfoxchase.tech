import { describe, expect, it, vi } from 'vitest'
import { handleFormRequest } from '../src/worker/formRoutes'
import { verifyTurnstile } from '../src/worker/turnstile'

const ORIGIN = 'https://scsfoxchase.tech'
const FORM_URL = `${ORIGIN}/api/forms/inventory`
const SITEVERIFY_URL =
	'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TEST_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA'

function formRequest(
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(FORM_URL, {
		method: 'POST',
		headers: {
			Origin: ORIGIN,
			'CF-Connecting-IP': '203.0.113.10',
			'Content-Type': 'application/json',
			...headers,
		},
		body: JSON.stringify(body),
	})
}

function formEnv(limiterSuccess = true): {
	env: Env
	limit: ReturnType<typeof vi.fn>
} {
	const limit = vi.fn(async () => ({ success: limiterSuccess }))
	return {
		env: {
			TURNSTILE_SECRET: TEST_TURNSTILE_SECRET,
			N8N_WEBHOOK_BASE_URL: 'https://n8n.mlabz.io/webhook/scs',
			N8N_WEBHOOK_SECRET: 'test-n8n-secret',
			FORM_SUBMISSION_LIMITER: { limit },
		} as unknown as Env,
		limit,
	}
}

function successfulFetch(): {
	fetchImpl: typeof fetch
	calls: Array<{ url: string; init?: RequestInit }>
} {
	const calls: Array<{ url: string; init?: RequestInit }> = []
	const fetchImpl = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = String(input)
		calls.push({ url, init })
		if (url === SITEVERIFY_URL) {
			return Response.json({
				success: true,
				hostname: 'scsfoxchase.tech',
				action: 'inventory_lookup',
			})
		}
		if (url === 'https://n8n.mlabz.io/webhook/scs/inventory') {
			return Response.json({ found: true, asset: { Serial: 'ABC123' } })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch
	return { fetchImpl, calls }
}

describe('public form proxy', () => {
	it('verifies Turnstile and forwards only the clean inventory payload', async () => {
		const { env, limit } = formEnv()
		const { fetchImpl, calls } = successfulFetch()
		const response = await handleFormRequest(
			formRequest({
				serial: 'abc123',
				turnstileToken: 'fresh-test-token',
				ignored: 'not forwarded',
			}),
			env,
			{ fetchImpl },
		)

		expect(response?.status).toBe(200)
		expect(await response?.json()).toEqual({
			found: true,
			asset: { Serial: 'ABC123' },
		})
		expect(limit).toHaveBeenCalledWith({
			key: 'inventory:203.0.113.10',
		})
		expect(calls.map((call) => call.url)).toEqual([
			SITEVERIFY_URL,
			'https://n8n.mlabz.io/webhook/scs/inventory',
		])
		const upstream = calls[1]!
		expect(new Headers(upstream.init?.headers).get('X-SCS-Webhook-Key')).toBe(
			'test-n8n-secret',
		)
		expect(upstream.init?.redirect).toBe('manual')
		expect(JSON.parse(String(upstream.init?.body))).toEqual({ serial: 'ABC123' })
	})

	it('rejects malformed submissions before Turnstile or n8n', async () => {
		const { env } = formEnv()
		const fetchImpl = vi.fn() as unknown as typeof fetch
		const response = await handleFormRequest(
			formRequest({ serial: '../bad', turnstileToken: '' }),
			env,
			{ fetchImpl },
		)

		expect(response?.status).toBe(400)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('rate limits before parsing or calling external services', async () => {
		const { env } = formEnv(false)
		const fetchImpl = vi.fn() as unknown as typeof fetch
		const response = await handleFormRequest(
			formRequest({ serial: 'ABC123', turnstileToken: 'fresh-test-token' }),
			env,
			{ fetchImpl },
		)

		expect(response?.status).toBe(429)
		expect(response?.headers.get('Retry-After')).toBe('60')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it.each([
		['wrong action', { success: true, hostname: 'scsfoxchase.tech', action: 'game_request' }],
		['wrong hostname', { success: true, hostname: 'evil.example', action: 'inventory_lookup' }],
		['spent token', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
	])('fails closed for %s', async (_label, siteverifyResult) => {
		const { env } = formEnv()
		const fetchImpl = vi.fn(async () => Response.json(siteverifyResult)) as unknown as typeof fetch
		const response = await handleFormRequest(
			formRequest({ serial: 'ABC123', turnstileToken: 'test-token' }),
			env,
			{ fetchImpl },
		)

		expect(response?.status).toBe(403)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('rejects unknown routes instead of becoming an open proxy', async () => {
		const { env } = formEnv()
		const response = await handleFormRequest(
			new Request(`${ORIGIN}/api/forms/arbitrary-upstream`, {
				method: 'POST',
				headers: { Origin: ORIGIN },
			}),
			env,
		)

		expect(response?.status).toBe(404)
	})
})

describe('Turnstile verification contract', () => {
	it('retries a transient response once with the same idempotency key', async () => {
		const bodies: URLSearchParams[] = []
		let attempt = 0
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(new URLSearchParams(String(init?.body)))
			attempt += 1
			if (attempt === 1) return new Response('unavailable', { status: 503 })
			return Response.json({
				success: true,
				hostname: 'scsfoxchase.tech',
				action: 'inventory_lookup',
			})
		}) as unknown as typeof fetch

		const verdict = await verifyTurnstile(
			{
				token: 'fresh-token',
				expectedAction: 'inventory_lookup',
				allowedHostnames: ['scsfoxchase.tech'],
				secret: TEST_TURNSTILE_SECRET,
			},
			{ fetchImpl },
		)

		expect(verdict).toEqual({ ok: true })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(bodies[0]?.get('idempotency_key')).toBe(
			bodies[1]?.get('idempotency_key'),
		)
	})

	it('fails closed after two bounded timeouts', async () => {
		const fetchImpl = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					)
				}),
		) as unknown as typeof fetch

		const verdict = await verifyTurnstile(
			{
				token: 'fresh-token',
				expectedAction: 'inventory_lookup',
				allowedHostnames: ['scsfoxchase.tech'],
				secret: TEST_TURNSTILE_SECRET,
			},
			{ fetchImpl, timeoutMs: 5 },
		)

		expect(verdict).toEqual({ ok: false, reason: 'upstream-unavailable' })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it.each([
		['non-JSON response', new Response('ok', { status: 200 })],
		[
			'malformed JSON response',
			new Response('{', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		],
	])('fails closed for a %s', async (_label, siteverifyResponse) => {
		const fetchImpl = vi.fn(async () => siteverifyResponse.clone()) as unknown as typeof fetch
		const verdict = await verifyTurnstile(
			{
				token: 'fresh-token',
				expectedAction: 'inventory_lookup',
				allowedHostnames: ['scsfoxchase.tech'],
				secret: TEST_TURNSTILE_SECRET,
			},
			{ fetchImpl },
		)

		expect(verdict.ok).toBe(false)
	})
})
