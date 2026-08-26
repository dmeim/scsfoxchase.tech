import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	classifyUploadFailure,
	WHITEBOARD_UPLOAD_OUTBOX_DB,
	WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE,
	WHITEBOARD_UPLOAD_OUTBOX_STORE,
	WHITEBOARD_UPLOAD_OUTBOX_VERSION,
	WhiteboardUploadOutbox,
	type WhiteboardUploadAdapter,
	type WhiteboardUploadElementSnapshot,
	type WhiteboardUploadJob,
} from '../src/lib/whiteboard-upload-outbox'

type PersistedJob = WhiteboardUploadJob

const activeOutboxes = new Set<WhiteboardUploadOutbox>()
let boardSequence = 0

function nextBoardId(): string {
	boardSequence += 1
	return `test-board-${boardSequence}`
}

function createOutbox(
	boardId: string,
	adapter: WhiteboardUploadAdapter,
): WhiteboardUploadOutbox {
	const outbox = new WhiteboardUploadOutbox(boardId, adapter)
	activeOutboxes.add(outbox)
	return outbox
}

function deferred<T>(): {
	promise: Promise<T>
	resolve: (value: T) => void
	}
{
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function httpError(status: number): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status })
}

function readPersistedJob(
	boardId: string,
	fileId: string,
): Promise<PersistedJob | undefined> {
	return new Promise((resolve, reject) => {
		const openRequest = indexedDB.open(
			WHITEBOARD_UPLOAD_OUTBOX_DB,
			WHITEBOARD_UPLOAD_OUTBOX_VERSION,
		)
		openRequest.onerror = () => reject(openRequest.error)
		openRequest.onsuccess = () => {
			const database = openRequest.result
			const transaction = database.transaction(
				[
					WHITEBOARD_UPLOAD_OUTBOX_STORE,
					WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE,
				],
				'readonly',
			)
			const metadataRequest = transaction
				.objectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE)
				.get([boardId, fileId])
			const blobRequest = transaction
				.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE)
				.get([boardId, fileId])
			transaction.onerror = () => {
				database.close()
				reject(transaction.error)
			}
			transaction.oncomplete = () => {
				database.close()
				const metadata = metadataRequest.result as PersistedJob | undefined
				const blobRecord = blobRequest.result as { blob?: Blob } | undefined
				resolve(
					metadata
						? { ...metadata, blob: metadata.blob ?? blobRecord?.blob }
						: undefined,
				)
			}
		}
	})
}

async function waitForJob(
	outbox: WhiteboardUploadOutbox,
	fileId: string,
	predicate: (job: WhiteboardUploadJob | null) => boolean,
): Promise<WhiteboardUploadJob> {
	return vi.waitFor(
		() => {
			const job = outbox.getJob(fileId)
			const snapshotJob =
				outbox.getSnapshot().jobs.find((candidate) => candidate.fileId === fileId) ??
				null
			if (!predicate(job) || !predicate(snapshotJob)) {
				throw new Error(`Unexpected upload state: ${job?.state ?? 'missing'}`)
			}
			return job as WhiteboardUploadJob
		},
		{ timeout: 2000, interval: 1 },
	)
}

function snapshot(
	elementId: string,
	elementVersion: number,
): WhiteboardUploadElementSnapshot {
	return {
		elementId,
		elementVersion,
		element: {
			id: elementId,
			version: elementVersion,
			type: 'image',
		},
	}
}

afterEach(() => {
	for (const outbox of activeOutboxes) outbox.dispose()
	activeOutboxes.clear()
})

describe('WhiteboardUploadOutbox', () => {
	it('persists a staged upload before invoking the injected adapter', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-staged-first'
		const observed = deferred<PersistedJob | undefined>()
		const adapter = vi.fn(async () => {
			observed.resolve(await readPersistedJob(boardId, fileId))
		})
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['image bytes'], { type: 'image/png' }),
			mimeType: 'image/png',
			latestElementSnapshots: [snapshot('element-1', 4)],
			latestElementState: { viewBackgroundColor: '#fff' },
			sceneVersion: 4,
		})

		const persisted = await observed.promise
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(adapter).toHaveBeenCalledTimes(1)
		expect(persisted).toMatchObject({
			boardId,
			fileId,
			mimeType: 'image/png',
			state: 'uploading',
			status: 'uploading',
			sceneVersion: 4,
			contentVersion: 0,
		})
		expect(persisted?.blob).toBeInstanceOf(Blob)
		expect(persisted?.latestElementSnapshots).toEqual([
			snapshot('element-1', 4),
		])
	})

	it('keeps a successful upload until the referencing scene is acknowledged', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-awaiting-ack'
		const upload = deferred<void>()
		const adapter = vi.fn(() => upload.promise)
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['image bytes'], { type: 'image/png' }),
			mimeType: 'image/png',
			latestElementSnapshots: [snapshot('element-ack', 1)],
			sceneVersion: 9,
		})
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploading')

		upload.resolve()
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(outbox.getSnapshot()).toMatchObject({
			awaitingSceneAckCount: 1,
			pendingFileIds: [fileId],
		})
		expect(await readPersistedJob(boardId, fileId)).toMatchObject({
			state: 'uploaded',
			sceneAcknowledgedVersion: undefined,
		})

		const removed = await outbox.markSceneAcknowledged({
			boardId,
			sceneVersion: 9,
			fileIds: [fileId],
		})

		expect(removed).toEqual([fileId])
		expect(outbox.getJob(fileId)).toBeNull()
		expect(await readPersistedJob(boardId, fileId)).toBeUndefined()
		expect(outbox.getSnapshot()).toMatchObject({
			awaitingSceneAckCount: 0,
			pendingFileIds: [],
		})
	})

	it.each([
		{
			name: 'network errors',
			error: new Error('offline'),
			expected: { state: 'failed', kind: 'network' },
		},
		{
			name: 'HTTP 503 errors',
			error: httpError(503),
			expected: { state: 'failed', kind: 'server', status: 503 },
		},
		{
			name: 'HTTP 401 errors',
			error: httpError(401),
			expected: { state: 'auth-blocked', kind: 'auth', status: 401 },
		},
		{
			name: 'HTTP 403 errors',
			error: httpError(403),
			expected: { state: 'auth-blocked', kind: 'auth', status: 403 },
		},
		{
			name: 'HTTP 413 errors',
			error: httpError(413),
			expected: { state: 'permanent-failure', kind: 'size', status: 413 },
		},
		{
			name: 'HTTP 415 errors',
			error: httpError(415),
			expected: { state: 'permanent-failure', kind: 'mime', status: 415 },
		},
		{
			name: 'other HTTP 4xx errors',
			error: httpError(404),
			expected: { state: 'permanent-failure', kind: 'permanent', status: 404 },
		},
	] as const)('classifies $name for the upload state machine', ({ error, expected }) => {
		expect(classifyUploadFailure(error)).toEqual(expected)
	})

	it('marks network and 5xx failures retryable, then succeeds on an explicit retry', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-retryable'
		let attempt = 0
		const adapter = vi.fn(async () => {
			attempt += 1
			if (attempt === 1) throw httpError(503)
		})
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['retry me'], { type: 'image/webp' }),
			mimeType: 'image/webp',
			sceneVersion: 2,
		})
		const failed = await waitForJob(
			outbox,
			fileId,
			(job) => job?.state === 'failed',
		)

		expect(failed.error).toMatchObject({
			kind: 'server',
			status: 503,
		})
		expect(failed.nextAttemptAt).toBeGreaterThan(failed.updatedAt)
		expect(outbox.getSnapshot().uploadPendingFileIds).toEqual([])

		await outbox.retry(fileId)
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(adapter).toHaveBeenCalledTimes(2)
	})

	it('wakes auth-blocked uploads after board authentication becomes available', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-auth-retry'
		let attempt = 0
		const adapter = vi.fn(async () => {
			attempt += 1
			if (attempt === 1) throw httpError(401)
		})
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['auth retry'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		const blocked = await waitForJob(
			outbox,
			fileId,
			(job) => job?.state === 'auth-blocked',
		)
		expect(blocked.error).toMatchObject({ kind: 'auth', status: 401 })

		outbox.notifyAuthReady()
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(adapter).toHaveBeenCalledTimes(2)
	})

	it('does not schedule an automatic retry for permanent failures', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-permanent-failure'
		const adapter = vi.fn(async () => {
			throw httpError(413)
		})
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['too large'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		const failed = await waitForJob(
			outbox,
			fileId,
			(job) => job?.state === 'permanent-failure',
		)

		expect(failed.nextAttemptAt).toBeUndefined()
		expect(outbox.getSnapshot().failedFileIds).toEqual([fileId])
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(adapter).toHaveBeenCalledTimes(1)
	})

	it('hides recovery jobs until the server scene has hydrated', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-hidden-recovery'
		const adapter = vi.fn(async () => undefined)
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['recover me'], { type: 'image/gif' }),
			mimeType: 'image/gif',
			latestElementSnapshots: [snapshot('recover-element', 3)],
			sceneVersion: 3,
		})
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(outbox.getSnapshot()).toMatchObject({
			recoveryReady: false,
			recoveryJobs: [],
		})
		expect(outbox.getRecoveryData()).toEqual([])

		outbox.markServerSceneHydrated()

		expect(outbox.getSnapshot()).toMatchObject({
			recoveryReady: true,
			recoveryJobs: [
				{
					fileId,
					latestElementSnapshots: [snapshot('recover-element', 3)],
				},
			],
		})
		expect(outbox.getRecoveryData()).toHaveLength(1)

		outbox.resetServerSceneHydration()
		expect(outbox.getRecoveryData()).toEqual([])
	})

	it('clears a deleted upload only after server hydration applies its tombstone', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-hydrated-tombstone'
		const outbox = createOutbox(boardId, vi.fn(async () => undefined))

		await outbox.stage({
			boardId,
			fileId,
			blob: new Blob(['delete after hydration'], { type: 'image/png' }),
			mimeType: 'image/png',
			latestElementSnapshots: [snapshot('tombstone-element', 4)],
			sceneVersion: 4,
		})
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(outbox.getJob(fileId)).not.toBeNull()
		expect(
			await outbox.markServerSceneHydrated({
				sceneVersion: 4,
				deletedFileIds: [fileId],
			}),
		).toEqual([fileId])
		expect(outbox.getJob(fileId)).toBeNull()
		expect(await readPersistedJob(boardId, fileId)).toBeUndefined()
	})

	it('persists snapshot updates and deletion across reload, then supports local removal', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-snapshot-reload'
		const adapter = vi.fn(async () => undefined)
		const first = createOutbox(boardId, adapter)

		await first.stage({
			boardId,
			fileId,
			blob: new Blob(['snapshot bytes'], { type: 'image/jpeg' }),
			mimeType: 'image/jpeg',
			latestElementSnapshots: [snapshot('old-element', 1)],
			latestElementState: { viewBackgroundColor: '#fff' },
			sceneVersion: 1,
		})
		await waitForJob(first, fileId, (job) => job?.state === 'uploaded')

		await first.updateElementSnapshots(fileId, {
			latestElementSnapshots: [snapshot('new-element', 2)],
			latestElementState: { viewBackgroundColor: '#000' },
			sceneVersion: 2,
		})
		await first.updateElementSnapshots(fileId, {
			latestElementSnapshots: [],
			sceneState: { deleted: true },
			sceneVersion: 3,
		})

		expect(first.getSnapshot()).toMatchObject({
			pendingFileIds: [fileId],
			pendingElementIds: [],
		})
		expect(first.getJob(fileId)).toMatchObject({
			latestElementSnapshots: [],
			latestElementState: { deleted: true },
			sceneVersion: 3,
		})

		first.dispose()
		const reloaded = createOutbox(boardId, vi.fn(async () => undefined))
		await reloaded.ready

		expect(reloaded.getJob(fileId)).toMatchObject({
			state: 'uploaded',
			latestElementSnapshots: [],
			latestElementState: { deleted: true },
			sceneVersion: 3,
		})

		expect(await reloaded.remove(fileId)).toBe(true)
		expect(reloaded.getJob(fileId)).toBeNull()
		expect(await readPersistedJob(boardId, fileId)).toBeUndefined()
		expect(adapter).toHaveBeenCalledTimes(1)
	})

	it('requeues an interrupted uploading job after reload', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-interrupted-upload'
		const first = createOutbox(
			boardId,
			vi.fn(() => new Promise<void>(() => undefined)),
		)

		await first.stage({
			boardId,
			fileId,
			blob: new Blob(['interrupted bytes'], { type: 'image/webp' }),
			mimeType: 'image/webp',
		})
		await waitForJob(first, fileId, (job) => job?.state === 'uploading')
		first.dispose()

		const secondAdapter = vi.fn(async () => undefined)
		const second = createOutbox(boardId, secondAdapter)
		await second.ready
		await waitForJob(second, fileId, (job) => job?.state === 'uploaded')

		expect(secondAdapter).toHaveBeenCalledTimes(1)
		expect(second.getJob(fileId)?.attempts).toBe(2)
		await second.remove(fileId)
	})

	it('scopes acknowledgements to their mutation file ids and protects newer scene versions', async () => {
		const boardId = nextBoardId()
		const adapter = vi.fn(async () => undefined)
		const outbox = createOutbox(boardId, adapter)

		await outbox.stage({
			boardId,
			fileId: 'image-newer-scene',
			blob: new Blob(['newer'], { type: 'image/png' }),
			mimeType: 'image/png',
			sceneVersion: 1,
		})
		await outbox.stage({
			boardId,
			fileId: 'image-other-mutation',
			blob: new Blob(['other'], { type: 'image/png' }),
			mimeType: 'image/png',
			sceneVersion: 1,
		})
		await waitForJob(outbox, 'image-newer-scene', (job) => job?.state === 'uploaded')
		await waitForJob(outbox, 'image-other-mutation', (job) => job?.state === 'uploaded')

		await outbox.updateElementSnapshots('image-newer-scene', {
			sceneVersion: 3,
			latestElementSnapshots: [snapshot('newer-element', 3)],
		})

		const oldAcknowledgement = await outbox.markSceneAcknowledged({
			boardId,
			sceneVersion: 1,
			fileIds: ['image-newer-scene', 'image-other-mutation'],
		})
		expect(oldAcknowledgement).toEqual(['image-other-mutation'])
		expect(outbox.getJob('image-newer-scene')).not.toBeNull()
		expect(outbox.getJob('image-other-mutation')).toBeNull()

		const currentAcknowledgement = await outbox.markSceneAcknowledged({
			boardId,
			sceneVersion: 3,
			fileIds: ['image-newer-scene'],
		})
		expect(currentAcknowledgement).toEqual(['image-newer-scene'])
		expect(outbox.getJob('image-newer-scene')).toBeNull()
	})
})
