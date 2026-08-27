/**
 * Whiteboard hub asset index (cloud) + canvas R2 helpers.
 *
 * Canvas owner keys (live path):
 * - Signed-in saved boards: google:{accountId}
 * - Unsaved / signed-out scratch: temp:{boardId} (24h TTL)
 *
 * R2 object keys stay assets/{ownerKey}/{fileId} (one store; not a second library).
 * Resolve URL: /api/whiteboard/assets/{encodeURIComponent(ownerKey)}/{assetId}
 * Canvas images/GIF/video: whiteboard-excalidraw-files.ts. Hub Assets is not
 * a class media library — canvas PUT does not upsert assets.json.
 *
 * local:{deviceInstallId} is not a live hub upload prefix. The Worker may still
 * GET leftover objects; parsePlayerPath accepts the shape for old links.
 */
import {
	deleteCloudAsset,
	fetchCloudAssets,
	upsertCloudAsset,
} from './whiteboard-cloud'
import { getAuthHeaders, isSignedIn } from './whiteboard-identity'
import {
	getHostSecret,
	getOwnerKey,
	isBoardUuid,
	readBoardIdFromPath,
} from '../scripts/whiteboard-library'
import {
	boardWriteProofRequiredError,
	headersHaveBoardWriteProof,
} from './whiteboard-board-write-proof'
import { getBoardSessionAuth } from './whiteboard-participants'
import {
	WHITEBOARD_PREVIEW_KIND,
	WHITEBOARD_PREVIEW_KIND_HEADER,
} from './whiteboard-preview-url'

export const ASSETS_KEY = 'scsfoxchase.whiteboard.assets'

/** Chromebook-friendly upload cap (must match Worker). */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024

const ALLOWED_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	'video/mp4',
	'video/webm',
])

export type WhiteboardAssetEntry = {
	id: string
	title: string
	createdAt: string
	lastAccessedAt: string
	mimeType: string
	size?: number
	r2Key: string
	ownerKey: string
	sourceBoardIds?: string[]
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isAssetUuid(value: string): boolean {
	return UUID_RE.test(value.trim())
}

function isValidAssetEntry(value: unknown): value is WhiteboardAssetEntry {
	if (!value || typeof value !== 'object') return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.id === 'string' &&
		isAssetUuid(entry.id) &&
		typeof entry.title === 'string' &&
		typeof entry.createdAt === 'string' &&
		typeof entry.lastAccessedAt === 'string' &&
		typeof entry.mimeType === 'string' &&
		typeof entry.r2Key === 'string' &&
		typeof entry.ownerKey === 'string'
	)
}

export function readAssets(): WhiteboardAssetEntry[] {
	try {
		const raw = localStorage.getItem(ASSETS_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter(isValidAssetEntry)
	} catch {
		return []
	}
}

export function writeAssets(entries: WhiteboardAssetEntry[]): void {
	localStorage.setItem(ASSETS_KEY, JSON.stringify(entries))
}

export function getAssetsSorted(): WhiteboardAssetEntry[] {
	return [...readAssets()].sort(
		(a, b) =>
			new Date(b.lastAccessedAt).getTime() -
			new Date(a.lastAccessedAt).getTime(),
	)
}

export function assetResolveUrl(ownerKey: string, assetId: string): string {
	return `/api/whiteboard/assets/${encodeURIComponent(ownerKey)}/${encodeURIComponent(assetId)}`
}

/** New canvas assets are scoped to a board; legacy owner-key URLs stay intact. */
export function boardAssetResolveUrl(boardId: string, fileId: string): string {
	return `/api/whiteboard/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(fileId)}`
}

export function r2KeyFor(ownerKey: string, assetId: string): string {
	return `assets/${ownerKey}/${assetId}`
}

export function upsertAsset(
	patch: Pick<WhiteboardAssetEntry, 'id'> &
		Partial<Omit<WhiteboardAssetEntry, 'id'>>,
): WhiteboardAssetEntry {
	const entries = readAssets()
	const index = entries.findIndex((entry) => entry.id === patch.id)
	const now = new Date().toISOString()
	const existing = index >= 0 ? entries[index] : undefined

	const next: WhiteboardAssetEntry = {
		id: patch.id,
		title:
			patch.title ??
			existing?.title ??
			'Untitled asset',
		createdAt: existing?.createdAt ?? patch.createdAt ?? now,
		lastAccessedAt: patch.lastAccessedAt ?? now,
		mimeType: patch.mimeType ?? existing?.mimeType ?? 'application/octet-stream',
		size: patch.size !== undefined ? patch.size : existing?.size,
		r2Key: patch.r2Key ?? existing?.r2Key ?? '',
		ownerKey: patch.ownerKey ?? existing?.ownerKey ?? getOwnerKey(),
		sourceBoardIds:
			patch.sourceBoardIds !== undefined
				? patch.sourceBoardIds
				: existing?.sourceBoardIds,
	}

	if (index >= 0) {
		entries[index] = next
	} else {
		entries.unshift(next)
	}

	writeAssets(entries)
	return next
}

export function setAssetTitle(assetId: string, title: string): WhiteboardAssetEntry {
	const cleaned = title.trim() || 'Untitled asset'
	return upsertAsset({
		id: assetId,
		title: cleaned,
		lastAccessedAt: new Date().toISOString(),
	})
}

/**
 * Remove from local index and best-effort DELETE the R2 object.
 * Returns whether the local entry was removed.
 */
export async function removeAsset(assetId: string): Promise<boolean> {
	const entries = readAssets()
	const entry = entries.find((e) => e.id === assetId)
	if (!entry) return false

	writeAssets(entries.filter((e) => e.id !== assetId))

	try {
		await fetch(assetResolveUrl(entry.ownerKey, entry.id), {
			method: 'DELETE',
			headers: await assetWriteHeaders(entry.ownerKey),
		})
	} catch {
		// Index already updated; orphaned R2 object is acceptable
	}

	return true
}

export async function listAssetsActive(): Promise<WhiteboardAssetEntry[]> {
	if (isSignedIn()) {
		const assets = await fetchCloudAssets()
		return [...assets].sort(
			(a, b) =>
				new Date(b.lastAccessedAt).getTime() -
				new Date(a.lastAccessedAt).getTime(),
		)
	}
	return getAssetsSorted()
}

export async function upsertAssetActive(
	patch: Pick<WhiteboardAssetEntry, 'id'> &
		Partial<Omit<WhiteboardAssetEntry, 'id'>>,
): Promise<WhiteboardAssetEntry> {
	if (isSignedIn()) {
		const existingList = await fetchCloudAssets()
		const existing = existingList.find((entry) => entry.id === patch.id)
		const now = new Date().toISOString()
		const ownerKey = getOwnerKey()
		const next: WhiteboardAssetEntry = {
			id: patch.id,
			title: patch.title ?? existing?.title ?? 'Untitled asset',
			createdAt: existing?.createdAt ?? patch.createdAt ?? now,
			lastAccessedAt: patch.lastAccessedAt ?? now,
			mimeType: patch.mimeType ?? existing?.mimeType ?? 'application/octet-stream',
			size: patch.size !== undefined ? patch.size : existing?.size,
			r2Key: patch.r2Key ?? existing?.r2Key ?? r2KeyFor(ownerKey, patch.id),
			ownerKey: patch.ownerKey ?? existing?.ownerKey ?? ownerKey,
			sourceBoardIds:
				patch.sourceBoardIds !== undefined
					? patch.sourceBoardIds
					: existing?.sourceBoardIds,
		}
		return upsertCloudAsset(next)
	}
	return upsertAsset(patch)
}

export async function setAssetTitleActive(
	assetId: string,
	title: string,
): Promise<WhiteboardAssetEntry> {
	const cleaned = title.trim() || 'Untitled asset'
	return upsertAssetActive({
		id: assetId,
		title: cleaned,
		lastAccessedAt: new Date().toISOString(),
	})
}

export async function removeAssetActive(assetId: string): Promise<boolean> {
	if (isSignedIn()) {
		const assets = await fetchCloudAssets()
		const entry = assets.find((e) => e.id === assetId)
		if (!entry) return false
		await deleteCloudAsset(assetId)
		try {
			await fetch(assetResolveUrl(entry.ownerKey, entry.id), {
				method: 'DELETE',
				headers: await assetWriteHeaders(entry.ownerKey),
			})
		} catch {
			// Index already updated
		}
		return true
	}
	return removeAsset(assetId)
}

function assertUploadAllowed(file: File): void {
	const mime = (file.type || '').split(';')[0].trim().toLowerCase()
	if (!mime || !ALLOWED_MIME.has(mime)) {
		throw uploadError(
			'Unsupported file type. Use JPEG, PNG, GIF, WebP, SVG, or MP4/WebM.',
			415,
		)
	}
	if (file.size > MAX_ASSET_BYTES) {
		throw uploadError(
			`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
			413,
		)
	}
}

function uploadError(message: string, status: number): Error & { status: number } {
	const error = new Error(message) as Error & { status: number }
	error.status = status
	return error
}

async function responseError(res: Response, fallback: string): Promise<Error & { status: number }> {
	let message = fallback
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string' && body.error) message = body.error
	} catch {
		// ignore non-JSON error responses
	}
	return uploadError(message, res.status)
}

// ---------------------------------------------------------------------------
// Canvas files (Excalidraw fileId → R2 at assets/{ownerKey}/{fileId}).
// Canvas PUT does not upsert library/{ownerKey}/assets.json. The hub Assets
// strip is hidden until that index write exists — not a class media library.
// ---------------------------------------------------------------------------

export type BoardAssetMeta = {
	savedToLibrary: boolean
	cloudOwnerKey: string | null
}

export function tempOwnerKey(boardId: string): string {
	return `temp:${boardId}`
}

export function isTempOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith('temp:')
}

export function tempAssetPrefix(boardId: string): string {
	return `assets/${tempOwnerKey(boardId)}/`
}

export function ownerKeyForBoardMeta(
	boardId: string,
	meta: BoardAssetMeta,
): string {
	if (
		meta.savedToLibrary &&
		typeof meta.cloudOwnerKey === 'string' &&
		meta.cloudOwnerKey.startsWith('google:')
	) {
		return meta.cloudOwnerKey
	}
	return tempOwnerKey(boardId)
}

export function playerPath(ownerKey: string, fileId: string): string {
	const params = new URLSearchParams({ owner: ownerKey, id: fileId })
	return `/whiteboard-player?${params.toString()}`
}

export function boardPlayerPath(boardId: string, fileId: string): string {
	const params = new URLSearchParams({ board: boardId, id: fileId })
	return `/whiteboard-player?${params.toString()}`
}

export function parsePlayerPath(
	link: string,
): { ownerKey: string; fileId: string; boardId?: string } | null {
	if (!link) return null
	let url: URL
	try {
		url = new URL(link, 'https://scsfoxchase.tech')
	} catch {
		return null
	}
	if (url.pathname !== '/whiteboard-player') return null
	const ownerKey = url.searchParams.get('owner') || ''
	const fileId = url.searchParams.get('id') || ''
	const boardId = url.searchParams.get('board') || ''
	if (
		(!ownerKey && !isBoardUuid(boardId)) ||
		(ownerKey && !isOwnerKeyShape(ownerKey)) ||
		(boardId && !isBoardUuid(boardId)) ||
		!isAssetUuid(fileId)
	) {
		return null
	}
	return { ownerKey, fileId, ...(boardId ? { boardId } : {}) }
}

function isOwnerKeyShape(value: string): boolean {
	return /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/.test(value)
}

/** Host secret and/or live can-edit session for Worker PUT/DELETE on temp:* / local:*. */
async function assetWriteHeaders(
	ownerKey: string,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {}
	if (ownerKey.startsWith('google:')) {
		Object.assign(headers, await getAuthHeaders())
	}
	const boardId = readBoardIdFromPath()
	if (boardId && isBoardUuid(boardId)) {
		headers['X-Board-Id'] = boardId
		const hostSecret = getHostSecret(boardId)
		if (hostSecret) headers['X-Board-Host'] = hostSecret
		const sessionAuth = getBoardSessionAuth(boardId)
		if (sessionAuth) {
			headers['X-Board-Session'] = sessionAuth.sessionId
			headers['X-Board-Auth'] = sessionAuth.authToken
		}
	}
	return headers
}

/**
 * Auth/proof headers for the board-scoped PUT contract.
 * Clerk `Authorization` is attached when present, alongside host/session
 * proof. JWT-only is allowed through so the server can decide; missing every
 * proof still fails closed as 401.
 */
export async function boardAssetWriteHeaders(
	boardId: string,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		...(await getAuthHeaders()),
		'X-Board-Id': boardId,
	}
	const hostSecret = getHostSecret(boardId)
	if (hostSecret) headers['X-Board-Host'] = hostSecret
	const sessionAuth = getBoardSessionAuth(boardId)
	if (sessionAuth) {
		headers['X-Board-Session'] = sessionAuth.sessionId
		headers['X-Board-Auth'] = sessionAuth.authToken
	}
	if (!headersHaveBoardWriteProof(headers) && !headers.Authorization) {
		throw boardWriteProofRequiredError()
	}
	return headers
}

export async function fetchBoardAssetMeta(
	boardId: string,
): Promise<BoardAssetMeta> {
	const res = await fetch(
		`/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
	)
	if (!res.ok) {
		return { savedToLibrary: false, cloudOwnerKey: null }
	}
	const body = (await res.json()) as {
		savedToLibrary?: unknown
		cloudOwnerKey?: unknown
	}
	return {
		savedToLibrary: body.savedToLibrary === true,
		cloudOwnerKey:
			typeof body.cloudOwnerKey === 'string' ? body.cloudOwnerKey : null,
	}
}

export async function registerTempAssetPrefix(boardId: string): Promise<void> {
	const hostSecret = getHostSecret(boardId)
	if (!hostSecret) return
	await fetch(`/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			'X-Board-Host': hostSecret,
		},
		body: JSON.stringify({ tempAssetPrefix: tempAssetPrefix(boardId) }),
	})
}

export async function uploadCanvasBytes(opts: {
	ownerKey: string
	fileId: string
	bytes: Blob
	mimeType: string
	kind?: 'preview'
	keepalive?: boolean
}): Promise<void> {
	assertUploadAllowed(
		new File([opts.bytes], opts.fileId, { type: opts.mimeType }),
	)
	const url = assetResolveUrl(opts.ownerKey, opts.fileId)
	const headers: Record<string, string> = {
		'Content-Type': opts.mimeType,
		...(await assetWriteHeaders(opts.ownerKey)),
	}
	if (opts.kind === 'preview') {
		headers[WHITEBOARD_PREVIEW_KIND_HEADER] = WHITEBOARD_PREVIEW_KIND
	}
	const res = await fetch(url, {
		method: 'PUT',
		headers,
		body: opts.bytes,
		keepalive: opts.keepalive === true,
	})
	if (!res.ok) {
		throw await responseError(res, `Upload failed (${res.status})`)
	}
}

export type BoardAssetUploadOptions = {
	boardId: string
	fileId: string
	bytes: Blob
	mimeType: string
}

/** Upload a new canvas image to the board-scoped asset route. */
export async function uploadBoardAssetBytes(
	opts: BoardAssetUploadOptions,
): Promise<void> {
	assertUploadAllowed(
		new File([opts.bytes], opts.fileId, { type: opts.mimeType }),
	)
	const mimeType = (opts.mimeType || '').split(';')[0].trim().toLowerCase()
	const headers = {
		'Content-Type': mimeType,
		...(await boardAssetWriteHeaders(opts.boardId)),
	}
	const res = await fetch(boardAssetResolveUrl(opts.boardId, opts.fileId), {
		method: 'PUT',
		headers,
		body: opts.bytes,
	})
	if (!res.ok) {
		throw await responseError(res, `Upload failed (${res.status})`)
	}
}

export async function fetchBoardAssetBytes(
	boardId: string,
	fileId: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
	try {
		const res = await fetch(boardAssetResolveUrl(boardId, fileId))
		if (!res.ok) return null
		const mimeType = (
			res.headers.get('Content-Type') || 'application/octet-stream'
		)
			.split(';')[0]
			.trim()
			.toLowerCase()
		return { blob: await res.blob(), mimeType }
	} catch {
		return null
	}
}

/**
 * Read bytes from the legacy `assets/{ownerKey}/{assetId}` route. Boards created
 * before board-scoped keys still reference these objects, so image hydrate falls
 * back to this when the board-scoped GET 404s. Write support is gone; this is
 * read-only and must stay that way.
 */
export async function fetchOwnerAssetBytes(
	ownerKey: string,
	fileId: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
	try {
		const res = await fetch(assetResolveUrl(ownerKey, fileId))
		if (!res.ok) return null
		const mimeType = (
			res.headers.get('Content-Type') || 'application/octet-stream'
		)
			.split(';')[0]
			.trim()
			.toLowerCase()
		return { blob: await res.blob(), mimeType }
	} catch {
		return null
	}
}

export async function hasBoardAsset(
	boardId: string,
	fileId: string,
): Promise<boolean> {
	try {
		const res = await fetch(boardAssetResolveUrl(boardId, fileId), {
			method: 'HEAD',
		})
		return res.ok
	} catch {
		return false
	}
}

export type BoardScopedAssetAdapter = {
	upload: (fileId: string, bytes: Blob, mimeType: string) => Promise<void>
	fetch: (fileId: string) => Promise<{ blob: Blob; mimeType: string } | null>
	has: (fileId: string) => Promise<boolean>
}

/** Adapter form for callers that keep a board-scoped upload dependency. */
export function createBoardScopedAssetAdapter(
	boardId: string,
): BoardScopedAssetAdapter {
	return {
		upload: (fileId, bytes, mimeType) =>
			uploadBoardAssetBytes({ boardId, fileId, bytes, mimeType }),
		fetch: (fileId) => fetchBoardAssetBytes(boardId, fileId),
		has: (fileId) => hasBoardAsset(boardId, fileId),
	}
}

export async function fetchCanvasBytes(
	ownerKeys: string[],
	fileId: string,
): Promise<{ blob: Blob; mimeType: string; ownerKey: string } | null> {
	for (const ownerKey of ownerKeys) {
		if (!ownerKey) continue
		try {
			const res = await fetch(assetResolveUrl(ownerKey, fileId))
			if (!res.ok) continue
			const mimeType = (
				res.headers.get('Content-Type') || 'application/octet-stream'
			)
				.split(';')[0]
				.trim()
				.toLowerCase()
			return { blob: await res.blob(), mimeType, ownerKey }
		} catch {
			// try next owner
		}
	}
	return null
}

export async function claimTempCanvasAssets(
	boardId: string,
): Promise<{ ownerKey: string; moved: string[] } | null> {
	const headers = {
		'Content-Type': 'application/json',
		...(await getAuthHeaders()),
	}
	const res = await fetch('/api/whiteboard/assets/claim', {
		method: 'POST',
		headers,
		body: JSON.stringify({ boardId }),
	})
	if (!res.ok) return null
	const body = (await res.json()) as {
		ownerKey?: unknown
		moved?: unknown
	}
	if (typeof body.ownerKey !== 'string') return null
	return {
		ownerKey: body.ownerKey,
		moved: Array.isArray(body.moved)
			? body.moved.filter((id): id is string => typeof id === 'string')
			: [],
	}
}
