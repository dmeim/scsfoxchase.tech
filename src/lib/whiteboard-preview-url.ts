/**
 * Hub board-preview URL helpers (no Excalidraw). Shared by the Worker and
 * the canvas so Recents/Library `<img src>` stays a same-origin asset GET.
 *
 * Keys stay two-segment: assets/{ownerKey}/{uuid} — no `/previews/` path and
 * no `.jpg` suffix (the asset parser rejects both).
 */

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const OWNER_KEY_RE = /^(local|google|temp):[A-Za-z0-9_.:@-]{1,128}$/

export const WHITEBOARD_PREVIEW_KIND_HEADER = 'X-Whiteboard-Kind'
export const WHITEBOARD_PREVIEW_KIND = 'preview'
export const PREVIEW_CACHE_CONTROL = 'private, max-age=60'

const ASSET_PATH_PREFIX = '/api/whiteboard/assets/'

export function parsePreviewAsset(
	previewDataUrl: string | undefined | null,
): { ownerKey: string; assetId: string } | null {
	if (!previewDataUrl) return null
	let url: URL
	try {
		url = new URL(previewDataUrl, 'https://scsfoxchase.tech')
	} catch {
		return null
	}
	if (!url.pathname.startsWith(ASSET_PATH_PREFIX)) return null
	const rest = url.pathname.slice(ASSET_PATH_PREFIX.length).replace(/\/$/, '')
	const slash = rest.lastIndexOf('/')
	if (slash <= 0) return null
	let ownerKey: string
	let assetId: string
	try {
		ownerKey = decodeURIComponent(rest.slice(0, slash))
		assetId = decodeURIComponent(rest.slice(slash + 1))
	} catch {
		return null
	}
	if (!OWNER_KEY_RE.test(ownerKey) || !UUID_RE.test(assetId)) return null
	return { ownerKey, assetId }
}

export function buildPreviewDataUrl(
	ownerKey: string,
	assetId: string,
	version: number | string,
): string {
	return `${ASSET_PATH_PREFIX}${encodeURIComponent(ownerKey)}/${encodeURIComponent(assetId)}?v=${encodeURIComponent(String(version))}`
}
