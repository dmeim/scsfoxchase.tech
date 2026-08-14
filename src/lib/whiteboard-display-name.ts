/**
 * Display-name helpers for whiteboard People / follow (Phase 3.3).
 * Guest names are generated and stick to this browser's deviceInstallId.
 */

const GUEST_NAME_KEY = 'scsfoxchase.whiteboard.guestDisplayName'

const GUEST_ADJECTIVES = [
	'Amber',
	'Brave',
	'Calm',
	'Clever',
	'Coral',
	'Eager',
	'Gentle',
	'Happy',
	'Kind',
	'Lucky',
	'Merry',
	'Noble',
	'Quiet',
	'Sunny',
	'Swift',
	'Warm',
] as const

const GUEST_ANIMALS = [
	'Badger',
	'Cardinal',
	'Dove',
	'Finch',
	'Fox',
	'Heron',
	'Lark',
	'Otter',
	'Owl',
	'Panda',
	'Robin',
	'Seal',
	'Sparrow',
	'Swan',
	'Wren',
	'Deer',
] as const

function hashSeed(seed: string): number {
	let hash = 2166136261
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

/** Deterministic school-safe name from a stable id (deviceInstallId / userId). */
export function generateGuestDisplayName(seed: string): string {
	const hash = hashSeed(seed || 'guest')
	const adjective = GUEST_ADJECTIVES[hash % GUEST_ADJECTIVES.length]!
	const animal =
		GUEST_ANIMALS[Math.floor(hash / GUEST_ADJECTIVES.length) % GUEST_ANIMALS.length]!
	return `${adjective} ${animal}`
}

/** Full first name + last initial, e.g. "Ada L." — for tight UI / cursor tags. */
export function shortDisplayName(fullName: string): string {
	const parts = fullName.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return ''
	if (parts.length === 1) return parts[0]!.slice(0, 24)
	const first = parts[0]!.slice(0, 20)
	const lastInitial = parts[parts.length - 1]!.charAt(0).toUpperCase()
	return `${first} ${lastInitial}.`
}

/** Prefer a non-empty label; fall back to a generated guest name from session id. */
export function peopleListLabel(
	displayName: string | null | undefined,
	sessionId: string,
): string {
	const trimmed = displayName?.trim()
	if (trimmed) return trimmed.slice(0, 48)
	return generateGuestDisplayName(sessionId)
}

/**
 * Guest identity sticks on this browser. New browser = new guest.
 * Signed-in callers should pass the Google display name instead.
 */
export function getOrCreateGuestDisplayName(deviceInstallId: string): string {
	try {
		const existing = localStorage.getItem(GUEST_NAME_KEY)?.trim()
		if (existing) return existing.slice(0, 48)
	} catch {
		// private mode
	}
	const name = generateGuestDisplayName(deviceInstallId)
	try {
		localStorage.setItem(GUEST_NAME_KEY, name)
	} catch {
		// still return the generated name for this session
	}
	return name
}
