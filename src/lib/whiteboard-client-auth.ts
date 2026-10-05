/** Bind cached/asynchronous JWTs to the current Clerk account, not their fetch time.
 * This is only a stale-token guard; the server still verifies the JWT signature.
 */
export function sessionTokenMatchesIdentity(token: string, clerkUserId?: string): boolean {
  if (!clerkUserId) return false;
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized));
    return decoded.sub === clerkUserId;
  } catch {
    return false;
  }
}
