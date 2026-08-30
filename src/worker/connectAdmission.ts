import { jsonResponse, logWhiteboardEvent } from './httpSecurity'

/** The session id is a browser reconnect handle, not an arbitrary identifier. */
export const MAX_CONNECT_SESSION_ID_LENGTH = 64
const SESSION_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Three full 64-seat boards can reconnect three times behind one school NAT. */
export const CONNECT_RATE_LIMIT = 600
/** One full board can reconnect three times with practical burst headroom. */
export const BOARD_CONNECT_RATE_LIMIT = 240
export const CONNECT_RATE_PERIOD_SECONDS = 60

/** Local/test fallback is deliberately bounded and expires idle buckets. */
export const LOCAL_CONNECT_BUCKET_MAX = 4096
export const LOCAL_CONNECT_WINDOW_MS = CONNECT_RATE_PERIOD_SECONDS * 1000

type LocalBucket = {
	count: number
	expiresAt: number
	lastSeenAt: number
}

const localBuckets = new Map<string, LocalBucket>()

export type ConnectAdmissionEnv = {
	WHITEBOARD_CONNECT_LIMITER?: Pick<RateLimit, 'limit'>
	WHITEBOARD_BOARD_CONNECT_LIMITER?: Pick<RateLimit, 'limit'>
}

export function isValidConnectSessionId(value: string | null): value is string {
	return Boolean(
		value &&
		value.length <= MAX_CONNECT_SESSION_ID_LENGTH &&
		SESSION_ID_RE.test(value),
	)
}

/**
 * Cloudflare sets CF-Connecting-IP at the edge. Never fall back to a client
 * supplied forwarding header, board id, URL, or session id for the limiter key.
 * A fixed local label keeps local/test fallback bounded when no edge IP exists.
 */
export function trustedConnectRateLimitKey(request: Request): string {
	const ip = request.headers.get('CF-Connecting-IP')?.trim() ?? ''
	return ip.length > 0 && ip.length <= 128 ? ip : 'local'
}

/**
 * The board UUID is already validated by the Worker route. Canonicalizing its
 * case keeps alternate UUID spelling from creating a fresh board bucket.
 */
export function trustedBoardConnectRateLimitKey(
	request: Request,
	boardId: string,
): string {
	return `${boardId.toLowerCase()}:${trustedConnectRateLimitKey(request)}`
}

function pruneLocalBuckets(now: number): void {
	for (const [key, bucket] of localBuckets) {
		if (bucket.expiresAt <= now) localBuckets.delete(key)
	}
	if (localBuckets.size <= LOCAL_CONNECT_BUCKET_MAX) return
	const oldest = [...localBuckets.entries()]
		.sort(([, left], [, right]) => left.lastSeenAt - right.lastSeenAt)
		.slice(0, localBuckets.size - LOCAL_CONNECT_BUCKET_MAX)
	for (const [key] of oldest) localBuckets.delete(key)
}

function evictOldestLocalBucket(): void {
	let oldestKey: string | null = null
	let oldestSeen = Number.POSITIVE_INFINITY
	for (const [key, bucket] of localBuckets) {
		if (bucket.lastSeenAt < oldestSeen) {
			oldestSeen = bucket.lastSeenAt
			oldestKey = key
		}
	}
	if (oldestKey !== null) localBuckets.delete(oldestKey)
}

export function consumeLocalConnectAdmission(
	key: string,
	now = Date.now(),
	limit = CONNECT_RATE_LIMIT,
): { allowed: boolean; retryAfterSeconds: number } {
	const safeKey = key.length <= 128 ? key : key.slice(0, 128)
	pruneLocalBuckets(now)
	let bucket = localBuckets.get(safeKey)
	if (!bucket || bucket.expiresAt <= now) {
		if (!bucket && localBuckets.size >= LOCAL_CONNECT_BUCKET_MAX) {
			evictOldestLocalBucket()
		}
		bucket = {
			count: 0,
			expiresAt: now + LOCAL_CONNECT_WINDOW_MS,
			lastSeenAt: now,
		}
		localBuckets.set(safeKey, bucket)
	}
	bucket.lastSeenAt = now
	if (bucket.count >= limit) {
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
		}
	}
	bucket.count += 1
	return { allowed: true, retryAfterSeconds: 0 }
}

/** Test-only visibility for the bounded fallback; no keys are exposed. */
export function localConnectAdmissionSize(): number {
	return localBuckets.size
}

export function resetLocalConnectAdmissionForTests(): void {
	localBuckets.clear()
}

function rejectedResponse(request: Request, retryAfterSeconds: number): Response {
	return jsonResponse(
		request,
		429,
		{ error: 'Too many WebSocket connections. Try again shortly.' },
		{ methods: 'GET, OPTIONS' },
		{ 'Retry-After': String(retryAfterSeconds) },
	)
}

/**
 * Admission runs before the Worker resolves a Durable Object stub. The
 * platform binding is authoritative in deployed environments; the bounded
 * fallback exists for local/test configurations that cannot bind Rate Limit.
 */
export async function admitWhiteboardConnect(
	request: Request,
	env: ConnectAdmissionEnv,
	boardId: string,
): Promise<Response | null> {
	const ipKey = trustedConnectRateLimitKey(request)
	const boardKey = trustedBoardConnectRateLimitKey(request, boardId)
	const ipLimiter = env.WHITEBOARD_CONNECT_LIMITER
	const boardLimiter = env.WHITEBOARD_BOARD_CONNECT_LIMITER
	if (ipLimiter || boardLimiter) {
		if (!ipLimiter || !boardLimiter) {
			logWhiteboardEvent('connect_admission_unavailable')
			return jsonResponse(
				request,
				503,
				{ error: 'WebSocket connections are temporarily unavailable.' },
				{ methods: 'GET, OPTIONS' },
			)
		}
		try {
			const ipOutcome = await ipLimiter.limit({ key: ipKey })
			if (!ipOutcome.success) {
				logWhiteboardEvent('connect_admission_rejected', {
					limit: CONNECT_RATE_LIMIT,
				})
				return rejectedResponse(request, CONNECT_RATE_PERIOD_SECONDS)
			}
			const boardOutcome = await boardLimiter.limit({ key: boardKey })
			if (!boardOutcome.success) {
				logWhiteboardEvent('connect_admission_rejected', {
					limit: BOARD_CONNECT_RATE_LIMIT,
				})
				return rejectedResponse(request, CONNECT_RATE_PERIOD_SECONDS)
			}
			return null
		} catch {
			// Do not silently turn a production binding failure into an open gate.
			logWhiteboardEvent('connect_admission_unavailable')
			return jsonResponse(
				request,
				503,
				{ error: 'WebSocket connections are temporarily unavailable.' },
				{ methods: 'GET, OPTIONS' },
			)
		}
	}

	const now = Date.now()
	const ipOutcome = consumeLocalConnectAdmission(
		`ip:${ipKey}`,
		now,
		CONNECT_RATE_LIMIT,
	)
	if (!ipOutcome.allowed) {
		logWhiteboardEvent('connect_admission_rejected', {
			limit: CONNECT_RATE_LIMIT,
		})
		return rejectedResponse(request, ipOutcome.retryAfterSeconds)
	}
	const boardOutcome = consumeLocalConnectAdmission(
		`board:${boardKey}`,
		now,
		BOARD_CONNECT_RATE_LIMIT,
	)
	if (!boardOutcome.allowed) {
		logWhiteboardEvent('connect_admission_rejected', {
			limit: BOARD_CONNECT_RATE_LIMIT,
		})
		return rejectedResponse(request, boardOutcome.retryAfterSeconds)
	}
	return null
}
