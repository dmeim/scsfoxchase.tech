/**
 * Capture a fit-to-content JPEG of the Excalidraw scene and store it as a
 * canvas R2 asset. Hub Recents/Library cards read `previewDataUrl`.
 */
import { exportToBlob, MIME_TYPES } from '@excalidraw/excalidraw'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
	BinaryFiles,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { uploadCanvasBytes } from './whiteboard-assets'
import { isSignedIn } from './whiteboard-identity'
import {
	getEntryActive,
	getHostSecret,
	getOwnerKey,
	upsertEntryActive,
} from '../scripts/whiteboard-library'
import {
	buildPreviewDataUrl,
	parsePreviewAsset,
} from './whiteboard-preview-url'

export const PREVIEW_IDLE_MS = 10_000
/** Chrome keepalive body cap is ~64 KiB; stay under it on hide/pagehide. */
export const PREVIEW_KEEPALIVE_MAX_BYTES = 50 * 1024

const PREVIEW_MAX_SIDE = 800
const PREVIEW_JPEG_QUALITY = 0.7
const PREVIEW_PADDING = 16

export type PreviewUploadResult = 'uploaded' | 'skipped-unsaved' | 'skipped-not-owner'

function sceneImageFilesReady(
	elements: readonly OrderedExcalidrawElement[],
	files: BinaryFiles,
): boolean {
	for (const element of elements) {
		if (element.isDeleted || element.type !== 'image') continue
		const fileId = 'fileId' in element ? element.fileId : null
		if (!fileId) continue
		if (!files[fileId]?.dataURL) return false
	}
	return true
}

export function previewExportBlockReason(
	api: ExcalidrawImperativeAPI,
): 'empty' | 'files' | null {
	const elements = api.getSceneElements()
	if (elements.length === 0) return 'empty'
	if (!sceneImageFilesReady(elements, api.getFiles())) return 'files'
	return null
}

export function canExportBoardPreview(api: ExcalidrawImperativeAPI): boolean {
	return previewExportBlockReason(api) === null
}

export async function exportBoardPreview(
	api: ExcalidrawImperativeAPI,
): Promise<Blob | null> {
	if (!canExportBoardPreview(api)) return null
	try {
		const blob = await exportToBlob({
			elements: api.getSceneElements(),
			appState: {
				...api.getAppState(),
				exportBackground: true,
				exportWithDarkMode: false,
			},
			files: api.getFiles(),
			maxWidthOrHeight: PREVIEW_MAX_SIDE,
			exportPadding: PREVIEW_PADDING,
			mimeType: MIME_TYPES.jpg,
			quality: PREVIEW_JPEG_QUALITY,
		})
		if (!blob || blob.size === 0) return null
		return blob
	} catch {
		return null
	}
}

export async function uploadBoardPreview(opts: {
	boardId: string
	blob: Blob
	keepalive?: boolean
}): Promise<PreviewUploadResult> {
	if (!isSignedIn()) return 'skipped-not-owner'

	const existing = await getEntryActive(opts.boardId)
	if (!existing) {
		return getHostSecret(opts.boardId) ? 'skipped-unsaved' : 'skipped-not-owner'
	}

	const ownerKey = getOwnerKey()
	if (!ownerKey.startsWith('google:')) return 'skipped-unsaved'

	const parsed = parsePreviewAsset(existing?.previewDataUrl)
	const assetId = parsed?.assetId ?? crypto.randomUUID()
	const previewDataUrl = buildPreviewDataUrl(ownerKey, assetId, Date.now())

	await uploadCanvasBytes({
		ownerKey,
		fileId: assetId,
		bytes: opts.blob,
		mimeType: MIME_TYPES.jpg,
		kind: 'preview',
		keepalive: opts.keepalive,
	})

	await upsertEntryActive(
		{
			id: opts.boardId,
			title: existing?.title,
			lastAccessedAt: existing?.lastAccessedAt,
			previewDataUrl,
		},
		{ keepalive: opts.keepalive },
	)

	return 'uploaded'
}
