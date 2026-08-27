/**
 * Durable client-side upload queue for board-scoped whiteboard assets.
 *
 * The queue never gates a scene flush. Blob stays in IndexedDB until R2
 * confirms, then the blob is deleted. 401/403 stay retryable; 413/415 and
 * hash mismatch are terminal.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { uploadBoardAssetBytes } from './whiteboard-assets'
import {
	WHITEBOARD_AUTH_EVENT,
	WHITEBOARD_AUTH_READY_EVENT,
	WHITEBOARD_HELLO_EVENT,
} from './whiteboard-board-write-proof'

export const WHITEBOARD_UPLOAD_OUTBOX_DB = 'scs-whiteboard-upload-outbox'
export const WHITEBOARD_UPLOAD_OUTBOX_STORE = 'uploads'
export const WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE = 'upload-blobs'
export const WHITEBOARD_UPLOAD_OUTBOX_VERSION = 2

/** Retry delays after attempts 1 through 6; later attempts stay at 30 seconds. */
export const WHITEBOARD_UPLOAD_RETRY_DELAYS_MS = [
	1000,
	2000,
	4000,
	8000,
	16000,
	30000,
] as const

export const WHITEBOARD_UPLOAD_WAIT_TIMEOUT_MS = 60_000

export type WhiteboardUploadState =
	| 'pending'
	| 'uploading'
	| 'uploaded'
	| 'failed'

export type WhiteboardUploadFailureKind =
	| 'network'
	| 'server'
	| 'auth'
	| 'mime'
	| 'size'
	| 'permanent'

export type WhiteboardUploadErrorInfo = {
	message: string
	kind: WhiteboardUploadFailureKind
	status?: number
	updatedAt: number
}

export type WhiteboardUploadRequest = {
	boardId: string
	fileId: string
	blob: Blob
	mimeType: string
}

export type WhiteboardUploadAdapter = (
	request: WhiteboardUploadRequest,
) => Promise<void>

export type WhiteboardUploadJob = {
	boardId: string
	fileId: string
	blob: Blob
	mimeType: string
	state: WhiteboardUploadState
	attempts: number
	createdAt: number
	updatedAt: number
	lastAttemptAt?: number
	nextAttemptAt?: number
	uploadedAt?: number
	lastError?: string
	error?: WhiteboardUploadErrorInfo
}

export type WhiteboardUploadOutboxSnapshot = {
	boardId: string
	jobs: WhiteboardUploadJob[]
	pendingCount: number
	failedCount: number
	pendingFileIds: string[]
	uploadPendingFileIds: string[]
	failedFileIds: string[]
	ready: boolean
	storageError: string | null
}

/** Bytes in flight only. Uploaded jobs do not count as Saving. */
export function savingUploadCount(
	snapshot: Pick<WhiteboardUploadOutboxSnapshot, 'pendingCount'>,
): number {
	return snapshot.pendingCount
}

type StoredUploadRecord = Omit<WhiteboardUploadJob, 'blob'> & { blob?: Blob }
type StoredUploadBlob = { boardId: string; fileId: string; blob: Blob }

const HELLO_EVENT = WHITEBOARD_HELLO_EVENT
const AUTH_EVENT = WHITEBOARD_AUTH_EVENT
const AUTH_READY_EVENT = WHITEBOARD_AUTH_READY_EVENT

const pendingStates = new Set<WhiteboardUploadState>(['pending', 'uploading'])

function now(): number {
	return Date.now()
}

function keyFor(boardId: string, fileId: string): string {
	return `${boardId}\u0000${fileId}`
}

function cloneJob(job: WhiteboardUploadJob): WhiteboardUploadJob {
	return {
		...job,
		error: job.error ? { ...job.error } : undefined,
	}
}

function asMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim()
	if (typeof error === 'string' && error.trim()) return error.trim()
	return 'Upload failed.'
}

function statusOf(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined
	const status = (error as { status?: unknown }).status
	return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

export function retryDelayForAttempt(attempt: number): number {
	const safeAttempt = Math.max(1, Math.floor(attempt))
	return WHITEBOARD_UPLOAD_RETRY_DELAYS_MS[
		Math.min(safeAttempt - 1, WHITEBOARD_UPLOAD_RETRY_DELAYS_MS.length - 1)
	]
}

export function isWhiteboardUploadFailedState(
	state: WhiteboardUploadState,
): boolean {
	return state === 'failed'
}

function isTerminalFailure(job: WhiteboardUploadJob): boolean {
	return job.state === 'failed' && job.nextAttemptAt === undefined
}

/** Classify HTTP and network failures. 401/403 stay retryable. */
export function classifyUploadFailure(error: unknown): {
	retryable: boolean
	kind: WhiteboardUploadFailureKind
	status?: number
} {
	const status = statusOf(error)
	if (status === 401 || status === 403) {
		return { retryable: true, kind: 'auth', status }
	}
	if (status === 413) {
		return { retryable: false, kind: 'size', status }
	}
	if (status === 415 || status === 422) {
		return { retryable: false, kind: 'mime', status }
	}
	if (status === 400) {
		return { retryable: false, kind: 'permanent', status }
	}
	if (status !== undefined && status >= 500) {
		return { retryable: true, kind: 'server', status }
	}
	if (status === 408 || status === 429 || status === undefined) {
		return { retryable: true, kind: 'network', status }
	}
	if (status >= 400 && status < 500) {
		return { retryable: false, kind: 'permanent', status }
	}
	return { retryable: true, kind: 'network', status }
}

export class WhiteboardUploadOutboxStorageError extends Error {
	readonly cause: unknown

	constructor(message: string, cause?: unknown) {
		super(message)
		this.name = 'WhiteboardUploadOutboxStorageError'
		this.cause = cause
	}
}

export class WhiteboardUploadFailureError extends Error {
	readonly job: WhiteboardUploadJob
	readonly status?: number
	readonly kind?: WhiteboardUploadFailureKind
	readonly state: WhiteboardUploadState

	constructor(job: WhiteboardUploadJob) {
		super(job.error?.message || job.lastError || 'Upload failed.')
		this.name = 'WhiteboardUploadFailureError'
		this.job = job
		this.status = job.error?.status
		this.kind = job.error?.kind
		this.state = job.state
	}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
	})
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve()
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction failed'))
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
	})
}

function openDatabase(): Promise<IDBDatabase> {
	if (typeof indexedDB === 'undefined') {
		return Promise.reject(new Error('IndexedDB is unavailable in this browser.'))
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(
			WHITEBOARD_UPLOAD_OUTBOX_DB,
			WHITEBOARD_UPLOAD_OUTBOX_VERSION,
		)
		request.onupgradeneeded = () => {
			const database = request.result
			if (!database.objectStoreNames.contains(WHITEBOARD_UPLOAD_OUTBOX_STORE)) {
				database.createObjectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE, {
					keyPath: ['boardId', 'fileId'],
				})
			}
			if (!database.objectStoreNames.contains(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE)) {
				database.createObjectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE, {
					keyPath: ['boardId', 'fileId'],
				})
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'))
		request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked.'))
	})
}

function normalizeStoredState(state: unknown): WhiteboardUploadState {
	if (state === 'uploading' || state === 'pending' || state === 'uploaded' || state === 'failed') {
		return state
	}
	if (state === 'auth-blocked') return 'failed'
	if (state === 'permanent-failure') return 'failed'
	return 'pending'
}

async function readJobs(database: IDBDatabase): Promise<WhiteboardUploadJob[]> {
	const transaction = database.transaction(
		[WHITEBOARD_UPLOAD_OUTBOX_STORE, WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE],
		'readonly',
	)
	const recordsRequest = transaction
		.objectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE)
		.getAll()
	const blobsRequest = transaction
		.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE)
		.getAll()
	const [records, blobs] = await Promise.all([
		requestResult(recordsRequest) as Promise<StoredUploadRecord[]>,
		requestResult(blobsRequest) as Promise<StoredUploadBlob[]>,
	])
	const blobByKey = new Map(
		blobs.map((record) => [keyFor(record.boardId, record.fileId), record.blob]),
	)
	const loaded: WhiteboardUploadJob[] = []
	for (const record of records) {
		if (!record || typeof record.boardId !== 'string' || typeof record.fileId !== 'string') {
			continue
		}
		const blob =
			record.blob ?? blobByKey.get(keyFor(record.boardId, record.fileId))
		const rawState = (record as { state?: unknown }).state
		const state = normalizeStoredState(rawState)
		if (!blob && state !== 'uploaded') continue
		loaded.push({
			boardId: record.boardId,
			fileId: record.fileId,
			blob: blob ?? new Blob(),
			mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'application/octet-stream',
			state,
			attempts: typeof record.attempts === 'number' ? record.attempts : 0,
			createdAt: typeof record.createdAt === 'number' ? record.createdAt : now(),
			updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now(),
			lastAttemptAt: record.lastAttemptAt,
			nextAttemptAt:
				rawState === 'permanent-failure' ? undefined : record.nextAttemptAt,
			uploadedAt: record.uploadedAt,
			lastError: record.lastError,
			error: record.error,
		})
	}
	return loaded
}

async function writeJob(
	database: IDBDatabase,
	job: WhiteboardUploadJob,
	options: { storeBlob?: boolean } = {},
): Promise<void> {
	const transaction = database.transaction(
		[WHITEBOARD_UPLOAD_OUTBOX_STORE, WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE],
		'readwrite',
	)
	const { blob, ...metadata } = job
	transaction.objectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE).put(metadata)
	if (options.storeBlob) {
		transaction
			.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE)
			.put({ boardId: job.boardId, fileId: job.fileId, blob })
	}
	await transactionDone(transaction)
}

async function deleteBlob(
	database: IDBDatabase,
	boardId: string,
	fileId: string,
): Promise<void> {
	const transaction = database.transaction(
		[WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE],
		'readwrite',
	)
	transaction.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE).delete([boardId, fileId])
	await transactionDone(transaction)
}

async function deleteJob(
	database: IDBDatabase,
	boardId: string,
	fileId: string,
): Promise<void> {
	const transaction = database.transaction(
		[WHITEBOARD_UPLOAD_OUTBOX_STORE, WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE],
		'readwrite',
	)
	transaction.objectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE).delete([boardId, fileId])
	transaction.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE).delete([boardId, fileId])
	await transactionDone(transaction)
}

export class WhiteboardUploadOutbox {
	readonly boardId: string
	readonly ready: Promise<void>

	private readonly adapter: WhiteboardUploadAdapter
	private database: IDBDatabase | null = null
	private readonly jobs = new Map<string, WhiteboardUploadJob>()
	private readonly listeners = new Set<() => void>()
	private readonly processing = new Set<string>()
	private readonly locks = new Map<string, Promise<unknown>>()
	private resumeTimer: number | ReturnType<typeof setTimeout> | null = null
	private disposed = false
	private storageError: string | null = null
	private snapshot: WhiteboardUploadOutboxSnapshot

	private readonly onResumeEvent = () => {
		void this.resume(true)
	}

	constructor(boardId: string, adapter: WhiteboardUploadAdapter = defaultUploadAdapter) {
		this.boardId = boardId
		this.adapter = adapter
		this.snapshot = this.buildSnapshot(false)
		this.ready = this.initialize()
		void this.ready.catch(() => undefined)
		if (typeof window !== 'undefined') {
			window.addEventListener('online', this.onResumeEvent)
			window.addEventListener('focus', this.onResumeEvent)
			window.addEventListener(HELLO_EVENT, this.onResumeEvent)
			window.addEventListener(AUTH_EVENT, this.onResumeEvent)
			window.addEventListener(AUTH_READY_EVENT, this.onResumeEvent)
		}
	}

	getSnapshot = (): WhiteboardUploadOutboxSnapshot => this.snapshot

	getServerSnapshot = (): WhiteboardUploadOutboxSnapshot => this.snapshot

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private async initialize(): Promise<void> {
		try {
			this.database = await openDatabase()
			const records = await readJobs(this.database)
			for (const stored of records) {
				if (stored.boardId !== this.boardId) continue
				const job = cloneJob(stored)
				if (job.state === 'uploading') {
					job.state = 'pending'
					job.nextAttemptAt = now()
					job.updatedAt = now()
					await writeJob(this.database, job)
				}
				this.jobs.set(keyFor(job.boardId, job.fileId), job)
			}
			this.storageError = null
			this.publish(true)
			void this.resume(true)
		} catch (error) {
			this.storageError = asMessage(error)
			this.publish(true)
			throw new WhiteboardUploadOutboxStorageError(
				'Whiteboard uploads cannot be saved for offline recovery.',
				error,
			)
		}
	}

	private buildSnapshot(ready: boolean): WhiteboardUploadOutboxSnapshot {
		const jobs = [...this.jobs.values()]
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(cloneJob)
		const pending = jobs.filter((job) => pendingStates.has(job.state))
		const failed = jobs.filter((job) => job.state === 'failed')
		return {
			boardId: this.boardId,
			jobs,
			pendingCount: pending.length,
			failedCount: failed.length,
			pendingFileIds: pending.map((job) => job.fileId),
			uploadPendingFileIds: pending.map((job) => job.fileId),
			failedFileIds: failed.map((job) => job.fileId),
			ready,
			storageError: this.storageError,
		}
	}

	private publish(ready = this.snapshot.ready): void {
		this.snapshot = this.buildSnapshot(ready)
		for (const listener of this.listeners) listener()
	}

	private async persist(
		job: WhiteboardUploadJob,
		options: { storeBlob?: boolean } = {},
	): Promise<void> {
		if (!this.database) {
			throw new WhiteboardUploadOutboxStorageError(
				'Whiteboard upload outbox is not available.',
			)
		}
		try {
			await writeJob(this.database, job, options)
		} catch (error) {
			this.storageError = asMessage(error)
			this.publish()
			throw new WhiteboardUploadOutboxStorageError(
				'Whiteboard uploads cannot be saved for offline recovery.',
				error,
			)
		}
	}

	private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key) ?? Promise.resolve()
		const current = previous.then(work, work)
		this.locks.set(key, current)
		try {
			return await current
		} finally {
			if (this.locks.get(key) === current) this.locks.delete(key)
		}
	}

	async enqueue(input: WhiteboardUploadRequest): Promise<WhiteboardUploadJob> {
		if (!input.boardId || input.boardId !== this.boardId) {
			throw new Error('Upload boardId does not match this outbox.')
		}
		if (!input.fileId) throw new Error('Upload fileId is required.')
		await this.ready
		const key = keyFor(input.boardId, input.fileId)
		const queued = await this.withLock(key, async () => {
			const previous = this.jobs.get(key)
			if (previous?.state === 'uploaded') return cloneJob(previous)
			if (
				previous &&
				(previous.state === 'pending' || previous.state === 'uploading')
			) {
				return cloneJob(previous)
			}
			const timestamp = now()
			const next: WhiteboardUploadJob = {
				boardId: input.boardId,
				fileId: input.fileId,
				blob: input.blob,
				mimeType: input.mimeType,
				state: 'pending',
				attempts: previous?.attempts ?? 0,
				createdAt: previous?.createdAt ?? timestamp,
				updatedAt: timestamp,
				nextAttemptAt: timestamp,
				lastAttemptAt: previous?.lastAttemptAt,
				error: undefined,
				lastError: undefined,
			}
			this.jobs.set(key, next)
			this.publish()
			try {
				await this.persist(next, { storeBlob: true })
			} catch (error) {
				if (previous) this.jobs.set(key, previous)
				else this.jobs.delete(key)
				this.publish()
				throw error
			}
			return cloneJob(next)
		})
		void this.processKey(key)
		return queued
	}

	async waitForUpload(
		fileId: string,
		timeoutMs: number = WHITEBOARD_UPLOAD_WAIT_TIMEOUT_MS,
	): Promise<WhiteboardUploadJob> {
		await this.ready
		return new Promise((resolve, reject) => {
			let settled = false
			let unsubscribe: (() => void) | undefined
			let timer: ReturnType<typeof setTimeout> | undefined
			const finish = (error?: Error, job?: WhiteboardUploadJob) => {
				if (settled) return
				settled = true
				unsubscribe?.()
				if (timer !== undefined) clearTimeout(timer)
				if (error) reject(error)
				else resolve(job as WhiteboardUploadJob)
			}
			const check = () => {
				const job = this.jobs.get(keyFor(this.boardId, fileId))
				if (!job) {
					finish(new Error('Upload job was removed.'))
					return
				}
				if (job.state === 'uploaded') {
					finish(undefined, cloneJob(job))
					return
				}
				if (isTerminalFailure(job)) {
					finish(new WhiteboardUploadFailureError(job))
				}
			}
			check()
			if (settled) return
			unsubscribe = this.subscribe(check)
			timer = setTimeout(() => {
				const error = new Error('Upload timed out.') as Error & { status: number }
				error.status = 408
				finish(error)
			}, timeoutMs)
		})
	}

	getJob(fileId: string): WhiteboardUploadJob | null {
		const job = this.jobs.get(keyFor(this.boardId, fileId))
		return job ? cloneJob(job) : null
	}

	async retry(fileId: string): Promise<WhiteboardUploadJob | null> {
		await this.ready
		const key = keyFor(this.boardId, fileId)
		const next = await this.withLock(key, async () => {
			const current = this.jobs.get(key)
			if (!current || current.state === 'uploaded' || current.state === 'uploading') {
				return current ? cloneJob(current) : null
			}
			const updated: WhiteboardUploadJob = {
				...current,
				state: 'pending',
				nextAttemptAt: now(),
				updatedAt: now(),
				error: undefined,
				lastError: undefined,
			}
			this.jobs.set(key, updated)
			await this.persist(updated)
			this.publish()
			return cloneJob(updated)
		})
		if (next) void this.processKey(key)
		return next
	}

	async retryAll(): Promise<number> {
		await this.ready
		const ids = [...this.jobs.values()]
			.filter((job) => job.state === 'failed')
			.map((job) => job.fileId)
		for (const fileId of ids) await this.retry(fileId)
		return ids.length
	}

	async remove(fileId: string): Promise<boolean> {
		await this.ready
		const key = keyFor(this.boardId, fileId)
		return this.withLock(key, async () => {
			const current = this.jobs.get(key)
			if (!current || !this.database) return false
			await deleteJob(this.database, this.boardId, fileId)
			this.jobs.delete(key)
			this.publish()
			return true
		})
	}

	notifyAuthReady(): void {
		void this.resume(true)
	}

	notifyBoardHello(): void {
		void this.resume(true)
	}

	private async resume(retryAuth = false): Promise<void> {
		if (!this.database || this.disposed) return
		const timestamp = now()
		if (retryAuth) {
			for (const job of this.jobs.values()) {
				if (job.state !== 'failed' || job.error?.kind !== 'auth') continue
				const next: WhiteboardUploadJob = {
					...job,
					state: 'pending',
					nextAttemptAt: timestamp,
					updatedAt: timestamp,
					error: undefined,
					lastError: undefined,
				}
				this.jobs.set(keyFor(job.boardId, job.fileId), next)
				try {
					await this.persist(next)
				} catch {
					return
				}
			}
			this.publish()
		}
		for (const job of this.jobs.values()) {
			if (
				(job.state === 'pending' || job.state === 'failed') &&
				(job.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= timestamp
			) {
				void this.processKey(keyFor(job.boardId, job.fileId))
			}
		}
		this.scheduleNext()
	}

	private scheduleNext(): void {
		if (this.resumeTimer !== null || this.disposed) return
		const due = [...this.jobs.values()]
			.filter(
				(job) =>
					(job.state === 'pending' || job.state === 'failed') &&
					job.nextAttemptAt !== undefined,
			)
			.map((job) => job.nextAttemptAt as number)
			.sort((a, b) => a - b)[0]
		if (due === undefined) return
		const delay = Math.max(0, Math.min(due - now(), 2_147_483_647))
		this.resumeTimer = setTimeout(() => {
			this.resumeTimer = null
			void this.resume()
		}, delay)
	}

	private async processKey(key: string): Promise<void> {
		if (this.processing.has(key) || this.disposed) return
		const current = this.jobs.get(key)
		if (!current) return
		if (current.state === 'uploaded' || current.state === 'uploading') return
		if ((current.nextAttemptAt ?? 0) > now()) {
			this.scheduleNext()
			return
		}
		this.processing.add(key)
		try {
			await this.withLock(key, async () => {
				const job = this.jobs.get(key)
				if (!job || job.state === 'uploaded') return
				if (job.state === 'failed' && job.nextAttemptAt === undefined) return
				const uploading: WhiteboardUploadJob = {
					...job,
					state: 'uploading',
					attempts: job.attempts + 1,
					lastAttemptAt: now(),
					updatedAt: now(),
					nextAttemptAt: undefined,
				}
				this.jobs.set(key, uploading)
				this.publish()
				await this.persist(uploading)
				try {
					await this.adapter({
						boardId: uploading.boardId,
						fileId: uploading.fileId,
						blob: uploading.blob,
						mimeType: uploading.mimeType,
					})
					const done: WhiteboardUploadJob = {
						...uploading,
						state: 'uploaded',
						uploadedAt: now(),
						updatedAt: now(),
						error: undefined,
						lastError: undefined,
						nextAttemptAt: undefined,
					}
					this.jobs.set(key, done)
					await this.persist(done)
					if (this.database) {
						try {
							await deleteBlob(this.database, done.boardId, done.fileId)
						} catch {
							// Blob cleanup is best-effort after R2 has confirmed.
						}
					}
					this.publish()
				} catch (error) {
					const classification = classifyUploadFailure(error)
					const timestamp = now()
					const next: WhiteboardUploadJob = {
						...uploading,
						state: 'failed',
						updatedAt: timestamp,
						nextAttemptAt: classification.retryable
							? timestamp + retryDelayForAttempt(uploading.attempts)
							: undefined,
						lastError: asMessage(error),
						error: {
							message: asMessage(error),
							kind: classification.kind,
							status: classification.status,
							updatedAt: timestamp,
						},
					}
					this.jobs.set(key, next)
					await this.persist(next)
					this.publish()
				}
			})
		} finally {
			this.processing.delete(key)
			this.scheduleNext()
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		if (this.resumeTimer !== null) {
			clearTimeout(this.resumeTimer)
			this.resumeTimer = null
		}
		if (typeof window !== 'undefined') {
			window.removeEventListener('online', this.onResumeEvent)
			window.removeEventListener('focus', this.onResumeEvent)
			window.removeEventListener(HELLO_EVENT, this.onResumeEvent)
			window.removeEventListener(AUTH_EVENT, this.onResumeEvent)
			window.removeEventListener(AUTH_READY_EVENT, this.onResumeEvent)
		}
		this.database?.close()
		this.database = null
		this.listeners.clear()
	}
}

async function defaultUploadAdapter(request: WhiteboardUploadRequest): Promise<void> {
	await uploadBoardAssetBytes({
		boardId: request.boardId,
		fileId: request.fileId,
		bytes: request.blob,
		mimeType: request.mimeType,
	})
}

export type UseWhiteboardUploadOutboxResult = WhiteboardUploadOutboxSnapshot & {
	outbox: WhiteboardUploadOutbox
	readyPromise: Promise<void>
	enqueue: (input: WhiteboardUploadRequest) => Promise<WhiteboardUploadJob>
	waitForUpload: (
		fileId: string,
		timeoutMs?: number,
	) => Promise<WhiteboardUploadJob>
	getJob: (fileId: string) => WhiteboardUploadJob | null
	getUploadState: (fileId: string) => WhiteboardUploadState | null
	retryUpload: (fileId: string) => Promise<WhiteboardUploadJob | null>
	retryAllUploads: () => Promise<number>
	removeUpload: (fileId: string) => Promise<boolean>
	notifyAuthReady: () => void
	notifyBoardHello: () => void
}

export function useWhiteboardUploadOutbox(
	boardId: string,
	adapter?: WhiteboardUploadAdapter,
): UseWhiteboardUploadOutboxResult {
	const outbox = useMemo(
		() => new WhiteboardUploadOutbox(boardId, adapter),
		[adapter, boardId],
	)
	const state = useSyncExternalStore(
		outbox.subscribe,
		outbox.getSnapshot,
		outbox.getServerSnapshot,
	)
	useEffect(() => () => outbox.dispose(), [outbox])

	return {
		...state,
		outbox,
		readyPromise: outbox.ready,
		enqueue: outbox.enqueue.bind(outbox),
		waitForUpload: outbox.waitForUpload.bind(outbox),
		getJob: outbox.getJob.bind(outbox),
		getUploadState: (fileId) => outbox.getJob(fileId)?.state ?? null,
		retryUpload: outbox.retry.bind(outbox),
		retryAllUploads: outbox.retryAll.bind(outbox),
		removeUpload: outbox.remove.bind(outbox),
		notifyAuthReady: outbox.notifyAuthReady.bind(outbox),
		notifyBoardHello: outbox.notifyBoardHello.bind(outbox),
	}
}
