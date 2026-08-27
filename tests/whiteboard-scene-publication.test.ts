import { describe, expect, it } from 'vitest'
import {
	cloneSceneElementsForFlush,
	collectAcknowledgedImageFileIds,
	filterFlushableSceneElements,
	isFlushableImageElement,
	type ScenePublicationContext,
} from '../src/lib/whiteboard-scene-publication'
import { newImageFileIds, type SceneElement } from '../src/lib/whiteboard-sync'

const FILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FILE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FILE_UNKNOWN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function el(
	overrides: Partial<SceneElement> & Pick<SceneElement, 'id'>,
): SceneElement {
	return {
		version: 1,
		versionNonce: 1,
		...overrides,
	}
}

function ctx(partial?: Partial<ScenePublicationContext>): ScenePublicationContext {
	return {
		uploadedFileIds: partial?.uploadedFileIds ?? new Set(),
		acknowledgedImageFileIds: partial?.acknowledgedImageFileIds ?? new Set(),
	}
}

describe('filterFlushableSceneElements', () => {
	it('omits an image whose fileId is in neither uploaded nor acknowledged (default-deny)', () => {
		const image = el({
			id: 'img-unknown',
			type: 'image',
			fileId: FILE_UNKNOWN,
			status: 'saved',
		})
		expect(filterFlushableSceneElements([image], ctx())).toEqual([])
		expect(isFlushableImageElement(image, ctx())).toBe(false)
	})

	it('still includes non-image dirty elements while an unready image exists', () => {
		const stroke = el({ id: 'rect-1', type: 'rectangle' })
		const unready = el({
			id: 'img-unready',
			type: 'image',
			fileId: FILE_UNKNOWN,
			status: 'saved',
		})
		expect(
			filterFlushableSceneElements([stroke, unready], ctx()).map(
				(item) => item.id,
			),
		).toEqual(['rect-1'])
	})

	it('includes a deleted image tombstone even when its fileId is unknown', () => {
		const tombstone = el({
			id: 'img-deleted',
			type: 'image',
			fileId: FILE_UNKNOWN,
			isDeleted: true,
			status: 'saved',
		})
		expect(filterFlushableSceneElements([tombstone], ctx())).toEqual([
			tombstone,
		])
		expect(isFlushableImageElement(tombstone, ctx())).toBe(true)
	})

	it('clones elements so a later live fileId mutation is not flushed', () => {
		const live = el({
			id: 'img-live',
			type: 'image',
			fileId: null,
			status: 'pending',
		})
		const cloned = cloneSceneElementsForFlush([live])
		live.fileId = FILE_A
		live.status = 'saved'

		expect(cloned[0]?.fileId).toBeNull()
		expect(cloned[0]?.status).toBe('pending')

		const uploaded = ctx({ uploadedFileIds: new Set([FILE_A]) })
		expect(filterFlushableSceneElements(cloned, uploaded)).toEqual([])
		expect(
			filterFlushableSceneElements([live], uploaded).map((item) => item.id),
		).toEqual(['img-live'])
	})

	it('omits status pending when bytes are not ready', () => {
		const pending = el({
			id: 'img-pending',
			type: 'image',
			fileId: FILE_A,
			status: 'pending',
		})
		expect(
			filterFlushableSceneElements(
				[pending],
				ctx({ uploadedFileIds: new Set() }),
			),
		).toEqual([])
	})

	it('includes status pending when the fileId is uploaded (bytes ready)', () => {
		const pending = el({
			id: 'img-pending',
			type: 'image',
			fileId: FILE_A,
			status: 'pending',
		})
		expect(
			filterFlushableSceneElements(
				[pending],
				ctx({ uploadedFileIds: new Set([FILE_A]) }),
			),
		).toEqual([pending])
	})

	it('includes status pending when the fileId is already acknowledged', () => {
		const pending = el({
			id: 'img-pending-acked',
			type: 'image',
			fileId: FILE_B,
			status: 'pending',
		})
		expect(
			filterFlushableSceneElements(
				[pending],
				ctx({ acknowledgedImageFileIds: new Set([FILE_B]) }),
			),
		).toEqual([pending])
	})

	it('includes status saved when the fileId is in uploadedFileIds', () => {
		const saved = el({
			id: 'img-saved',
			type: 'image',
			fileId: FILE_A,
			status: 'saved',
		})
		expect(
			filterFlushableSceneElements(
				[saved],
				ctx({ uploadedFileIds: new Set([FILE_A]) }),
			),
		).toEqual([saved])
	})

	it('includes a missing status when the fileId is uploaded (old boards)', () => {
		const legacy = el({
			id: 'img-legacy',
			type: 'image',
			fileId: FILE_A,
		})
		expect(
			filterFlushableSceneElements(
				[legacy],
				ctx({ uploadedFileIds: new Set([FILE_A]) }),
			),
		).toEqual([legacy])
	})

	it('omits status error even when uploaded or acknowledged', () => {
		const failed = el({
			id: 'img-error',
			type: 'image',
			fileId: FILE_A,
			status: 'error',
		})
		expect(
			filterFlushableSceneElements(
				[failed],
				ctx({
					uploadedFileIds: new Set([FILE_A]),
					acknowledgedImageFileIds: new Set([FILE_A]),
				}),
			),
		).toEqual([])
	})

	it('includes a fileId already in acknowledgedImageFileIds even if it is not uploaded', () => {
		const known = el({
			id: 'img-acked',
			type: 'image',
			fileId: FILE_B,
			status: 'saved',
		})
		expect(
			filterFlushableSceneElements(
				[known],
				ctx({ acknowledgedImageFileIds: new Set([FILE_B]) }),
			),
		).toEqual([known])
	})

	it('omits empty string and null fileIds', () => {
		const empty = el({
			id: 'img-empty',
			type: 'image',
			fileId: '',
			status: 'saved',
		})
		const missing = el({
			id: 'img-null',
			type: 'image',
			fileId: null,
			status: 'saved',
		})
		const readyCtx = ctx({
			uploadedFileIds: new Set([FILE_A]),
			acknowledgedImageFileIds: new Set([FILE_B]),
		})
		expect(filterFlushableSceneElements([empty, missing], readyCtx)).toEqual(
			[],
		)
	})

	it('applies the same filter to a mixed scene (full-sync path)', () => {
		const stroke = el({ id: 'rect-1', type: 'rectangle' })
		const text = el({ id: 'text-1', type: 'text' })
		const unready = el({
			id: 'img-unready',
			type: 'image',
			fileId: FILE_UNKNOWN,
			status: 'saved',
		})
		const uploaded = el({
			id: 'img-uploaded',
			type: 'image',
			fileId: FILE_A,
			status: 'saved',
		})
		const acknowledged = el({
			id: 'img-acked',
			type: 'image',
			fileId: FILE_B,
			status: 'saved',
		})
		const pending = el({
			id: 'img-pending',
			type: 'image',
			fileId: FILE_A,
			status: 'pending',
		})
		const failed = el({
			id: 'img-error',
			type: 'image',
			fileId: FILE_A,
			status: 'error',
		})
		const tombstone = el({
			id: 'img-deleted',
			type: 'image',
			fileId: FILE_UNKNOWN,
			isDeleted: true,
		})
		const scene = [
			stroke,
			unready,
			uploaded,
			text,
			acknowledged,
			pending,
			failed,
			tombstone,
		]
		const publication = ctx({
			uploadedFileIds: new Set([FILE_A]),
			acknowledgedImageFileIds: new Set([FILE_B]),
		})
		expect(
			filterFlushableSceneElements(scene, publication).map((item) => item.id),
		).toEqual([
			'rect-1',
			'img-uploaded',
			'text-1',
			'img-acked',
			'img-pending',
			'img-deleted',
		])
	})
})

describe('collectAcknowledgedImageFileIds', () => {
	it('collects non-empty image fileIds from a server scene, including tombstones', () => {
		expect(
			[...collectAcknowledgedImageFileIds([
				el({ id: 'rect-1', type: 'rectangle', fileId: FILE_A }),
				el({ id: 'img-1', type: 'image', fileId: FILE_A, status: 'saved' }),
				el({
					id: 'img-deleted',
					type: 'image',
					fileId: FILE_B,
					isDeleted: true,
				}),
				el({ id: 'img-empty', type: 'image', fileId: '' }),
				el({ id: 'img-null', type: 'image', fileId: null }),
			])].sort(),
		).toEqual([FILE_A, FILE_B].sort())
	})
})

describe('newImageFileIds', () => {
	it('returns fileIds that are new on accepted image elements', () => {
		const existing = [
			el({ id: 'keep', type: 'image', fileId: FILE_A }),
			el({ id: 'rect-1', type: 'rectangle' }),
		]
		const accepted = [
			el({ id: 'keep', type: 'image', fileId: FILE_A, version: 2 }),
			el({ id: 'new', type: 'image', fileId: FILE_B }),
			el({ id: 'swap', type: 'image', fileId: FILE_UNKNOWN }),
			el({
				id: 'gone',
				type: 'image',
				fileId: FILE_UNKNOWN,
				isDeleted: true,
			}),
			el({ id: 'rect-2', type: 'rectangle', fileId: FILE_UNKNOWN }),
		]
		expect([...newImageFileIds(existing, accepted)].sort()).toEqual(
			[FILE_B, FILE_UNKNOWN].sort(),
		)
	})

	it('treats a fileId change on an existing image as new', () => {
		const existing = [el({ id: 'img-1', type: 'image', fileId: FILE_A })]
		const accepted = [el({ id: 'img-1', type: 'image', fileId: FILE_B })]
		expect([...newImageFileIds(existing, accepted)]).toEqual([FILE_B])
	})
})
