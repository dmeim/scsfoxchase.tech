/** Device-local whiteboard Recents / Library (Phase 1) + device install id (Phase 4a)
 *  + dual-mode active helpers (Phase 4b cloud indexes when signed in).
 */
import {
	deleteCloudBoard,
	fetchCloudBoards,
	upsertCloudBoard,
} from '../lib/whiteboard-cloud'
import { getActiveIdentity, isSignedIn } from '../lib/whiteboard-identity'

export const LIBRARY_KEY = 'scsfoxchase.whiteboard.library';
export const HOST_SECRET_PREFIX = 'scsfoxchase.whiteboard.host.';
export const DEVICE_INSTALL_ID_KEY = 'scsfoxchase.whiteboard.deviceInstallId';

export type WhiteboardLibraryEntry = {
  id: string;
  title: string;
  lastAccessedAt: string;
  previewDataUrl?: string;
};

/**
 * Stable per-browser UUID for signed-out owner keys (`local:{deviceInstallId}`).
 * Minted on first visit; clearing site data creates a new namespace.
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
 * Signed out: `local:{deviceInstallId}`.
 * Signed in: `google:{accountId}` from Clerk identity bridge.
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

export function readLibrary(): WhiteboardLibraryEntry[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

function isValidEntry(value: unknown): value is WhiteboardLibraryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    isBoardUuid(entry.id) &&
    typeof entry.title === 'string' &&
    typeof entry.lastAccessedAt === 'string'
  );
}

export function writeLibrary(entries: WhiteboardLibraryEntry[]): void {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
}

export function getEntry(boardId: string): WhiteboardLibraryEntry | undefined {
  return readLibrary().find((entry) => entry.id === boardId);
}

export function upsertEntry(
  patch: Pick<WhiteboardLibraryEntry, 'id'> &
    Partial<Omit<WhiteboardLibraryEntry, 'id'>>,
): WhiteboardLibraryEntry {
  const entries = readLibrary();
  const index = entries.findIndex((entry) => entry.id === patch.id);
  const now = new Date().toISOString();
  const next: WhiteboardLibraryEntry = {
    id: patch.id,
    title:
      patch.title ??
      (index >= 0 ? entries[index].title : 'Untitled board'),
    lastAccessedAt: patch.lastAccessedAt ?? now,
    previewDataUrl:
      patch.previewDataUrl !== undefined
        ? patch.previewDataUrl
        : index >= 0
          ? entries[index].previewDataUrl
          : undefined,
  };

  if (index >= 0) {
    entries[index] = next;
  } else {
    entries.unshift(next);
  }

  writeLibrary(entries);
  return next;
}

export function touchBoard(boardId: string, title?: string): WhiteboardLibraryEntry {
  return upsertEntry({
    id: boardId,
    title,
    lastAccessedAt: new Date().toISOString(),
  });
}

export function setBoardTitle(boardId: string, title: string): WhiteboardLibraryEntry {
  const cleaned = title.trim() || 'Untitled board';
  return upsertEntry({
    id: boardId,
    title: cleaned,
    lastAccessedAt: new Date().toISOString(),
  });
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

export function createBoard(title = defaultBoardTitle()): {
  id: string;
  hostSecret: string;
  entry: WhiteboardLibraryEntry;
} {
  const id = crypto.randomUUID();
  const hostSecret = createHostSecret();
  localStorage.setItem(hostSecretKey(id), hostSecret);
  const entry = upsertEntry({
    id,
    title,
    lastAccessedAt: new Date().toISOString(),
  });
  return { id, hostSecret, entry };
}

/** Remove a board from this device’s library (no server/R2 delete). */
export function removeBoard(boardId: string): void {
  writeLibrary(readLibrary().filter((entry) => entry.id !== boardId));
  try {
    localStorage.removeItem(hostSecretKey(boardId));
  } catch {
    // ignore quota / private-mode failures
  }
  clearLocalTldrawPersistence(boardId);
}

function clearLocalTldrawPersistence(boardId: string): void {
  const persistenceKey = `scsfoxchase-tldraw-r-${boardId}`;
  const dbNames = [
    persistenceKey,
    `TLDRAW_DOCUMENT_v2${persistenceKey}`,
    `TLDRAW_DOCUMENT_v3${persistenceKey}`,
  ];
  for (const name of dbNames) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      // best-effort only
    }
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

/** Recents = most recently accessed; Library = full list (same source for v1). */
export function getRecents(limit = 8): WhiteboardLibraryEntry[] {
  return sortByAccessed(readLibrary()).slice(0, limit);
}

export function getLibrarySorted(): WhiteboardLibraryEntry[] {
  return sortByAccessed(readLibrary());
}

function sortByAccessed(entries: WhiteboardLibraryEntry[]): WhiteboardLibraryEntry[] {
  return [...entries].sort(
    (a, b) =>
      new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Dual-mode (Phase 4b) — active index follows sign-in state
// ---------------------------------------------------------------------------

export async function listBoardsActive(): Promise<WhiteboardLibraryEntry[]> {
  if (isSignedIn()) {
    return sortByAccessed(await fetchCloudBoards());
  }
  return getLibrarySorted();
}

export async function getRecentsActive(limit = 8): Promise<WhiteboardLibraryEntry[]> {
  return (await listBoardsActive()).slice(0, limit);
}

export async function getEntryActive(
  boardId: string,
): Promise<WhiteboardLibraryEntry | undefined> {
  if (isSignedIn()) {
    const boards = await fetchCloudBoards();
    return boards.find((entry) => entry.id === boardId);
  }
  return getEntry(boardId);
}

export async function upsertEntryActive(
  patch: Pick<WhiteboardLibraryEntry, 'id'> &
    Partial<Omit<WhiteboardLibraryEntry, 'id'>>,
): Promise<WhiteboardLibraryEntry> {
  if (isSignedIn()) {
    const existing = await getEntryActive(patch.id);
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
    return upsertCloudBoard(next);
  }
  return upsertEntry(patch);
}

export async function touchBoardActive(
  boardId: string,
  title?: string,
): Promise<WhiteboardLibraryEntry> {
  return upsertEntryActive({
    id: boardId,
    title,
    lastAccessedAt: new Date().toISOString(),
  });
}

export async function setBoardTitleActive(
  boardId: string,
  title: string,
): Promise<WhiteboardLibraryEntry> {
  const cleaned = title.trim() || 'Untitled board';
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
  try {
    localStorage.setItem(hostSecretKey(id), hostSecret);
  } catch {
    // private mode — host admin on this device may be unavailable
  }
  const entry = await upsertEntryActive({
    id,
    title,
    lastAccessedAt: new Date().toISOString(),
  });
  return { id, hostSecret, entry };
}

/** Remove from the active library only (local or cloud). Does not wipe the other mode. */
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
