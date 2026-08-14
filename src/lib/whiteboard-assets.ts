/**
 * Whiteboard asset library (localStorage + cloud) + R2 upload helpers.
 *
 * Owner keys:
 * - Signed-in saved boards: google:{accountId}
 * - Unsaved / signed-out scratch: temp:{boardId} (24h TTL)
 * - Legacy hub index: local:{deviceInstallId}
 *
 * R2 object keys: assets/{ownerKey}/{assetId}
 * Resolve URL: /api/whiteboard/assets/{encodeURIComponent(ownerKey)}/{assetId}
 * Canvas images/GIF/video: see whiteboard-excalidraw-files.ts (not hub drag-drop).
 */
import {
	deleteCloudAsset,
	fetchCloudAssets,
	upsertCloudAsset,
} from './whiteboard-cloud'
import { getAuthHeaders, isClerkConfigured, isSignedIn, whenAuthReady } from './whiteboard-identity'
import {
	getDeviceInstallId,
	getHostSecret,
	getOwnerKey,
	isBoardUuid,
	readBoardIdFromPath,
} from '../scripts/whiteboard-library'

type WhiteboardAssetStore = {
	upload: (asset: { id?: string }, file: File) => Promise<{ src: string }>
	resolve: (asset: { props: { src?: string } }) => string | undefined
}

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
			headers: await getAuthHeaders(),
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
				headers: await getAuthHeaders(),
			})
		} catch {
			// Index already updated
		}
		return true
	}
	return removeAsset(assetId)
}

function defaultTitleFromFile(file: File): string {
	const name = (file.name || '').trim()
	if (!name || name === 'image.png' || name === 'blob') return 'Untitled asset'
	return name.slice(0, 120)
}

function assertUploadAllowed(file: File): void {
	const mime = (file.type || '').split(';')[0].trim().toLowerCase()
	if (!mime || !ALLOWED_MIME.has(mime)) {
		throw new Error(
			'Unsupported file type. Use JPEG, PNG, GIF, WebP, SVG, or MP4/WebM.',
		)
	}
	if (file.size > MAX_ASSET_BYTES) {
		throw new Error(
			`File too large (max ${MAX_ASSET_BYTES / (1024 * 1024)} MB).`,
		)
	}
}

/**
 * Mint library UUID, upload to R2 under the active owner key, upsert active Assets index.
 */
export const r2AssetStore: WhiteboardAssetStore = {
	async upload(_asset, file) {
		assertUploadAllowed(file)

		// Avoid writing under local:* while Clerk is still loading for a signed-in session.
		if (isClerkConfigured()) {
			await whenAuthReady()
		}

		const ownerKey = getOwnerKey()
		// Ensure device id exists before signed-out upload
		if (!isSignedIn()) void getDeviceInstallId()

		const assetId = crypto.randomUUID()
		const url = assetResolveUrl(ownerKey, assetId)
		const mimeType = (file.type || 'application/octet-stream')
			.split(';')[0]
			.trim()
			.toLowerCase()

		const authHeaders = await getAuthHeaders()
		const res = await fetch(url, {
			method: 'PUT',
			headers: {
				'Content-Type': mimeType,
				...authHeaders,
			},
			body: file,
		})

		if (!res.ok) {
			let message = `Upload failed (${res.status})`
			try {
				const body = (await res.json()) as { error?: string }
				if (body.error) message = body.error
			} catch {
				// ignore
			}
			throw new Error(message)
		}

		const boardId = readBoardIdFromPath()
		const sourceBoardIds =
			boardId && isBoardUuid(boardId) ? [boardId] : undefined

		await upsertAssetActive({
			id: assetId,
			title: defaultTitleFromFile(file),
			mimeType,
			size: file.size,
			r2Key: r2KeyFor(ownerKey, assetId),
			ownerKey,
			sourceBoardIds,
			lastAccessedAt: new Date().toISOString(),
		})

		// Absolute URL so peers on other origins/devices resolve the same capability path
		const src = new URL(url, window.location.origin).toString()
		return { src }
	},

	resolve(asset) {
		return asset.props.src
	},
}

/** @deprecated Phase 3 stub — use r2AssetStore */
export const localBlobAssetStore = r2AssetStore

// ---------------------------------------------------------------------------
// Phase 3.2 — canvas files (Excalidraw fileId → R2). Hub index is not updated.
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

export function parsePlayerPath(
	link: string,
): { ownerKey: string; fileId: string } | null {
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
	if (!isOwnerKeyShape(ownerKey) || !isAssetUuid(fileId)) return null
	return { ownerKey, fileId }
}

function isOwnerKeyShape(value: string): boolean {
	return /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/.test(value)
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
}): Promise<void> {
	assertUploadAllowed(
		new File([opts.bytes], opts.fileId, { type: opts.mimeType }),
	)
	const url = assetResolveUrl(opts.ownerKey, opts.fileId)
	const headers: Record<string, string> = {
		'Content-Type': opts.mimeType,
	}
	if (opts.ownerKey.startsWith('google:')) {
		Object.assign(headers, await getAuthHeaders())
	}
	const res = await fetch(url, {
		method: 'PUT',
		headers,
		body: opts.bytes,
	})
	if (!res.ok) {
		let message = `Upload failed (${res.status})`
		try {
			const body = (await res.json()) as { error?: string }
			if (body.error) message = body.error
		} catch {
			// ignore
		}
		throw new Error(message)
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
