import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	classifyUploadFailure,
	WHITEBOARD_UPLOAD_OUTBOX_DB,
	WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE,
	WHITEBOARD_UPLOAD_OUTBOX_STORE,
	WHITEBOARD_UPLOAD_OUTBOX_VERSION,
	WhiteboardUploadFailureError,
	savingUploadCount,
	WhiteboardUploadOutbox,
	type WhiteboardUploadAdapter,
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
} {
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

afterEach(() => {
	for (const outbox of activeOutboxes) outbox.dispose()
	activeOutboxes.clear()
})

describe('WhiteboardUploadOutbox', () => {
	it('persists a queued upload before invoking the injected adapter', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-queued-first'
		const observed = deferred<PersistedJob | undefined>()
		const adapter = vi.fn(async () => {
			observed.resolve(await readPersistedJob(boardId, fileId))
		})
		const outbox = createOutbox(boardId, adapter)

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['image bytes'], { type: 'image/png' }),
			mimeType: 'image/png',
		})

		const persisted = await observed.promise
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(adapter).toHaveBeenCalledTimes(1)
		expect(persisted).toMatchObject({
			boardId,
			fileId,
			mimeType: 'image/png',
			state: 'uploading',
		})
		expect(persisted?.blob).toBeInstanceOf(Blob)
	})

	it('counts only pending and uploading jobs as Saving', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-saving-count'
		const upload = deferred<void>()
		const outbox = createOutbox(boardId, vi.fn(() => upload.promise))

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['image bytes'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploading')
		expect(savingUploadCount(outbox.getSnapshot())).toBe(1)

		upload.resolve()
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')
		expect(savingUploadCount(outbox.getSnapshot())).toBe(0)
		expect(outbox.getSnapshot().pendingCount).toBe(0)
	})

	it.each([
		{
			name: 'network errors',
			error: new Error('offline'),
			expected: { retryable: true, kind: 'network' },
		},
		{
			name: 'HTTP 503 errors',
			error: httpError(503),
			expected: { retryable: true, kind: 'server', status: 503 },
		},
		{
			name: 'HTTP 401 errors',
			error: httpError(401),
			expected: { retryable: true, kind: 'auth', status: 401 },
		},
		{
			name: 'HTTP 403 errors',
			error: httpError(403),
			expected: { retryable: true, kind: 'auth', status: 403 },
		},
		{
			name: 'HTTP 413 errors',
			error: httpError(413),
			expected: { retryable: false, kind: 'size', status: 413 },
		},
		{
			name: 'HTTP 415 errors',
			error: httpError(415),
			expected: { retryable: false, kind: 'mime', status: 415 },
		},
		{
			name: 'hash mismatch 400',
			error: httpError(400),
			expected: { retryable: false, kind: 'permanent', status: 400 },
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

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['retry me'], { type: 'image/webp' }),
			mimeType: 'image/webp',
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

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['auth retry'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		const blocked = await waitForJob(
			outbox,
			fileId,
			(job) => job?.state === 'failed' && job.error?.kind === 'auth',
		)
		expect(blocked.error).toMatchObject({ kind: 'auth', status: 401 })

		outbox.notifyAuthReady()
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploaded')

		expect(adapter).toHaveBeenCalledTimes(2)
	})

	it('does not schedule an automatic retry for terminal failures', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-permanent-failure'
		const adapter = vi.fn(async () => {
			throw httpError(413)
		})
		const outbox = createOutbox(boardId, adapter)

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['too large'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		const failed = await waitForJob(
			outbox,
			fileId,
			(job) => job?.state === 'failed' && job.nextAttemptAt === undefined,
		)

		expect(failed.nextAttemptAt).toBeUndefined()
		expect(outbox.getSnapshot().failedFileIds).toEqual([fileId])
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(adapter).toHaveBeenCalledTimes(1)
	})

	it('requeues an interrupted uploading job after reload', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-interrupted-upload'
		const first = createOutbox(
			boardId,
			vi.fn(() => new Promise<void>(() => undefined)),
		)

		await first.enqueue({
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

	it('resolves waitForUpload once the job is uploaded', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-wait-uploaded'
		const outbox = createOutbox(boardId, vi.fn(async () => undefined))

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['ok'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		const job = await outbox.waitForUpload(fileId)

		expect(job.state).toBe('uploaded')
		expect(job.fileId).toBe(fileId)
	})

	it('rejects waitForUpload on terminal 413', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-wait-413'
		const outbox = createOutbox(
			boardId,
			vi.fn(async () => {
				throw httpError(413)
			}),
		)

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['too large'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		await expect(outbox.waitForUpload(fileId)).rejects.toBeInstanceOf(
			WhiteboardUploadFailureError,
		)
		expect(outbox.getJob(fileId)?.nextAttemptAt).toBeUndefined()
	})

	it('rejects waitForUpload when the job is missing', async () => {
		const boardId = nextBoardId()
		const outbox = createOutbox(boardId, vi.fn(async () => undefined))
		await outbox.ready

		await expect(outbox.waitForUpload('missing-file')).rejects.toThrow(
			'Upload job was removed.',
		)
	})

	it('rejects waitForUpload after a last-resort timeout while still uploading', async () => {
		const boardId = nextBoardId()
		const fileId = 'image-wait-timeout'
		const outbox = createOutbox(
			boardId,
			vi.fn(() => new Promise<void>(() => undefined)),
		)

		await outbox.enqueue({
			boardId,
			fileId,
			blob: new Blob(['hang'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		await waitForJob(outbox, fileId, (job) => job?.state === 'uploading')
		await expect(outbox.waitForUpload(fileId, 20)).rejects.toMatchObject({
			status: 408,
		})
		expect(outbox.getJob(fileId)?.state).toBe('uploading')
	})
})
