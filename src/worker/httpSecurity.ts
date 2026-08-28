/** Shared HTTP boundary policy for the whiteboard Worker APIs. */

const ALLOWED_CORS_ORIGINS = new Set([
	'https://scsfoxchase.tech',
	'https://www.scsfoxchase.tech',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
])

/** Same-origin allowlist for privileged HTTP endpoints. */
export function isAllowedOrigin(origin: string): boolean {
	return ALLOWED_CORS_ORIGINS.has(origin.trim())
}

const DEFAULT_CORS_ALLOW_HEADERS =
	'Content-Type, Content-Length, Authorization, X-Board-Host, X-Board-Session, X-Board-Auth, X-Board-Id, X-Whiteboard-Kind'

export type HostProofSource = 'header' | 'authorization' | 'query' | null

export type HostProof = {
	value: string | null
	source: HostProofSource
}

export type CorsOptions = {
	methods?: string
	allowHeaders?: string
	maxAge?: number
}

export const MAX_JSON_BODY_BYTES = 256 * 1024

export class JsonBodyError extends Error {
	readonly status: 400 | 413 | 415

	constructor(status: 400 | 413 | 415, message: string) {
		super(message)
		this.name = 'JsonBodyError'
		this.status = status
	}
}

function looksLikeJwt(raw: string): boolean {
	const parts = raw.trim().split('.')
	return parts.length === 3 && raw.trim().length > 40
}

/** Compare bearer secrets without an early-exit string comparison. */
export function timingSafeEqualText(left: string, right: string): boolean {
	const encoder = new TextEncoder()
	const a = encoder.encode(left)
	const b = encoder.encode(right)
	// Web Crypto's SubtleCrypto does not expose timingSafeEqual in Worker
	// typings. Compare all bytes with an accumulated difference instead of an
	// early-exit string comparison; unequal lengths are folded into the result.
	let difference = a.byteLength ^ b.byteLength
	const length = Math.max(a.byteLength, b.byteLength)
	for (let index = 0; index < length; index += 1) {
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
	}
	return difference === 0
}

export function bearerMatchesSecret(
	request: Request,
	secret: string | undefined,
): boolean {
	const expected = secret?.trim() || ''
	const authorization = request.headers.get('Authorization') || ''
	const token = authorization.toLowerCase().startsWith('bearer ')
		? authorization.slice(7).trim()
		: ''
	return Boolean(expected && token && timingSafeEqualText(token, expected))
}

/**
 * Site + local Astro origins only. Unknown origins intentionally receive no
 * CORS headers; never reflect an arbitrary Origin value.
 */
export function corsHeaders(
	request: Request,
	options: CorsOptions = {},
): HeadersInit {
	const origin = request.headers.get('Origin')?.trim()
	if (!origin || !ALLOWED_CORS_ORIGINS.has(origin)) return {}
	const headers: Record<string, string> = {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': options.methods || 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			options.allowHeaders || DEFAULT_CORS_ALLOW_HEADERS,
		Vary: 'Origin',
	}
	if (options.maxAge !== undefined) {
		headers['Access-Control-Max-Age'] = String(options.maxAge)
	}
	return headers
}

/** Headers common to JSON API responses, including error responses. */
export function jsonHeaders(
	request: Request,
	options: CorsOptions = {},
	extra?: HeadersInit,
): Headers {
	const headers = new Headers({
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...corsHeaders(request, options),
	})
	if (extra) {
		for (const [key, value] of new Headers(extra)) headers.set(key, value)
	}
	return headers
}

export function jsonResponse(
	request: Request,
	status: number,
	body: unknown,
	options: CorsOptions = {},
	extra?: HeadersInit,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: jsonHeaders(request, options, extra),
	})
}

/** Apply API headers to a JSON response returned by a Durable Object. */
export function withJsonHeaders(
	request: Request,
	response: Response,
	options: CorsOptions = {},
): Response {
	const headers = new Headers(response.headers)
	for (const name of [
		'Access-Control-Allow-Origin',
		'Access-Control-Allow-Methods',
		'Access-Control-Allow-Headers',
		'Access-Control-Max-Age',
		'Access-Control-Allow-Credentials',
		'Vary',
	]) {
		headers.delete(name)
	}
	for (const [key, value] of jsonHeaders(request, options)) {
		headers.set(key, value)
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * Read host proof from headers. Query-string proof is accepted only as an
 * explicitly marked compatibility path for historical links.
 */
export function readHostProof(
	request: Request,
	url = new URL(request.url),
	allowLegacyQuery = true,
): HostProof {
	const rawHeader = request.headers.get('X-Board-Host')
	if (rawHeader !== null) {
		const header = rawHeader.trim()
		if (header && !looksLikeJwt(header)) {
			return { value: header, source: 'header' }
		}
		// An explicitly supplied host header, even malformed/empty, must not
		// fall through to a legacy query secret.
		return { value: null, source: 'header' }
	}

	const rawAuthorization = request.headers.get('Authorization')
	if (rawAuthorization !== null) {
		const authorization = rawAuthorization.trim()
		if (authorization.toLowerCase().startsWith('bearer ')) {
			const token = authorization.slice(7).trim()
			if (token && !looksLikeJwt(token)) {
				return { value: token, source: 'authorization' }
			}
		}
		// Authorization is also an explicit proof choice. Do not combine it
		// with a different hostSecret from the URL.
		return { value: null, source: 'authorization' }
	}

	if (allowLegacyQuery) {
		const query = url.searchParams.get('hostSecret')?.trim()
		if (query && !looksLikeJwt(query)) {
			return { value: query, source: 'query' }
		}
	}
	return { value: null, source: null }
}

/**
 * Translate all legacy proof query parameters into headers at the Worker
 * boundary and scrub them before a subrequest is created. No credential is
 * ever needed in an internal Durable Object URL.
 */
export function forwardLegacyProofHeaders(
	request: Request,
	url: URL,
	headers: Headers,
): void {
	const legacyHost = url.searchParams.get('hostSecret')?.trim() || ''
	const hasExplicitHost =
		request.headers.has('X-Board-Host') || headers.has('X-Board-Host')
	const hasExplicitAuthorization =
		request.headers.has('Authorization') || headers.has('Authorization')
	if (legacyHost && !hasExplicitHost && !hasExplicitAuthorization) {
		if (looksLikeJwt(legacyHost)) {
			headers.set('Authorization', `Bearer ${legacyHost}`)
		} else {
			headers.set('X-Board-Host', legacyHost)
		}
	}

	const actorProofs = [
		['actorSessionId', 'X-Board-Session'],
		['actorAuth', 'X-Board-Auth'],
	] as const
	for (const [queryName, headerName] of actorProofs) {
		const value = url.searchParams.get(queryName)?.trim() || ''
		if (
			value &&
			!request.headers.has(headerName) &&
			!headers.has(headerName)
		) {
			headers.set(headerName, value)
		}
	}
	clearProofQuery(url)
}

/** Remove credential-bearing proof parameters from an internal URL. */
export function clearProofQuery(url: URL): void {
	url.searchParams.delete('hostSecret')
	url.searchParams.delete('actorSessionId')
	url.searchParams.delete('actorAuth')
}

/** Read and parse a bounded JSON request body using fatal UTF-8 decoding. */
export async function readBoundedJsonBody(
	request: Request,
	maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
	const contentType = request.headers.get('Content-Type')?.toLowerCase() || ''
	if (!contentType.startsWith('application/json')) {
		throw new JsonBodyError(415, 'Content-Type must be application/json')
	}
	const declaredHeader = request.headers.get('Content-Length')
	if (declaredHeader) {
		const declared = Number(declaredHeader)
		if (!Number.isSafeInteger(declared) || declared < 0) {
			throw new JsonBodyError(400, 'Invalid Content-Length')
		}
		if (declared > maxBytes) {
			throw new JsonBodyError(413, 'Request body too large')
		}
	}

	const reader = request.body?.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		if (reader) {
			while (true) {
				const next = await reader.read()
				if (next.done) break
				total += next.value.byteLength
				if (total > maxBytes) {
					await reader.cancel().catch(() => undefined)
					throw new JsonBodyError(413, 'Request body too large')
				}
				chunks.push(next.value)
			}
		}
	} catch (error) {
		if (error instanceof JsonBodyError) throw error
		throw new JsonBodyError(400, 'Invalid JSON body')
	}

	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw new JsonBodyError(400, 'Invalid JSON body')
	}
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw new JsonBodyError(400, 'Invalid JSON body')
	}
}

/** Copy proof headers to a subrequest without copying its URL credentials. */
export function copyProofHeaders(
	request: Request,
	options: { includeCookie?: boolean } = {},
): Headers {
	const headers = new Headers({ Accept: 'application/json' })
	for (const name of [
		'Authorization',
		'Origin',
		'X-Board-Host',
		'X-Board-Session',
		'X-Board-Auth',
	]) {
		const value = request.headers.get(name)
		if (value) headers.set(name, value)
	}
	if (options.includeCookie) {
		const cookie = request.headers.get('Cookie')
		if (cookie) headers.set('Cookie', cookie)
	}
	return headers
}

export type WhiteboardEvent =
	| 'api_error'
	| 'connect_admission_rejected'
	| 'connect_admission_unavailable'
	| 'connect_auth_accepted'
	| 'connect_auth_timeout'
	| 'connect_accepted'
	| 'connect_pending_cap_rejected'
	| 'connect_rejected'
	| 'connect_socket_cap_rejected'
	| 'connect_viewer_accepted'
	| 'join_throttled'
	| 'kv_read_error'
	| 'maintenance_denied'
	| 'r2_delete_error'
	| 'r2_list_error'
	| 'r2_maintenance_error'
	| 'r2_read_error'
	| 'r2_write_error'
	| 'scene_rejected'
	| 'scene_persist_error'
	| 'temp_expiry_batch'

type LogFields = {
	method?: string
	status?: number
	count?: number
	limit?: number
	source?: HostProofSource
	reason?: 'too_large' | 'malformed'
}

export type StorageFailureBackend = 'd1' | 'r2'
export type StorageFailureOperation = 'query' | 'list' | 'read' | 'import' | 'export'

/** Fixed-shape storage failure telemetry; never include request/data details. */
export function logWhiteboardStorageFailure(
	backend: StorageFailureBackend,
	operation: StorageFailureOperation,
	retryable: boolean,
): void {
	console.warn(JSON.stringify({
		component: 'whiteboard-worker',
		event: 'storage_failure',
		backend,
		operation,
		retryable,
	}))
}

/**
 * Structured, allow-listed observability. Do not pass arbitrary errors,
 * request URLs, identifiers, credentials, or scene data to this function.
 */
export function logWhiteboardEvent(
	event: WhiteboardEvent,
	fields: LogFields = {},
): void {
	const safe: Record<string, string | number> = { event }
	if (
		fields.method &&
		['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(
			fields.method.toUpperCase(),
		)
	) {
		safe.method = fields.method.toUpperCase()
	}
	if (
		fields.status !== undefined &&
		Number.isInteger(fields.status) &&
		fields.status >= 100 &&
		fields.status <= 599
	)
		safe.status = fields.status
	if (
		fields.count !== undefined &&
		Number.isInteger(fields.count) &&
		fields.count >= 0 &&
		fields.count <= 4096
	)
		safe.count = fields.count
	if (
		fields.limit !== undefined &&
		Number.isInteger(fields.limit) &&
		fields.limit >= 0 &&
		fields.limit <= 4096
	)
		safe.limit = fields.limit
	if (fields.source) safe.source = fields.source
	if (fields.reason) safe.reason = fields.reason
	console.warn(JSON.stringify({ component: 'whiteboard-worker', ...safe }))
}
