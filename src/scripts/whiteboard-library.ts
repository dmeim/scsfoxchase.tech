/**
 * Whiteboard identity helpers + signed-in cloud library (Phase 3.1).
 *
 * Recents / Library live in R2 via Clerk. There is no localStorage board
 * index. Signed-out create is a scratch Durable Object (host secret only);
 * Save / claim (signed in + creating-browser secret) writes the cloud index
 * and PATCHes board meta to lift the 24h TTL.
 */
import {
  deleteCloudBoard,
  fetchCloudBoards,
  markBoardSavedToLibrary,
  upsertCloudBoard,
} from '../lib/whiteboard-cloud';
import { getActiveIdentity, isSignedIn, onAuthChange, whenAuthReady } from '../lib/whiteboard-identity';

/** @deprecated Phase 3.1 — local board library removed; key is cleared on load. */
export const LIBRARY_KEY = 'scsfoxchase.whiteboard.library';
export const HOST_SECRET_PREFIX = 'scsfoxchase.whiteboard.host.';
export const DEVICE_INSTALL_ID_KEY = 'scsfoxchase.whiteboard.deviceInstallId';

const SCRATCH_TITLE_PREFIX = 'scsfoxchase.whiteboard.scratchTitle.';

export type WhiteboardLibraryEntry = {
  id: string;
  title: string;
  lastAccessedAt: string;
  previewDataUrl?: string;
};

if (typeof localStorage !== 'undefined') {
  try {
    localStorage.removeItem(LIBRARY_KEY);
  } catch {
    // private mode / blocked storage
  }
}

/**
 * Stable per-browser UUID for signed-out owner keys (`local:{deviceInstallId}`).
 * Minted on first visit; clearing site data creates a new namespace.
 * Phase 3.2 still uses this for temp R2 objects; it is not a board library.
 */
export function getDeviceInstallId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_INSTALL_ID_KEY);
    if (existing && UUID_RE.test(existing)) return existing;
  } catch {
    // private mode / blocked storage
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(DEVICE_INSTALL_ID_KEY, id);
  } catch {
    // still return an id for this session so uploads can proceed
  }
  return id;
}

/**
 * Active owner key for R2 assets / library membership.
 * Signed out: `local:{deviceInstallId}` (scratch media until 3.2 claim).
 * Signed in: `google:{accountId}` from Clerk (Google `sub` preferred).
 */
export function getOwnerKey(): string {
  const identity = getActiveIdentity();
  if (identity) return identity.ownerKey;
  return `local:${getDeviceInstallId()}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_CODE_RE = /^[A-Za-z][0-9][A-Za-z][0-9]$/;

export function isBoardUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function isShareCode(value: string): boolean {
  return SHARE_CODE_RE.test(value.trim());
}

export function hostSecretKey(boardId: string): string {
  return `${HOST_SECRET_PREFIX}${boardId}`;
}

function rememberScratchTitle(boardId: string, title: string): void {
  try {
    sessionStorage.setItem(`${SCRATCH_TITLE_PREFIX}${boardId}`, title);
  } catch {
    // private mode
  }
}

function readScratchTitle(boardId: string): string | null {
  try {
    return sessionStorage.getItem(`${SCRATCH_TITLE_PREFIX}${boardId}`);
  } catch {
    return null;
  }
}

function untitledEntry(
  boardId: string,
  title?: string,
): WhiteboardLibraryEntry {
  return {
    id: boardId,
    title: title || readScratchTitle(boardId) || 'Untitled board',
    lastAccessedAt: new Date().toISOString(),
  };
}

/** Local board library is gone. Kept so older imports do not write localStorage. */
export function readLibrary(): WhiteboardLibraryEntry[] {
  return [];
}

export function writeLibrary(_entries: WhiteboardLibraryEntry[]): void {
  try {
    localStorage.removeItem(LIBRARY_KEY);
  } catch {
    // ignore
  }
}

export function getEntry(_boardId: string): WhiteboardLibraryEntry | undefined {
  return undefined;
}

export function upsertEntry(
  patch: Pick<WhiteboardLibraryEntry, 'id'> &
    Partial<Omit<WhiteboardLibraryEntry, 'id'>>,
): WhiteboardLibraryEntry {
  return untitledEntry(patch.id, patch.title);
}

export function touchBoard(boardId: string, title?: string): WhiteboardLibraryEntry {
  return untitledEntry(boardId, title);
}

export function setBoardTitle(boardId: string, title: string): WhiteboardLibraryEntry {
  const cleaned = title.trim() || 'Untitled board';
  rememberScratchTitle(boardId, cleaned);
  return untitledEntry(boardId, cleaned);
}

/** Default create title: `YYYY-MM-DD_HH-MM-SS` (24-hour local time). */
export function defaultBoardTitle(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`;
}

function persistHostSecret(boardId: string, hostSecret: string): void {
  try {
    localStorage.setItem(hostSecretKey(boardId), hostSecret);
  } catch {
    // private mode — ephemeral Owner on this device may be unavailable
  }
}

/** Scratch create: UUID + host secret only. Does not write a library index. */
export function createBoard(title = defaultBoardTitle()): {
  id: string;
  hostSecret: string;
  entry: WhiteboardLibraryEntry;
} {
  const id = crypto.randomUUID();
  const hostSecret = createHostSecret();
  persistHostSecret(id, hostSecret);
  rememberScratchTitle(id, title);
  return { id, hostSecret, entry: untitledEntry(id, title) };
}

/** Drop host secret for this board. Does not delete the Durable Object. */
export function removeBoard(boardId: string): void {
  try {
    localStorage.removeItem(hostSecretKey(boardId));
  } catch {
    // ignore quota / private-mode failures
  }
}

function createHostSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getHostSecret(boardId: string): string | null {
  try {
    return localStorage.getItem(hostSecretKey(boardId));
  } catch {
    return null;
  }
}

export function getRecents(_limit = 8): WhiteboardLibraryEntry[] {
  return [];
}

export function getLibrarySorted(): WhiteboardLibraryEntry[] {
  return [];
}

function sortByAccessed(entries: WhiteboardLibraryEntry[]): WhiteboardLibraryEntry[] {
  return [...entries].sort(
    (a, b) =>
      new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
  );
}

function scheduleSavedToLibrary(
  boardId: string,
  hostSecret: string | null,
): void {
  if (!isSignedIn() || !hostSecret) return;
  const ownerKey = getOwnerKey();
  void markBoardSavedToLibrary(boardId, ownerKey, hostSecret).catch(() => {
    // First WebSocket connect stores the host hash; later touch/Save retries.
  });
}

/**
 * Signed-in Save / claim: upsert cloud library (Owner = Google) and lift 24h TTL.
 * Requires the creating-browser host secret for the Durable Object PATCH.
 */
export async function claimBoardToLibrary(
  boardId: string,
  title?: string,
): Promise<WhiteboardLibraryEntry> {
  if (!isSignedIn()) {
    throw new Error('Sign in with Google to save this board to your library.');
  }
  const hostSecret = getHostSecret(boardId);
  if (!hostSecret) {
    throw new Error(
      'Only the browser that created this scratch board can save it to your library.',
    );
  }
  const existing = await getEntryActive(boardId);
  const now = new Date().toISOString();
  const next: WhiteboardLibraryEntry = {
    id: boardId,
    title: title ?? existing?.title ?? readScratchTitle(boardId) ?? 'Untitled board',
    lastAccessedAt: now,
    previewDataUrl: existing?.previewDataUrl,
  };
  const saved = await upsertCloudBoard(next, { hostSecret });
  try {
    await markBoardSavedToLibrary(boardId, getOwnerKey(), hostSecret);
  } catch {
    scheduleSavedToLibrary(boardId, hostSecret);
  }
  return saved;
}

export async function listBoardsActive(): Promise<WhiteboardLibraryEntry[]> {
  if (!isSignedIn()) return [];
  return sortByAccessed(await fetchCloudBoards());
}

export async function getRecentsActive(limit = 8): Promise<WhiteboardLibraryEntry[]> {
  return (await listBoardsActive()).slice(0, limit);
}

export async function getEntryActive(
  boardId: string,
): Promise<WhiteboardLibraryEntry | undefined> {
  if (!isSignedIn()) return undefined;
  const boards = await fetchCloudBoards();
  return boards.find((entry) => entry.id === boardId);
}

export async function upsertEntryActive(
  patch: Pick<WhiteboardLibraryEntry, 'id'> &
    Partial<Omit<WhiteboardLibraryEntry, 'id'>>,
): Promise<WhiteboardLibraryEntry> {
  if (!isSignedIn()) {
    if (patch.title) rememberScratchTitle(patch.id, patch.title);
    return untitledEntry(patch.id, patch.title);
  }
  const existing = await getEntryActive(patch.id);
  const hostSecret = getHostSecret(patch.id);
  if (!existing && !hostSecret) {
    throw new Error('Join does not add a board to your library. Save a board you created, or create a new one.');
  }
  const now = new Date().toISOString();
  const next: WhiteboardLibraryEntry = {
    id: patch.id,
    title: patch.title ?? existing?.title ?? 'Untitled board',
    lastAccessedAt: patch.lastAccessedAt ?? now,
    previewDataUrl:
      patch.previewDataUrl !== undefined
        ? patch.previewDataUrl
        : existing?.previewDataUrl,
  };
  const saved = await upsertCloudBoard(next, { hostSecret });
  scheduleSavedToLibrary(patch.id, hostSecret);
  return saved;
}

/**
 * Update last-accessed for a board already in the signed-in library, or claim
 * a scratch board this browser created. Join (no host secret, not in library)
 * does not write Recents.
 */
export async function touchBoardActive(
  boardId: string,
  title?: string,
): Promise<WhiteboardLibraryEntry> {
  if (!isSignedIn()) {
    return untitledEntry(boardId, title);
  }
  const existing = await getEntryActive(boardId);
  const hostSecret = getHostSecret(boardId);
  if (existing) {
    const next = await upsertCloudBoard(
      {
        ...existing,
        title: title ?? existing.title,
        lastAccessedAt: new Date().toISOString(),
      },
      { hostSecret },
    );
    scheduleSavedToLibrary(boardId, hostSecret);
    return next;
  }
  if (hostSecret) {
    return claimBoardToLibrary(boardId, title);
  }
  return untitledEntry(boardId, title);
}

export async function setBoardTitleActive(
  boardId: string,
  title: string,
): Promise<WhiteboardLibraryEntry> {
  const cleaned = title.trim() || 'Untitled board';
  if (!isSignedIn()) {
    rememberScratchTitle(boardId, cleaned);
    return untitledEntry(boardId, cleaned);
  }
  const existing = await getEntryActive(boardId);
  const hostSecret = getHostSecret(boardId);
  if (!existing && hostSecret) {
    return claimBoardToLibrary(boardId, cleaned);
  }
  if (!existing) {
    throw new Error('Sign in as the owner and Save to keep this board in your library.');
  }
  return upsertEntryActive({
    id: boardId,
    title: cleaned,
    lastAccessedAt: new Date().toISOString(),
  });
}

export async function createBoardActive(title = defaultBoardTitle()): Promise<{
  id: string;
  hostSecret: string;
  entry: WhiteboardLibraryEntry;
}> {
  const id = crypto.randomUUID();
  const hostSecret = createHostSecret();
  persistHostSecret(id, hostSecret);
  rememberScratchTitle(id, title);
  const now = new Date().toISOString();
  const draft: WhiteboardLibraryEntry = {
    id,
    title,
    lastAccessedAt: now,
  };
  if (!isSignedIn()) {
    return { id, hostSecret, entry: draft };
  }
  const entry = await upsertCloudBoard(draft, { hostSecret });
  scheduleSavedToLibrary(id, hostSecret);
  return { id, hostSecret, entry };
}

/** Remove from the signed-in cloud library. No-op when signed out. */
export async function removeBoardActive(boardId: string): Promise<void> {
  if (isSignedIn()) {
    await deleteCloudBoard(boardId);
    return;
  }
  removeBoard(boardId);
}

/**
 * Accepts board URL, `/board/{uuid}` path, bare UUID, or share code.
 * Returns `{ kind: 'board', id }` or `{ kind: 'code', code }` or null.
 */
export function parseJoinInput(
  raw: string,
): { kind: 'board'; id: string } | { kind: 'code'; code: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, window.location.origin);
    const fromPath = url.pathname.match(/\/board\/([^/]+)\/?$/i);
    if (fromPath?.[1] && isBoardUuid(decodeURIComponent(fromPath[1]))) {
      return { kind: 'board', id: decodeURIComponent(fromPath[1]) };
    }
  } catch {
    // not a URL
  }

  const pathOnly = trimmed.match(/\/board\/([^/?#]+)\/?/i);
  if (pathOnly?.[1] && isBoardUuid(decodeURIComponent(pathOnly[1]))) {
    return { kind: 'board', id: decodeURIComponent(pathOnly[1]) };
  }

  if (isBoardUuid(trimmed)) {
    return { kind: 'board', id: trimmed };
  }

  if (isShareCode(trimmed)) {
    return { kind: 'code', code: trimmed.toUpperCase() };
  }

  return null;
}

export function readBoardIdFromPath(pathname = window.location.pathname): string | null {
  const match = pathname.match(/\/board\/([^/]+)\/?$/i);
  if (!match?.[1]) return null;
  const id = decodeURIComponent(match[1]);
  return isBoardUuid(id) ? id : null;
}

/** e.g. `Jul 17, 2026 - 07:29:24 AM` */
export function formatAccessedDate(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const month = date.toLocaleString('en-US', { month: 'short' });
    const day = date.getDate();
    const year = date.getFullYear();
    let hours = date.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    const hh = String(hours).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    // NBSP keeps AM/PM attached to the time if the line ever wraps
    return `${month} ${day}, ${year} - ${hh}:${mm}:${ss}\u00A0${ampm}`;
  } catch {
    return '';
  }
}

/**
 * Board-page hook: if this browser created a scratch board and the user signs
 * in, claim Owner + cloud library without waiting on Phase 3.3 People UI.
 */
function bindBoardPageScratchClaim(): void {
  if (typeof window === 'undefined') return;
  const boardId = readBoardIdFromPath();
  if (!boardId) return;
  const tryClaim = () => {
    if (!isSignedIn() || !getHostSecret(boardId)) return;
    void claimBoardToLibrary(boardId).catch(() => {
      // PATCH may 403 until the first WebSocket connect stores the host hash.
    });
  };
  void whenAuthReady().then(tryClaim);
  onAuthChange(tryClaim);
}

bindBoardPageScratchClaim();
