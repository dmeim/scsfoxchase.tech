/**
 * Durable client-side upload queue for board-scoped whiteboard assets.
 *
 * Uploads are intentionally kept separate from Excalidraw's BinaryFiles state.
 * Excalidraw can discard a file after a reload or before a scene acknowledgement;
 * this outbox is the source of truth until the server has acknowledged the
 * scene version that references the file.
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

export type WhiteboardUploadState =
	| 'pending'
	| 'uploading'
	| 'uploaded'
	| 'failed'
	| 'auth-blocked'
	| 'permanent-failure'

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

/** A serializable snapshot that a later canvas layer may restore. */
export type WhiteboardUploadElementSnapshot = {
	elementId: string
	element: unknown
	elementVersion?: number
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
	/** Latest scene elements that reference this file. */
	latestElementSnapshots: WhiteboardUploadElementSnapshot[]
	/** Optional plain-data app/scene state for the later canvas integration. */
	latestElementState?: unknown
	sceneVersion: number
	state: WhiteboardUploadState
	/** Alias useful to UI code that calls the field status. */
	status: WhiteboardUploadState
	attempts: number
	createdAt: number
	updatedAt: number
	lastAttemptAt?: number
	nextAttemptAt?: number
	uploadedAt?: number
	sceneAcknowledgedVersion?: number
	error?: WhiteboardUploadErrorInfo
	/** Changes when a caller stages different bytes under the same file id. */
	contentVersion: number
}

export type WhiteboardUploadStage = {
	boardId: string
	fileId: string
	blob: Blob
	mimeType: string
	latestElementSnapshots?: readonly WhiteboardUploadElementSnapshot[]
	/** Alias accepted for callers that naturally use elementSnapshots. */
	elementSnapshots?: readonly WhiteboardUploadElementSnapshot[]
	latestElementState?: unknown
	/** Alias accepted for callers that naturally use sceneState. */
	sceneState?: unknown
	sceneVersion?: number
}

export type WhiteboardUploadStaging = {
	boardId: string
	fileId: string
	latestElementSnapshots?: readonly WhiteboardUploadElementSnapshot[]
	latestElementState?: unknown
	sceneVersion?: number
}

export type WhiteboardUploadRecovery = {
	boardId: string
	fileId: string
	mimeType: string
	state: WhiteboardUploadState
	status: WhiteboardUploadState
	latestElementSnapshots: WhiteboardUploadElementSnapshot[]
	latestElementState?: unknown
	sceneVersion: number
	attempts: number
	error?: WhiteboardUploadErrorInfo
}

export type WhiteboardUploadOutboxSnapshot = {
	boardId: string
	jobs: WhiteboardUploadJob[]
	pendingCount: number
	failedCount: number
	awaitingSceneAckCount: number
	/** All files not yet removed after scene acknowledgement. */
	pendingFileIds: string[]
	/** Files currently queued or uploading (excludes failed and ack-waiting). */
	uploadPendingFileIds: string[]
	failedFileIds: string[]
	pendingElementIds: string[]
	failedElementIds: string[]
	stagingCount: number
	stagingFileIds: string[]
	stagingElementIds: string[]
	recoveryJobs: WhiteboardUploadRecovery[]
	recoveryReady: boolean
	ready: boolean
	storageError: string | null
}

/** Bytes in flight only. Uploaded-waiting-for-ack does not count as Saving. */
export function savingUploadCount(
	snapshot: Pick<WhiteboardUploadOutboxSnapshot, 'pendingCount'>,
): number {
	return snapshot.pendingCount
}

export type WhiteboardSceneAcknowledgement = {
	boardId: string
	sceneVersion: number
	/** Pass the file ids actually present in the acknowledged scene. */
	fileIds?: readonly string[]
	/** File ids whose image tombstones were included in the acknowledged scene. */
	deletedFileIds?: readonly string[]
}

export type WhiteboardServerSceneHydration = {
	/** Scene version represented by the server scene, when available. */
	sceneVersion?: number
	/** Image file ids represented by deleted image tombstones in that scene. */
	deletedFileIds?: readonly string[]
}

export type WhiteboardUploadSceneSnapshot = {
	latestElementSnapshots?: readonly WhiteboardUploadElementSnapshot[]
	latestElementState?: unknown
	sceneState?: unknown
	sceneVersion?: number
}

export type WhiteboardUploadRemoveOptions = {
	/**
	 * Removal is local-only. The board-scoped contract has no DELETE operation;
	 * callers must clean up remote bytes only after independently proving that
	 * no scene references remain.
	 */
	confirmNoReferences?: boolean
}

type StoredUploadJob = WhiteboardUploadJob
type StoredUploadRecord = Omit<StoredUploadJob, 'blob'> & { blob?: Blob }
type StoredUploadBlob = { boardId: string; fileId: string; blob: Blob }
type LoadedUploadJob = { job: StoredUploadJob; needsBlobMigration: boolean }

const HELLO_EVENT = WHITEBOARD_HELLO_EVENT
const AUTH_EVENT = WHITEBOARD_AUTH_EVENT
const AUTH_READY_EVENT = WHITEBOARD_AUTH_READY_EVENT

/** Last-resort waitForUpload timeout so callers cannot hang forever. */
export const WHITEBOARD_UPLOAD_WAIT_TIMEOUT_MS = 60_000

const pendingStates = new Set<WhiteboardUploadState>(['pending', 'uploading'])
const failedStates = new Set<WhiteboardUploadState>([
	'failed',
	'auth-blocked',
	'permanent-failure',
])

function isUploadState(value: unknown): value is WhiteboardUploadState {
	return (
		value === 'pending' ||
		value === 'uploading' ||
		value === 'uploaded' ||
		value === 'failed' ||
		value === 'auth-blocked' ||
		value === 'permanent-failure'
	)
}

function now(): number {
	return Date.now()
}

function keyFor(boardId: string, fileId: string): string {
	return `${boardId}\u0000${fileId}`
}

function cloneJob(job: WhiteboardUploadJob): WhiteboardUploadJob {
	return {
		...job,
		latestElementSnapshots: [...job.latestElementSnapshots],
		error: job.error ? { ...job.error } : undefined,
	}
}

function cloneRecovery(job: WhiteboardUploadJob): WhiteboardUploadRecovery {
	return {
		boardId: job.boardId,
		fileId: job.fileId,
		mimeType: job.mimeType,
		state: job.state,
		status: job.status,
		latestElementSnapshots: [...job.latestElementSnapshots],
		latestElementState: job.latestElementState,
		sceneVersion: job.sceneVersion,
		attempts: job.attempts,
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
	return failedStates.has(state)
}

/** Classify HTTP and network failures without relying on Excalidraw status. */
export function classifyUploadFailure(error: unknown): {
	state: Extract<WhiteboardUploadState, 'failed' | 'auth-blocked' | 'permanent-failure'>
	kind: WhiteboardUploadFailureKind
	status?: number
} {
	const status = statusOf(error)
	if (status === 401 || status === 403) {
		return { state: 'auth-blocked', kind: 'auth', status }
	}
	if (status === 413) {
		return { state: 'permanent-failure', kind: 'size', status }
	}
	if (status === 415 || status === 422) {
		return { state: 'permanent-failure', kind: 'mime', status }
	}
	if (status !== undefined && status >= 500) {
		return { state: 'failed', kind: 'server', status }
	}
	if (status === 408 || status === 429 || status === undefined) {
		return { state: 'failed', kind: 'network', status }
	}
	if (status >= 400 && status < 500) {
		return { state: 'permanent-failure', kind: 'permanent', status }
	}
	return { state: 'failed', kind: 'network', status }
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
		super(job.error?.message || 'Upload failed.')
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

async function readJobs(database: IDBDatabase): Promise<LoadedUploadJob[]> {
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
	const loaded: LoadedUploadJob[] = []
	for (const record of records) {
		const inlineBlob = record?.blob
		const blob = inlineBlob ?? blobByKey.get(keyFor(record.boardId, record.fileId))
		const candidate = { ...record, blob }
		if (!isStoredJob(candidate)) continue
		loaded.push({
			job: candidate,
			// Version 1 stored the Blob beside every field. Move it to the
			// dedicated store once, then keep subsequent metadata writes small.
			needsBlobMigration: typeof inlineBlob?.size === 'number',
		})
	}
	return loaded
}

async function writeJob(
	database: IDBDatabase,
	job: StoredUploadJob,
	options: { storeBlob?: boolean; inlineBlob?: boolean } = {},
): Promise<void> {
	const transaction = database.transaction(
		[WHITEBOARD_UPLOAD_OUTBOX_STORE, WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE],
		'readwrite',
	)
	const { blob, ...metadata } = job
	transaction
		.objectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE)
		.put(options.inlineBlob ? job : metadata)
	if (options.storeBlob) {
		transaction
			.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE)
			.put({ boardId: job.boardId, fileId: job.fileId, blob })
	}
	await transactionDone(transaction)
}

async function deleteJob(database: IDBDatabase, boardId: string, fileId: string): Promise<void> {
	const transaction = database.transaction(
		[WHITEBOARD_UPLOAD_OUTBOX_STORE, WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE],
		'readwrite',
	)
	transaction.objectStore(WHITEBOARD_UPLOAD_OUTBOX_STORE).delete([boardId, fileId])
	transaction.objectStore(WHITEBOARD_UPLOAD_OUTBOX_BLOB_STORE).delete([boardId, fileId])
	await transactionDone(transaction)
}

function isStoredJob(value: unknown): value is StoredUploadJob {
	if (!value || typeof value !== 'object') return false
	const job = value as Partial<StoredUploadJob>
	return (
		typeof job.boardId === 'string' &&
		typeof job.fileId === 'string' &&
		typeof job.blob?.size === 'number' &&
		typeof job.mimeType === 'string' &&
		Array.isArray(job.latestElementSnapshots) &&
		typeof job.sceneVersion === 'number' &&
		isUploadState(job.state) &&
		isUploadState(job.status ?? job.state) &&
		typeof job.attempts === 'number'
	)
}

function updateState(job: WhiteboardUploadJob, state: WhiteboardUploadState): WhiteboardUploadJob {
	return { ...job, state, status: state, updatedAt: now() }
}

function sameElementSnapshots(
	left: readonly WhiteboardUploadElementSnapshot[],
	right: readonly WhiteboardUploadElementSnapshot[],
): boolean {
	if (left.length !== right.length) return false
	return left.every(
		(snapshot, index) =>
			snapshot.elementId === right[index]?.elementId &&
			snapshot.elementVersion === right[index]?.elementVersion,
	)
}

function sameSerializableValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	try {
		return JSON.stringify(left) === JSON.stringify(right)
	} catch {
		return false
	}
}

export class WhiteboardUploadOutbox {
	readonly boardId: string
	readonly ready: Promise<void>

	private readonly adapter: WhiteboardUploadAdapter
	private database: IDBDatabase | null = null
	private readonly jobs = new Map<string, WhiteboardUploadJob>()
	/** Synchronous publication guard while DataURL conversion is in flight. */
	private readonly staging = new Map<string, WhiteboardUploadStaging>()
	private readonly listeners = new Set<() => void>()
	private readonly processing = new Set<string>()
	private readonly locks = new Map<string, Promise<unknown>>()
	private resumeTimer: number | ReturnType<typeof setTimeout> | null = null
	private serverSceneHydrated = false
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
			for (const loaded of records) {
				const stored = loaded.job
				if (stored.boardId !== this.boardId) continue
				const job = cloneJob(stored)
				job.status = job.state
				if (loaded.needsBlobMigration) {
					// Preserve the v1 inline Blob before any metadata-only repair
					// (for example, resetting an interrupted upload).
					await writeJob(this.database, job, { storeBlob: true })
				}
				// A tab killed during fetch cannot remain permanently "uploading".
				if (job.state === 'uploading') {
					job.state = 'pending'
					job.status = 'pending'
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
		const failed = jobs.filter((job) => failedStates.has(job.state))
		const outstanding = jobs.filter((job) => job.state !== 'uploaded' || !job.sceneAcknowledgedVersion)
		const staging = [...this.staging.values()]
		const pendingJobIds = new Set(pending.map((job) => job.fileId))
		const collectElementIds = (source: WhiteboardUploadJob[]) => [
			...new Set(
				source.flatMap((job) =>
					job.latestElementSnapshots
						.filter((snapshot) => snapshot.elementId)
						.map((snapshot) => snapshot.elementId),
				),
			),
		]
		const pendingFileIds = [
			...new Set([
				...outstanding.map((job) => job.fileId),
				...staging.map((item) => item.fileId),
			]),
		]
		const uploadPendingFileIds = [
			...new Set([
				...pending.map((job) => job.fileId),
				...staging.map((item) => item.fileId),
			]),
		]
		return {
			boardId: this.boardId,
			jobs,
			pendingCount: pending.length + staging.filter((item) => !pendingJobIds.has(item.fileId)).length,
			failedCount: failed.length,
			awaitingSceneAckCount: jobs.filter((job) => job.state === 'uploaded').length,
			pendingFileIds,
			uploadPendingFileIds,
			failedFileIds: failed.map((job) => job.fileId),
			pendingElementIds: [
				...new Set([
					...collectElementIds(outstanding),
					...staging.flatMap((item) =>
						(item.latestElementSnapshots ?? [])
							.filter((snapshot) => snapshot.elementId)
							.map((snapshot) => snapshot.elementId),
					),
				]),
			],
			failedElementIds: collectElementIds(failed),
			stagingCount: staging.length,
			stagingFileIds: staging.map((item) => item.fileId),
			stagingElementIds: [
				...new Set(
					staging.flatMap((item) =>
						(item.latestElementSnapshots ?? []).map((snapshot) => snapshot.elementId),
					),
				),
			],
			recoveryJobs: this.serverSceneHydrated
				? outstanding.map(cloneRecovery)
				: [],
			recoveryReady: this.serverSceneHydrated,
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
		options: { storeBlob?: boolean; inlineBlob?: boolean } = {},
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

	/** Block scene publication synchronously before async DataURL conversion. */
	beginStaging(input: WhiteboardUploadStaging): void {
		if (!input.boardId || input.boardId !== this.boardId || !input.fileId) return
		const key = keyFor(input.boardId, input.fileId)
		const previous = this.staging.get(key)
		const snapshots = input.latestElementSnapshots
		const next: WhiteboardUploadStaging = {
			boardId: input.boardId,
			fileId: input.fileId,
			latestElementSnapshots:
				snapshots !== undefined
					? [...snapshots]
					: previous?.latestElementSnapshots ?? [],
			latestElementState:
				input.latestElementState !== undefined
					? input.latestElementState
					: previous?.latestElementState,
			sceneVersion: Math.max(
				previous?.sceneVersion ?? 0,
				input.sceneVersion ?? 0,
			),
		}
		if (
			previous &&
			sameElementSnapshots(
				previous.latestElementSnapshots ?? [],
				next.latestElementSnapshots ?? [],
			) &&
			sameSerializableValue(previous.latestElementState, next.latestElementState) &&
			(previous.sceneVersion ?? 0) === (next.sceneVersion ?? 0)
		) {
			return
		}
		this.staging.set(key, next)
		this.publish()
	}

	updateStaging(fileId: string, input: WhiteboardUploadSceneSnapshot): void {
		const key = keyFor(this.boardId, fileId)
		const previous = this.staging.get(key)
		if (!previous) return
		const snapshots = input.latestElementSnapshots
		const stateProvided =
			input.latestElementState !== undefined || input.sceneState !== undefined
		const nextState =
			input.latestElementState !== undefined
				? input.latestElementState
				: input.sceneState
					?? previous.latestElementState
		const next: WhiteboardUploadStaging = {
			...previous,
			latestElementSnapshots:
				snapshots !== undefined ? [...snapshots] : previous.latestElementSnapshots,
			latestElementState: stateProvided ? nextState : previous.latestElementState,
			sceneVersion: Math.max(previous.sceneVersion ?? 0, input.sceneVersion ?? 0),
		}
		if (
			sameElementSnapshots(
				previous.latestElementSnapshots ?? [],
				next.latestElementSnapshots ?? [],
			) &&
			sameSerializableValue(previous.latestElementState, next.latestElementState) &&
			(previous.sceneVersion ?? 0) === (next.sceneVersion ?? 0)
		) {
			return
		}
		this.staging.set(key, next)
		this.publish()
	}

	completeStaging(fileId: string): void {
		const key = keyFor(this.boardId, fileId)
		if (!this.staging.delete(key)) return
		this.publish()
	}

	failStaging(fileId: string): void {
		this.completeStaging(fileId)
	}

	getStagingFileIds(): string[] {
		return [...this.staging.values()].map((item) => item.fileId)
	}

	getStaging(fileId: string): WhiteboardUploadStaging | null {
		const item = this.staging.get(keyFor(this.boardId, fileId))
		return item
			? {
					...item,
					latestElementSnapshots: item.latestElementSnapshots
						? [...item.latestElementSnapshots]
						: undefined,
				}
			: null
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

	async stage(input: WhiteboardUploadStage): Promise<WhiteboardUploadJob> {
		if (!input.boardId || input.boardId !== this.boardId) {
			throw new Error('Upload boardId does not match this outbox.')
		}
		if (!input.fileId) throw new Error('Upload fileId is required.')
		await this.ready
		const key = keyFor(input.boardId, input.fileId)
		const staged = await this.withLock(key, async () => {
			const previous = this.jobs.get(key)
			const timestamp = now()
			const snapshots = input.latestElementSnapshots ?? input.elementSnapshots
			const changedBytes =
				previous &&
				(previous.blob.size !== input.blob.size ||
					previous.blob.type !== input.blob.type ||
					previous.mimeType !== input.mimeType)
			const state = changedBytes ? 'pending' : previous?.state ?? 'pending'
			const next: WhiteboardUploadJob = {
				boardId: input.boardId,
				fileId: input.fileId,
				blob: input.blob,
				mimeType: input.mimeType,
				latestElementSnapshots:
					snapshots !== undefined
						? [...snapshots]
						: previous?.latestElementSnapshots ?? [],
				latestElementState:
					input.latestElementState !== undefined
						? input.latestElementState
						: input.sceneState !== undefined
							? input.sceneState
							: previous?.latestElementState,
				sceneVersion: Math.max(
					previous?.sceneVersion ?? 0,
					input.sceneVersion ?? 0,
				),
				state,
				status: state,
				attempts: changedBytes ? 0 : previous?.attempts ?? 0,
				createdAt: previous?.createdAt ?? timestamp,
				updatedAt: timestamp,
				lastAttemptAt: changedBytes ? undefined : previous?.lastAttemptAt,
				nextAttemptAt: changedBytes ? timestamp : previous?.nextAttemptAt ?? timestamp,
				uploadedAt: changedBytes ? undefined : previous?.uploadedAt,
				sceneAcknowledgedVersion:
					previous?.sceneAcknowledgedVersion,
				error: changedBytes ? undefined : previous?.error,
				contentVersion: (previous?.contentVersion ?? 0) + (changedBytes ? 1 : 0),
			}
			if (
				next.sceneAcknowledgedVersion !== undefined &&
				next.sceneVersion > next.sceneAcknowledgedVersion
			) {
				delete next.sceneAcknowledgedVersion
			}
			this.jobs.set(key, next)
			this.publish()
				try {
					await this.persist(next, {
						storeBlob: !previous || Boolean(changedBytes),
					})
			} catch (error) {
				if (previous) this.jobs.set(key, previous)
				else this.jobs.delete(key)
				this.publish()
				throw error
			}
			return cloneJob(next)
		})
		void this.processKey(key)
		return staged
	}

	/**
	 * Wait until this file's outbox job leaves the in-flight states.
	 *
	 * Settles: `uploaded` resolves; `failed`, `auth-blocked`, `permanent-failure`,
	 * or a missing job reject. `failed` stays retryable — callers must not treat
	 * that reject as permanent. Canvas/files should watch `job.state === 'uploaded'`
	 * rather than awaiting this for scene publication.
	 */
	async waitForUpload(
		fileId: string,
		timeoutMs: number = WHITEBOARD_UPLOAD_WAIT_TIMEOUT_MS,
	): Promise<WhiteboardUploadJob> {
		await this.ready
		const key = keyFor(this.boardId, fileId)
		return new Promise((resolve, reject) => {
			let settled = false
			let timer: ReturnType<typeof setTimeout> | null = null
			const finish = (callback: () => void) => {
				if (settled) return
				settled = true
				if (timer !== null) clearTimeout(timer)
				unsubscribe()
				callback()
			}
			const check = () => {
				const job = this.jobs.get(key)
				if (!job) {
					finish(() => reject(new Error('Upload job was removed.')))
					return
				}
				if (job.state === 'uploaded') {
					finish(() => resolve(cloneJob(job)))
					return
				}
				if (
					job.state === 'failed' ||
					job.state === 'auth-blocked' ||
					job.state === 'permanent-failure'
				) {
					finish(() => reject(new WhiteboardUploadFailureError(cloneJob(job))))
				}
			}
			const unsubscribe = this.subscribe(check)
			if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
				timer = setTimeout(() => {
					finish(() =>
						reject(
							Object.assign(new Error('Upload wait timed out.'), {
								status: 408,
							}),
						),
					)
				}, timeoutMs)
			}
			check()
		})
	}

	getJob(fileId: string): WhiteboardUploadJob | null {
		const job = this.jobs.get(keyFor(this.boardId, fileId))
		return job ? cloneJob(job) : null
	}

	getPendingElementSnapshots(): WhiteboardUploadRecovery[] {
		if (!this.serverSceneHydrated) return []
		return [...this.jobs.values()]
			.filter((job) => job.state !== 'uploaded' || !job.sceneAcknowledgedVersion)
			.map(cloneRecovery)
	}

	getRecoveryData(): WhiteboardUploadRecovery[] {
		return this.getPendingElementSnapshots()
	}

	async updateElementSnapshots(
		fileId: string,
		input: WhiteboardUploadSceneSnapshot,
	): Promise<WhiteboardUploadJob | null> {
		await this.ready
		const key = keyFor(this.boardId, fileId)
		return this.withLock(key, async () => {
			const current = this.jobs.get(key)
			if (!current) return null
			const snapshotsChanged =
				input.latestElementSnapshots !== undefined &&
				!sameElementSnapshots(
					current.latestElementSnapshots,
					input.latestElementSnapshots,
				)
			const stateProvided =
				input.latestElementState !== undefined || input.sceneState !== undefined
			const nextState =
				input.latestElementState !== undefined
					? input.latestElementState
					: input.sceneState
						?? current.latestElementState
			const stateChanged =
				stateProvided &&
				!sameSerializableValue(current.latestElementState, nextState)
			if (!snapshotsChanged && !stateChanged) {
				return cloneJob(current)
			}
			const sceneVersion = Math.max(
				current.sceneVersion,
				input.sceneVersion ?? 0,
			)
			const next: WhiteboardUploadJob = {
				...current,
				latestElementSnapshots:
					input.latestElementSnapshots !== undefined
						? [...input.latestElementSnapshots]
						: current.latestElementSnapshots,
				latestElementState:
					input.latestElementState !== undefined
						? input.latestElementState
						: input.sceneState !== undefined
							? input.sceneState
							: current.latestElementState,
				sceneVersion,
				updatedAt: now(),
			}
			if (
				next.sceneAcknowledgedVersion !== undefined &&
				sceneVersion > next.sceneAcknowledgedVersion
			) {
				delete next.sceneAcknowledgedVersion
			}
			this.jobs.set(key, next)
			await this.persist(next)
			this.publish()
			return cloneJob(next)
		})
	}

	private async clearHydratedTombstones(
		input: WhiteboardServerSceneHydration,
	): Promise<string[]> {
		const deleted = new Set(input.deletedFileIds ?? [])
		if (deleted.size === 0) return []
		const sceneVersion = Number.isFinite(input.sceneVersion)
			? (input.sceneVersion as number)
			: Number.MAX_SAFE_INTEGER
		await this.ready
		const removed: string[] = []
		for (const job of [...this.jobs.values()]) {
			if (
				!deleted.has(job.fileId) ||
				(job.sceneVersion > sceneVersion &&
					job.latestElementSnapshots.length > 0)
			) {
				continue
			}
			const key = keyFor(job.boardId, job.fileId)
			await this.withLock(key, async () => {
				const current = this.jobs.get(key)
				if (
					!current ||
					(current.sceneVersion > sceneVersion &&
						current.latestElementSnapshots.length > 0) ||
					!deleted.has(current.fileId) ||
					!this.database
				) {
					return
				}
				await deleteJob(this.database, current.boardId, current.fileId)
				this.jobs.delete(key)
				removed.push(current.fileId)
				this.publish()
			})
		}
		return removed
	}

	/**
	 * Recovery snapshots are hidden until the server scene has been applied. A
	 * later canvas integration can then decide how to merge these snapshots.
	 */
	markServerSceneHydrated(
		input: WhiteboardServerSceneHydration = {},
	): Promise<string[]> {
		if (!this.serverSceneHydrated) {
			this.serverSceneHydrated = true
			this.publish()
		}
		if (!input.deletedFileIds?.length) return Promise.resolve([])
		return this.clearHydratedTombstones(input).catch((error) => {
			this.storageError = asMessage(error)
			this.publish()
			return []
		})
	}

	resetServerSceneHydration(): void {
		if (!this.serverSceneHydrated) return
		this.serverSceneHydrated = false
		this.publish()
	}

	async markSceneAcknowledged(input: WhiteboardSceneAcknowledgement): Promise<string[]> {
		if (input.boardId !== this.boardId || !Number.isFinite(input.sceneVersion)) {
			return []
		}
		await this.ready
		const allowed = input.fileIds ? new Set(input.fileIds) : null
		const deleted = new Set(input.deletedFileIds ?? [])
		const removed: string[] = []
		for (const job of [...this.jobs.values()]) {
			if (allowed && !allowed.has(job.fileId)) continue
			if (job.sceneVersion > input.sceneVersion) continue
			const key = keyFor(job.boardId, job.fileId)
			await this.withLock(key, async () => {
				const current = this.jobs.get(key)
				if (!current || current.sceneVersion > input.sceneVersion) return
				if (deleted.has(current.fileId) || current.state === 'uploaded' && allowed?.has(current.fileId)) {
					if (!this.database) return
					await deleteJob(this.database, current.boardId, current.fileId)
					this.jobs.delete(key)
					removed.push(current.fileId)
				} else {
					const acknowledged = Math.max(
						current.sceneAcknowledgedVersion ?? 0,
						input.sceneVersion,
					)
					const next = { ...current, sceneAcknowledgedVersion: acknowledged, updatedAt: now() }
					this.jobs.set(key, next)
					await this.persist(next)
				}
				this.publish()
			})
		}
		return removed
	}

	async retry(fileId: string): Promise<WhiteboardUploadJob | null> {
		await this.ready
		const key = keyFor(this.boardId, fileId)
		const result = await this.withLock(key, async () => {
			const current = this.jobs.get(key)
			if (!current) return null
			if (current.state === 'uploaded') return cloneJob(current)
			const next = updateState(
				{
					...current,
					attempts: 0,
					nextAttemptAt: now(),
					lastAttemptAt: undefined,
					error: undefined,
				},
				'pending',
			)
			this.jobs.set(key, next)
			this.publish()
			await this.persist(next)
			return cloneJob(next)
		})
		if (result) void this.processKey(key)
		return result
	}

	async retryAll(): Promise<number> {
		await this.ready
		const ids = [...this.jobs.values()]
			.filter((job) => isWhiteboardUploadFailedState(job.state))
			.map((job) => job.fileId)
		for (const fileId of ids) await this.retry(fileId)
		return ids.length
	}

	/** Remove only local recovery state. This never issues a remote DELETE. */
	async remove(fileId: string, _options?: WhiteboardUploadRemoveOptions): Promise<boolean> {
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

	/** Wake auth-blocked jobs after a valid board auth/hello is available. */
	notifyAuthReady(): void {
		void this.resume(true)
	}

	notifyBoardHello(): void {
		void this.resume(true)
	}

	private async resume(retryAuth = false): Promise<void> {
		if (!this.database) return
		if (this.disposed) return
		const timestamp = now()
		if (retryAuth) {
			for (const job of this.jobs.values()) {
				if (job.state !== 'auth-blocked') continue
				const next = updateState(
					{ ...job, nextAttemptAt: timestamp, error: undefined },
					'pending',
				)
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
				(job.nextAttemptAt ?? 0) <= timestamp
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
		this.processing.add(key)
		try {
			let started: WhiteboardUploadJob | null = null
			try {
				started = await this.withLock(key, async () => {
					const current = this.jobs.get(key)
					if (
						!current ||
						(current.state !== 'pending' && current.state !== 'failed') ||
						(current.nextAttemptAt !== undefined && current.nextAttemptAt > now())
					) {
						return null
					}
					const next = updateState(
						{
							...current,
							attempts: current.attempts + 1,
							lastAttemptAt: now(),
							nextAttemptAt: undefined,
							error: undefined,
						},
						'uploading',
					)
					this.jobs.set(key, next)
					this.publish()
					await this.persist(next)
					return cloneJob(next)
				})
			} catch {
				return
			}
			if (!started) return

			try {
				await this.adapter({
					boardId: started.boardId,
					fileId: started.fileId,
					blob: started.blob,
					mimeType: started.mimeType,
				})
				await this.withLock(key, async () => {
					const current = this.jobs.get(key)
					if (!current || current.contentVersion !== started?.contentVersion) return
					if (
						current.sceneAcknowledgedVersion !== undefined &&
						current.sceneAcknowledgedVersion >= current.sceneVersion
					) {
						if (!this.database) return
						await deleteJob(this.database, current.boardId, current.fileId)
						this.jobs.delete(key)
						this.publish()
						return
					}
					const next = updateState(
						{ ...current, uploadedAt: now(), nextAttemptAt: undefined, error: undefined },
						'uploaded',
					)
					this.jobs.set(key, next)
					await this.persist(next)
					this.publish()
				})
			} catch (error) {
				const classification = classifyUploadFailure(error)
				await this.withLock(key, async () => {
					const current = this.jobs.get(key)
					if (!current || current.contentVersion !== started?.contentVersion) return
					const timestamp = now()
					const retryable = classification.state === 'failed'
					const next = updateState(
						{
							...current,
							nextAttemptAt: retryable
								? timestamp + retryDelayForAttempt(current.attempts)
								: undefined,
							error: {
								message: asMessage(error),
								kind: classification.kind,
								status: classification.status,
								updatedAt: timestamp,
							},
						},
						classification.state,
					)
					this.jobs.set(key, next)
					await this.persist(next)
					this.publish()
				})
			}
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
	stageUpload: (input: WhiteboardUploadStage) => Promise<WhiteboardUploadJob>
	waitForUpload: (
		fileId: string,
		timeoutMs?: number,
	) => Promise<WhiteboardUploadJob>
	getJob: (fileId: string) => WhiteboardUploadJob | null
	getUploadState: (fileId: string) => WhiteboardUploadState | null
	getPendingElementSnapshots: () => WhiteboardUploadRecovery[]
	getRecoveryData: () => WhiteboardUploadRecovery[]
	updateElementSnapshots: (
		fileId: string,
		input: WhiteboardUploadSceneSnapshot,
	) => Promise<WhiteboardUploadJob | null>
	markServerSceneHydrated: (
		input?: WhiteboardServerSceneHydration,
	) => Promise<string[]>
	resetServerSceneHydration: () => void
	markSceneAcknowledged: (
		input: WhiteboardSceneAcknowledgement,
	) => Promise<string[]>
	retryUpload: (fileId: string) => Promise<WhiteboardUploadJob | null>
	retryAllUploads: () => Promise<number>
	removeUpload: (
		fileId: string,
		options?: WhiteboardUploadRemoveOptions,
	) => Promise<boolean>
	notifyAuthReady: () => void
	notifyBoardHello: () => void
}

/** React-friendly public hook for the later WhiteboardCanvas integration. */
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
		stageUpload: outbox.stage.bind(outbox),
		waitForUpload: outbox.waitForUpload.bind(outbox),
		getJob: outbox.getJob.bind(outbox),
		getUploadState: (fileId) => outbox.getJob(fileId)?.state ?? null,
		getPendingElementSnapshots: outbox.getPendingElementSnapshots.bind(outbox),
		getRecoveryData: outbox.getRecoveryData.bind(outbox),
		updateElementSnapshots: outbox.updateElementSnapshots.bind(outbox),
		markServerSceneHydrated: outbox.markServerSceneHydrated.bind(outbox),
		resetServerSceneHydration: outbox.resetServerSceneHydration.bind(outbox),
		markSceneAcknowledged: outbox.markSceneAcknowledged.bind(outbox),
		retryUpload: outbox.retry.bind(outbox),
		retryAllUploads: outbox.retryAll.bind(outbox),
		removeUpload: outbox.remove.bind(outbox),
		notifyAuthReady: outbox.notifyAuthReady.bind(outbox),
		notifyBoardHello: outbox.notifyBoardHello.bind(outbox),
	}
}
