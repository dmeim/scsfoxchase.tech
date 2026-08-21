/**
 * Share-code helpers shared by Worker join lookup and WhiteboardBoard DO.
 * Format: four characters, digit-letter twice (`1A2B`), TTL 12h.
 * Join is rate-limited (per IP + per code) to offset the short code space.
 * Treat live codes as secrets (do not project them where a hallway can see).
 */

export const SHARE_CODE_TTL_SECONDS = 12 * 60 * 60
export const SHARE_CODE_TTL_MS = SHARE_CODE_TTL_SECONDS * 1000

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const SHARE_CODE_PAIRS = 2

/** Digit-letter repeated twice (four characters, `1A2B`). */
export const SHARE_CODE_RE = /^([0-9][A-Z]){2}$/

export type ShareCodeRecord = {
	boardId: string
	exp: string
}

export function normalizeShareCode(raw: string): string | null {
	const code = raw.trim().toUpperCase()
	return SHARE_CODE_RE.test(code) ? code : null
}

export function kvCodeKey(code: string): string {
	return `code:${code}`
}

/** Sample an unused `1A2B`-form code; caller retries on collision. */
export function sampleShareCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SHARE_CODE_PAIRS * 2))
	let code = ''
	for (let i = 0; i < SHARE_CODE_PAIRS; i++) {
		code += DIGITS[bytes[i * 2]! % 10]!
		code += LETTERS[bytes[i * 2 + 1]! % 26]!
	}
	return code
}

export function parseShareCodeRecord(raw: string | null): ShareCodeRecord | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<ShareCodeRecord>
		if (
			typeof parsed.boardId !== 'string' ||
			typeof parsed.exp !== 'string' ||
			!parsed.boardId ||
			!parsed.exp
		) {
			return null
		}
		return { boardId: parsed.boardId, exp: parsed.exp }
	} catch {
		return null
	}
}

export function isExpiredIso(exp: string, now = Date.now()): boolean {
	const t = Date.parse(exp)
	return Number.isNaN(t) || t <= now
}
