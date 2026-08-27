/**
 * Default-deny filter for which scene elements may leave the browser on
 * scene:update. Pure — do not import `@excalidraw/excalidraw` here.
 */
import type { SceneElement } from './whiteboard-sync'

export type ScenePublicationContext = {
	uploadedFileIds: ReadonlySet<string>
	acknowledgedImageFileIds: ReadonlySet<string>
}

export function cloneSceneElementsForFlush(
	elements: readonly SceneElement[],
): SceneElement[] {
	return elements.map((el) => ({ ...el }))
}

export function collectAcknowledgedImageFileIds(
	elements: readonly SceneElement[],
): Set<string> {
	const ids = new Set<string>()
	for (const el of elements) {
		if (el.type !== 'image') continue
		if (typeof el.fileId !== 'string' || !el.fileId) continue
		ids.add(el.fileId)
	}
	return ids
}

export function isFlushableImageElement(
	el: SceneElement,
	ctx: ScenePublicationContext,
): boolean {
	if (el.type !== 'image') return false
	if (el.isDeleted) return true
	if (typeof el.fileId !== 'string' || !el.fileId) return false
	// Excalidraw may keep status "pending" after PUT 201 when newElementWith
	// is late or CaptureUpdateAction.NEVER skips onChange. Bytes ready
	// (uploaded or already on the server) is sufficient. Never flush error.
	if (el.status === 'error') return false
	return (
		ctx.acknowledgedImageFileIds.has(el.fileId) ||
		ctx.uploadedFileIds.has(el.fileId)
	)
}

export function filterFlushableSceneElements(
	elements: readonly SceneElement[],
	ctx: ScenePublicationContext,
): SceneElement[] {
	return elements.filter(
		(el) => el.type !== 'image' || isFlushableImageElement(el, ctx),
	)
}
