/**
 * Display-name helpers for whiteboard People / presence (Phase 6).
 */

/** Full first name + last initial, e.g. "Ada L." — for tight UI / cursor tags. */
export function shortDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!.slice(0, 24)
  const first = parts[0]!.slice(0, 20)
  const lastInitial = parts[parts.length - 1]!.charAt(0).toUpperCase()
  return `${first} ${lastInitial}.`
}

/** Prefer a non-empty label; fall back to a short session-style placeholder. */
export function peopleListLabel(
  displayName: string | null | undefined,
  sessionId: string,
): string {
  const trimmed = displayName?.trim()
  if (trimmed) return trimmed.slice(0, 48)
  // Signed-out / anonymous: keep a short stable session label
  const tail = sessionId.replace(/^TLDRAW_INSTANCE_STATE_V1_/, '').slice(-6)
  return tail ? `Guest ${tail}` : 'Guest'
}
