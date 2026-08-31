import {
	JsonBodyError,
	jsonHeaders,
	jsonResponse,
	readBoundedJsonBody,
} from './httpSecurity'
import {
	verifyTurnstile,
	type TurnstileFailureReason,
} from './turnstile'

const FORM_PATH_RE = /^\/api\/forms\/([^/]+)\/?$/i
const MAX_FORM_BODY_BYTES = 8 * 1_024
const MAX_UPSTREAM_RESPONSE_BYTES = 256 * 1_024
const N8N_TIMEOUT_MS = 12_000
const N8N_AUTH_HEADER = 'X-SCS-Webhook-Key'

type FormConfig = {
	action: string
	upstreamPath: string
}

const FORM_CONFIGS: Readonly<Record<string, FormConfig>> = Object.freeze({
	inventory: {
		action: 'inventory_lookup',
		upstreamPath: 'inventory',
	},
})

const FORM_ORIGINS = new Set([
	'https://scsfoxchase.tech',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
])

type FormDependencies = {
	fetchImpl?: typeof fetch
	siteverifyTimeoutMs?: number
	upstreamTimeoutMs?: number
}

type InventorySubmission = {
	serial: string
	turnstileToken: string
}

type FormEvent =
	| 'configuration_error'
	| 'origin_rejected'
	| 'rate_limited'
	| 'rate_limiter_unavailable'
	| 'turnstile_rejected'
	| 'upstream_error'

function logFormEvent(
	event: FormEvent,
	fields: {
		form?: string
		reason?: TurnstileFailureReason
	} = {},
): void {
	const safe: Record<string, string> = { event }
	if (fields.form && Object.hasOwn(FORM_CONFIGS, fields.form)) {
		safe.form = fields.form
	}
	if (fields.reason) safe.reason = fields.reason
	console.warn(JSON.stringify({ component: 'form-proxy', ...safe }))
}

function allowedTurnstileHostnames(request: Request): readonly string[] {
	const hostname = new URL(request.url).hostname.toLowerCase()
	if (hostname === 'scsfoxchase.tech') return ['scsfoxchase.tech']
	if (hostname === 'localhost' || hostname === '127.0.0.1') return [hostname]
	return []
}

function isAllowedFormOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin')?.trim() || ''
	return FORM_ORIGINS.has(origin)
}

function parseInventorySubmission(value: unknown): InventorySubmission | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	const serial =
		typeof record.serial === 'string' ? record.serial.trim().toUpperCase() : ''
	const turnstileToken =
		typeof record.turnstileToken === 'string' ? record.turnstileToken : ''
	if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(serial)) return null
	if (turnstileToken.length < 1 || turnstileToken.length > 2_048) return null
	return { serial, turnstileToken }
}

function buildN8nUrl(baseValue: string, upstreamPath: string): URL | null {
	try {
		const url = new URL(baseValue)
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname.includes('*')
		) {
			return null
		}
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/${upstreamPath}`
		return url
	} catch {
		return null
	}
}

async function readUpstreamJson(response: Response): Promise<unknown> {
	const contentType = response.headers.get('Content-Type') || ''
	if (!contentType.toLowerCase().includes('application/json')) {
		throw new Error('upstream-content-type')
	}
	const declaredHeader = response.headers.get('Content-Length')
	if (declaredHeader) {
		const declared = Number(declaredHeader)
		if (!Number.isSafeInteger(declared) || declared < 0) {
			throw new Error('upstream-content-length')
		}
		if (declared > MAX_UPSTREAM_RESPONSE_BYTES) {
			throw new Error('upstream-too-large')
		}
	}

	const reader = response.body?.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	if (reader) {
		while (true) {
			const next = await reader.read()
			if (next.done) break
			total += next.value.byteLength
			if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined)
				throw new Error('upstream-too-large')
			}
			chunks.push(next.value)
		}
	}

	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	if (!text.trim()) return { found: false }
	return JSON.parse(text) as unknown
}

async function forwardInventory(
	request: Request,
	env: Env,
	submission: InventorySubmission,
	config: FormConfig,
	dependencies: FormDependencies,
): Promise<Response> {
	const secret = env.N8N_WEBHOOK_SECRET?.trim()
	const upstreamUrl = buildN8nUrl(
		env.N8N_WEBHOOK_BASE_URL || '',
		config.upstreamPath,
	)
	if (!secret || !upstreamUrl) {
		logFormEvent('configuration_error', { form: 'inventory' })
		return jsonResponse(request, 503, { error: 'Form service unavailable' })
	}

	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(),
		dependencies.upstreamTimeoutMs ?? N8N_TIMEOUT_MS,
	)
	try {
		const response = await (dependencies.fetchImpl ?? fetch)(upstreamUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				[N8N_AUTH_HEADER]: secret,
			},
			body: JSON.stringify({ serial: submission.serial }),
			redirect: 'manual',
			signal: controller.signal,
		})
		if (!response.ok) {
			logFormEvent('upstream_error', { form: 'inventory' })
			return jsonResponse(request, 502, { error: 'Form service unavailable' })
		}
		const result = await readUpstreamJson(response)
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: jsonHeaders(request),
		})
	} catch {
		logFormEvent('upstream_error', { form: 'inventory' })
		return jsonResponse(request, 502, { error: 'Form service unavailable' })
	} finally {
		clearTimeout(timer)
	}
}

/** Handle allowlisted public forms before forwarding clean payloads to n8n. */
export async function handleFormRequest(
	request: Request,
	env: Env,
	dependencies: FormDependencies = {},
): Promise<Response | null> {
	const url = new URL(request.url)
	const match = url.pathname.match(FORM_PATH_RE)
	if (!match) return null

	const formId = (match[1] || '').toLowerCase()
	const config = FORM_CONFIGS[formId]
	if (!config) {
		return jsonResponse(request, 404, { error: 'Form not found' }, {
			methods: 'POST, OPTIONS',
		})
	}
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: jsonHeaders(request, {
				methods: 'POST, OPTIONS',
				maxAge: 86400,
			}),
		})
	}
	if (request.method !== 'POST') {
		return jsonResponse(request, 405, { error: 'Method not allowed' }, {
			methods: 'POST, OPTIONS',
		})
	}
	if (!isAllowedFormOrigin(request)) {
		logFormEvent('origin_rejected', { form: formId })
		return jsonResponse(request, 403, { error: 'Request rejected' })
	}
	if (!env.TURNSTILE_SECRET || !env.FORM_SUBMISSION_LIMITER) {
		logFormEvent('configuration_error', { form: formId })
		return jsonResponse(request, 503, { error: 'Form service unavailable' })
	}

	const clientIp = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown'
	try {
		const admission = await env.FORM_SUBMISSION_LIMITER.limit({
			key: `${formId}:${clientIp}`,
		})
		if (!admission.success) {
			logFormEvent('rate_limited', { form: formId })
			return jsonResponse(
				request,
				429,
				{ error: 'Too many submissions. Wait a minute and try again.' },
				{},
				{ 'Retry-After': '60' },
			)
		}
	} catch {
		logFormEvent('rate_limiter_unavailable', { form: formId })
		return jsonResponse(request, 503, { error: 'Form service unavailable' })
	}

	let body: unknown
	try {
		body = await readBoundedJsonBody(request, MAX_FORM_BODY_BYTES)
	} catch (error) {
		if (error instanceof JsonBodyError) {
			return jsonResponse(request, error.status, { error: error.message })
		}
		return jsonResponse(request, 400, { error: 'Invalid JSON body' })
	}

	if (formId !== 'inventory') {
		return jsonResponse(request, 404, { error: 'Form not found' })
	}
	const submission = parseInventorySubmission(body)
	if (!submission) {
		return jsonResponse(request, 400, { error: 'Invalid inventory lookup' })
	}

	const verdict = await verifyTurnstile(
		{
			token: submission.turnstileToken,
			remoteIp: request.headers.get('CF-Connecting-IP')?.trim() || undefined,
			expectedAction: config.action,
			allowedHostnames: allowedTurnstileHostnames(request),
			secret: env.TURNSTILE_SECRET,
		},
		{
			fetchImpl: dependencies.fetchImpl,
			timeoutMs: dependencies.siteverifyTimeoutMs,
		},
	)
	if (!verdict.ok) {
		logFormEvent('turnstile_rejected', {
			form: formId,
			reason: verdict.reason,
		})
		return jsonResponse(request, 403, {
			error: 'Security verification failed. Refresh and try again.',
		})
	}

	return forwardInventory(request, env, submission, config, dependencies)
}
