/**
 * Whiteboard asset library (localStorage + cloud) + R2-backed TLAssetStore.
 *
 * Owner keys:
 * - Signed out: local:{deviceInstallId}
 * - Signed in: google:{accountId}
 *
 * R2 object keys: assets/{ownerKey}/{assetId}
 * Resolve URL: /api/whiteboard/assets/{encodeURIComponent(ownerKey)}/{assetId}
 */
import type { TLAssetStore } from 'tldraw'
import {
	deleteCloudAsset,
	fetchCloudAssets,
	upsertCloudAsset,
} from './whiteboard-cloud'
import { getAuthHeaders, isClerkConfigured, isSignedIn, whenAuthReady } from './whiteboard-identity'
import {
	getDeviceInstallId,
	getOwnerKey,
	isBoardUuid,
	readBoardIdFromPath,
} from '../scripts/whiteboard-library'

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
			'Unsupported file type. Use a common image (JPEG, PNG, GIF, WebP, SVG) or MP4/WebM video.',
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
export const r2AssetStore: TLAssetStore = {
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
