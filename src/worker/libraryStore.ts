/**
 * Server-only D1 store for signed-in whiteboard library metadata.
 *
 * D1 is authoritative after an owner's import marker is written.  The old
 * R2 index files are read only during that first import and are deliberately
 * never changed by this module.
 */

import { logWhiteboardStorageFailure } from './httpSecurity'

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const LIBRARY_IMPORT_VERSION = 1

export type LibraryBoard = {
	id: string
	title: string
	lastAccessedAt: string
	previewDataUrl?: string
}

export type LibraryAsset = {
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

export type LibraryStoreEnvironment = {
	WHITEBOARD_LIBRARY?: D1Database
	WHITEBOARD_ASSETS?: R2Bucket
}

export class LibraryStoreError extends Error {
	readonly kind: 'd1' | 'source' | 'configuration'

	constructor(
		message: string,
		kind: 'd1' | 'source' | 'configuration' = 'd1',
		options?: { cause?: unknown },
	) {
		super(message, options)
		this.name = 'LibraryStoreError'
		this.kind = kind
	}
}

type LibraryDatabase = {
	prepare(query: string): D1PreparedStatement
	batch(
		statements: D1PreparedStatement[],
	): Promise<D1Result<unknown>[]>
}

type BoardSourceEntry = {
	id: string
	title: string
	lastAccessedAt: string
	previewDataUrl?: string
}

type AssetSourceEntry = {
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

type BoardRow = {
	owner_key: string
	board_id: string
	title: string
	last_accessed_at: string
	preview_data_url: string | null
}

type AssetRow = {
	owner_key: string
	asset_id: string
	title: string
	created_at: string
	last_accessed_at: string
	mime_type: string
	size: number | null
	r2_key: string
	source_board_ids_json: string | null
}

type ImportMarkerRow = {
	owner_key: string
	imported_at: string
	import_version: number
}

const TRANSIENT_D1_ERROR =
	/\b(?:busy|locked|timeout|timed out|temporarily unavailable|overloaded|network|connection reset|service unavailable)\b|SQLITE_(?:BUSY|LOCKED)/i
const D1_RETRY_ATTEMPTS = 2
const D1_RETRY_DELAY_MS = 25
const LIBRARY_SOURCE_MAX_BYTES = 4 * 1024 * 1024

// A Worker isolate can service overlapping requests. This serializes work in
// one isolate as a latency optimization, but it is not a correctness barrier:
// D1 tombstones make delete-vs-import ordering safe across isolates too.
const ownerLocks = new Map<string, Promise<void>>()

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withOwnerLock<T>(
	ownerKey: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = ownerLocks.get(ownerKey) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	ownerLocks.set(ownerKey, current)
	await previous
	try {
		return await operation()
	} finally {
		release()
		if (ownerLocks.get(ownerKey) === current) ownerLocks.delete(ownerKey)
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	return String(error || 'Unknown D1 error')
}

function isTransientD1Error(error: unknown): boolean {
	return TRANSIENT_D1_ERROR.test(errorMessage(error))
}

async function runD1<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt < D1_RETRY_ATTEMPTS; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			const retryable = isTransientD1Error(error)
			logWhiteboardStorageFailure('d1', 'query', retryable)
			if (!retryable || attempt >= D1_RETRY_ATTEMPTS - 1) {
				break
			}
			await sleep(D1_RETRY_DELAY_MS)
		}
	}
	throw new LibraryStoreError(
		'D1 library storage is temporarily unavailable',
		'd1',
		{ cause: lastError },
	)
}

function databaseFrom(env: LibraryStoreEnvironment): D1Database {
	if (!env.WHITEBOARD_LIBRARY) {
		throw new LibraryStoreError(
			'D1 library storage is not configured',
			'configuration',
		)
	}
	return env.WHITEBOARD_LIBRARY
}

/** Keep marker/import/write reads on one sequentially consistent D1 session. */
function databaseSession(env: LibraryStoreEnvironment): LibraryDatabase {
	const database = databaseFrom(env)
	return typeof database.withSession === 'function'
		? database.withSession('first-primary')
		: database
}

async function runD1Batch(
	database: LibraryDatabase,
	statements: D1PreparedStatement[],
): Promise<void> {
	await runD1(() => database.batch(statements).then(() => undefined))
}

function bucketFrom(env: LibraryStoreEnvironment): R2Bucket {
	if (!env.WHITEBOARD_ASSETS) {
		throw new LibraryStoreError(
			'Library source storage is not configured',
			'configuration',
		)
	}
	return env.WHITEBOARD_ASSETS
}

function boardsObjectKey(ownerKey: string): string {
	return `library/${ownerKey}/boards.json`
}

function assetsObjectKey(ownerKey: string): string {
	return `library/${ownerKey}/assets.json`
}

// Keep the API/source representation intact, but only accept RFC 3339
// timestamps with exactly millisecond precision. Explicit calendar checks are
// required because Date.parse() normalizes impossible dates such as April 31
// instead of rejecting them. Millisecond precision also means SQLite's
// julianday() comparison cannot tie distinct sub-millisecond instants.
const ISO_TIMESTAMP_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|[+-]\d{2}:\d{2})$/

export function isLibraryTimestamp(value: unknown): value is string {
	if (typeof value !== 'string') return false
	const match = value.match(ISO_TIMESTAMP_RE)
	if (!match) return false
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const hour = Number(match[4])
	const minute = Number(match[5])
	const second = Number(match[6])
	const offset = match[8]
	const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3))
	const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6))
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1]
	return (
		month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth || 0) &&
		hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 &&
		second >= 0 && second <= 59 && offsetHour >= 0 && offsetHour <= 23 &&
		offsetMinute >= 0 && offsetMinute <= 59 &&
		Number.isFinite(Date.parse(value))
	)
}

export function isLibraryBoardEntry(value: unknown): value is BoardSourceEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.id === 'string' &&
		UUID_RE.test(entry.id) &&
		typeof entry.title === 'string' &&
		isLibraryTimestamp(entry.lastAccessedAt) &&
		(entry.previewDataUrl === undefined || typeof entry.previewDataUrl === 'string')
	)
}

export function isLibraryAssetEntry(value: unknown): value is AssetSourceEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.id === 'string' &&
		UUID_RE.test(entry.id) &&
		typeof entry.title === 'string' &&
		isLibraryTimestamp(entry.createdAt) &&
		isLibraryTimestamp(entry.lastAccessedAt) &&
		typeof entry.mimeType === 'string' &&
		typeof entry.r2Key === 'string' &&
		typeof entry.ownerKey === 'string' &&
		(entry.size === undefined ||
			(typeof entry.size === 'number' &&
				Number.isSafeInteger(entry.size) &&
				entry.size >= 0)) &&
		(entry.sourceBoardIds === undefined ||
			(Array.isArray(entry.sourceBoardIds) &&
				entry.sourceBoardIds.every((id) => typeof id === 'string')))
	)
}

function normalizeBoard(entry: BoardSourceEntry): LibraryBoard {
	return {
		id: entry.id,
		title: entry.title.trim() || 'Untitled board',
		lastAccessedAt: entry.lastAccessedAt,
		...(entry.previewDataUrl !== undefined
			? { previewDataUrl: entry.previewDataUrl }
			: {}),
	}
}

function normalizeAsset(
	entry: AssetSourceEntry,
	canonicalOwnerKey: string,
): LibraryAsset {
	return {
		id: entry.id,
		title: entry.title.trim() || 'Untitled asset',
		createdAt: entry.createdAt,
		lastAccessedAt: entry.lastAccessedAt,
		mimeType: entry.mimeType,
		...(entry.size !== undefined ? { size: entry.size } : {}),
		r2Key: entry.r2Key,
		// The logical D1 owner is canonical.  The original media owner is
		// recovered from r2Key when reading the DTO so legacy media remains
		// addressable after its index is imported.
		ownerKey: canonicalOwnerKey,
		...(entry.sourceBoardIds !== undefined
			? { sourceBoardIds: [...entry.sourceBoardIds] }
			: {}),
	}
}

function sourceError(message: string, cause?: unknown): LibraryStoreError {
	return new LibraryStoreError(message, 'source', { cause })
}

async function readSourceArray<T>(
	bucket: R2Bucket,
	key: string,
	guard: (value: unknown) => value is T,
	label: string,
): Promise<T[]> {
	let object: R2ObjectBody | null
	try {
		object = await bucket.get(key)
	} catch (error) {
		throw sourceError(`Could not read ${label} library source`, error)
	}
	if (!object) return []

	let parsed: unknown
	try {
		if (typeof object.size === 'number' && object.size > LIBRARY_SOURCE_MAX_BYTES) {
			throw sourceError(`Oversize ${label} library source`)
		}
		const body = object as R2ObjectBody & {
			arrayBuffer?: () => Promise<ArrayBuffer>
		}
		if (typeof body.arrayBuffer === 'function') {
			const bytes = await body.arrayBuffer()
			if (bytes.byteLength > LIBRARY_SOURCE_MAX_BYTES) {
				throw sourceError(`Oversize ${label} library source`)
			}
			parsed = JSON.parse(
				new TextDecoder('utf-8', { fatal: true }).decode(bytes),
			) as unknown
		} else {
			// R2ObjectBody.arrayBuffer() is required for a bounded read. A body
			// exposing only json() cannot be trusted to honor the source cap.
			throw sourceError(`Could not safely read ${label} library source`)
		}
	} catch (error) {
		if (error instanceof LibraryStoreError) throw error
		throw sourceError(`Malformed ${label} library source`, error)
	}
	if (!Array.isArray(parsed) || !parsed.every(guard)) {
		throw sourceError(`Malformed ${label} library source`)
	}
	return parsed
}

function mergeById<T extends { id: string }>(
	canonical: T[],
	legacy: T[],
): T[] {
	const merged: T[] = []
	const known = new Set<string>()
	for (const entry of canonical) {
		if (known.has(entry.id)) continue
		known.add(entry.id)
		merged.push(entry)
	}
	for (const entry of legacy) {
		if (known.has(entry.id)) continue
		known.add(entry.id)
		merged.push(entry)
	}
	return merged
}

async function sourceEntries(
	env: LibraryStoreEnvironment,
	canonicalOwnerKey: string,
	legacyOwnerKeys: string[],
): Promise<{ boards: LibraryBoard[]; assets: LibraryAsset[] }> {
	const bucket = bucketFrom(env)
	const ownerKeys = [...new Set([canonicalOwnerKey, ...legacyOwnerKeys])]
	const canonicalBoards = await readSourceArray(
		bucket,
		boardsObjectKey(canonicalOwnerKey),
		isLibraryBoardEntry,
		'board',
	)
	const canonicalAssets = await readSourceArray(
		bucket,
		assetsObjectKey(canonicalOwnerKey),
		isLibraryAssetEntry,
		'asset',
	)
	let legacyBoards: BoardSourceEntry[] = []
	let legacyAssets: AssetSourceEntry[] = []
	for (const ownerKey of ownerKeys.slice(1)) {
		legacyBoards = legacyBoards.concat(
			await readSourceArray(
				bucket,
				boardsObjectKey(ownerKey),
				isLibraryBoardEntry,
				'board',
			),
		)
		legacyAssets = legacyAssets.concat(
			await readSourceArray(
				bucket,
				assetsObjectKey(ownerKey),
				isLibraryAssetEntry,
				'asset',
			),
		)
	}

	return {
		boards: mergeById(
			canonicalBoards.map(normalizeBoard),
			legacyBoards.map(normalizeBoard),
		),
		assets: mergeById(
			canonicalAssets.map((entry) => normalizeAsset(entry, canonicalOwnerKey)),
			legacyAssets.map((entry) => normalizeAsset(entry, canonicalOwnerKey)),
		),
	}
}

function sourceOwnerFromR2Key(r2Key: string, fallback: string): string {
	if (!r2Key.startsWith('assets/')) return fallback
	const rest = r2Key.slice('assets/'.length)
	const slash = rest.lastIndexOf('/')
	if (slash <= 0) return fallback
	const ownerKey = rest.slice(0, slash)
	return ownerKey || fallback
}

function boardFromRow(row: BoardRow): LibraryBoard {
	return {
		id: row.board_id,
		title: row.title,
		lastAccessedAt: row.last_accessed_at,
		...(row.preview_data_url !== null
			? { previewDataUrl: row.preview_data_url }
			: {}),
	}
}

function parseSourceBoardIds(value: string | null): string[] | undefined {
	if (value === null) return undefined
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) {
			throw new Error('sourceBoardIds must be an array of strings')
		}
		return parsed
	} catch (error) {
		throw new LibraryStoreError(
			'Invalid asset sourceBoardIds in D1 library storage',
			'd1',
			{ cause: error },
		)
	}
}

function assetFromRow(row: AssetRow): LibraryAsset {
	const sourceBoardIds = parseSourceBoardIds(row.source_board_ids_json)
	return {
		id: row.asset_id,
		title: row.title,
		createdAt: row.created_at,
		lastAccessedAt: row.last_accessed_at,
		mimeType: row.mime_type,
		...(row.size !== null ? { size: row.size } : {}),
		r2Key: row.r2_key,
		ownerKey: sourceOwnerFromR2Key(row.r2_key, row.owner_key),
		...(sourceBoardIds !== undefined ? { sourceBoardIds } : {}),
	}
}

async function ownerIsImported(
	database: LibraryDatabase,
	ownerKey: string,
): Promise<boolean> {
	const marker = await runD1(() =>
		database
			.prepare(
				`SELECT owner_key, imported_at, import_version
				 FROM library_owner_imports
				 WHERE owner_key = ?
				 LIMIT 1`,
			)
			.bind(ownerKey)
			.first<ImportMarkerRow>(),
	)
	return marker !== null
}

async function insertBoard(
	database: LibraryDatabase,
	ownerKey: string,
	board: LibraryBoard,
): Promise<void> {
	await runD1(() =>
		database
			.prepare(
				`INSERT INTO library_boards
					(owner_key, board_id, title, last_accessed_at, preview_data_url)
				 SELECT ?, ?, ?, ?, ?
				 WHERE NOT EXISTS (
					 SELECT 1 FROM library_board_tombstones
					 WHERE owner_key = ? AND board_id = ?
				 )
					 ON CONFLICT(owner_key, board_id) DO UPDATE SET
						title = excluded.title,
					-- julianday() compares the validated RFC 3339 values by instant;
					-- retain the exact newer API/source string. This expression is
					-- evaluated atomically by SQLite's UPSERT across isolates.
					last_accessed_at = CASE
						WHEN julianday(library_boards.last_accessed_at) >= julianday(excluded.last_accessed_at)
						THEN library_boards.last_accessed_at
						ELSE excluded.last_accessed_at
					END,
					preview_data_url = CASE
						WHEN excluded.preview_data_url IS NULL
						THEN library_boards.preview_data_url
						ELSE excluded.preview_data_url
					END`,
			)
			.bind(
				ownerKey,
				board.id,
				board.title,
				board.lastAccessedAt,
				board.previewDataUrl ?? null,
				ownerKey,
				board.id,
			)
			.run(),
	)
}

async function insertAsset(
	database: LibraryDatabase,
	ownerKey: string,
	asset: LibraryAsset,
): Promise<void> {
	await runD1(() =>
		database
			.prepare(
				`INSERT INTO library_assets
					(owner_key, asset_id, title, created_at, last_accessed_at,
					 mime_type, size, r2_key, source_board_ids_json)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE NOT EXISTS (
					 SELECT 1 FROM library_asset_tombstones
					 WHERE owner_key = ? AND asset_id = ?
				 )
					 ON CONFLICT(owner_key, asset_id) DO UPDATE SET
					title = excluded.title,
					created_at = excluded.created_at,
					last_accessed_at = CASE
						WHEN julianday(library_assets.last_accessed_at) >= julianday(excluded.last_accessed_at)
						THEN library_assets.last_accessed_at
						ELSE excluded.last_accessed_at
					END,
					mime_type = excluded.mime_type,
					size = excluded.size,
					r2_key = excluded.r2_key,
					source_board_ids_json = excluded.source_board_ids_json`,
			)
			.bind(
				ownerKey,
				asset.id,
				asset.title,
				asset.createdAt,
				asset.lastAccessedAt,
				asset.mimeType,
				asset.size ?? null,
				asset.r2Key,
				asset.sourceBoardIds === undefined
					? null
					: JSON.stringify(asset.sourceBoardIds),
				ownerKey,
				asset.id,
			)
			.run(),
	)
}

async function restoreBoard(
	database: LibraryDatabase,
	ownerKey: string,
	board: LibraryBoard,
): Promise<void> {
	await runD1Batch(database, [
		database
			.prepare(
				`DELETE FROM library_board_tombstones
				 WHERE owner_key = ? AND board_id = ?`,
			)
			.bind(ownerKey, board.id),
		database
			.prepare(
				`INSERT INTO library_boards
					(owner_key, board_id, title, last_accessed_at, preview_data_url)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(owner_key, board_id) DO UPDATE SET
					title = excluded.title,
					last_accessed_at = CASE
						WHEN julianday(library_boards.last_accessed_at) >= julianday(excluded.last_accessed_at)
						THEN library_boards.last_accessed_at
						ELSE excluded.last_accessed_at
					END,
					preview_data_url = CASE
						WHEN excluded.preview_data_url IS NULL
						THEN library_boards.preview_data_url
						ELSE excluded.preview_data_url
					END`,
			)
			.bind(
				ownerKey,
				board.id,
				board.title,
				board.lastAccessedAt,
				board.previewDataUrl ?? null,
			),
	])
}

async function restoreAsset(
	database: LibraryDatabase,
	ownerKey: string,
	asset: LibraryAsset,
): Promise<void> {
	await runD1Batch(database, [
		database
			.prepare(
				`DELETE FROM library_asset_tombstones
				 WHERE owner_key = ? AND asset_id = ?`,
			)
			.bind(ownerKey, asset.id),
		database
			.prepare(
				`INSERT INTO library_assets
					(owner_key, asset_id, title, created_at, last_accessed_at,
					 mime_type, size, r2_key, source_board_ids_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(owner_key, asset_id) DO UPDATE SET
					title = excluded.title,
					created_at = excluded.created_at,
					last_accessed_at = CASE
						WHEN julianday(library_assets.last_accessed_at) >= julianday(excluded.last_accessed_at)
						THEN library_assets.last_accessed_at
						ELSE excluded.last_accessed_at
					END,
					mime_type = excluded.mime_type,
					size = excluded.size,
					r2_key = excluded.r2_key,
					source_board_ids_json = excluded.source_board_ids_json`,
			)
			.bind(
				ownerKey,
				asset.id,
				asset.title,
				asset.createdAt,
				asset.lastAccessedAt,
				asset.mimeType,
				asset.size ?? null,
				asset.r2Key,
				asset.sourceBoardIds === undefined
					? null
					: JSON.stringify(asset.sourceBoardIds),
			),
	])
}

/**
 * Import canonical and legacy R2 index files once for one logical owner.
 * Inserts are intentionally individual and idempotent: a failure after a
 * partial insert leaves no marker and a later request safely completes it.
 */
async function ensureOwnerImportedUnlocked(
	env: LibraryStoreEnvironment,
	canonicalOwnerKey: string,
	legacyOwnerKeys: string[] = [],
): Promise<void> {
	if (!canonicalOwnerKey) {
		throw new LibraryStoreError('Invalid library owner', 'configuration')
	}
	const database = databaseSession(env)
	if (await ownerIsImported(database, canonicalOwnerKey)) return

	// Validate and fully merge source files before touching D1. A malformed or
	// unreadable source therefore cannot erase or mark existing D1 data.
	const source = await sourceEntries(
		env,
		canonicalOwnerKey,
		legacyOwnerKeys.filter((key) => key && key !== canonicalOwnerKey),
	)
	for (const board of source.boards) {
		await insertBoard(database, canonicalOwnerKey, board)
	}
	for (const asset of source.assets) {
		await insertAsset(database, canonicalOwnerKey, asset)
	}
	await runD1(() =>
		database
			.prepare(
				`INSERT INTO library_owner_imports
					(owner_key, imported_at, import_version)
				 VALUES (?, ?, ?)
				 ON CONFLICT(owner_key) DO NOTHING`,
			)
			.bind(canonicalOwnerKey, new Date().toISOString(), LIBRARY_IMPORT_VERSION)
			.run(),
	)
}

export async function ensureOwnerImported(
	env: LibraryStoreEnvironment,
	canonicalOwnerKey: string,
	legacyOwnerKeys: string[] = [],
): Promise<void> {
	if (!canonicalOwnerKey) {
		throw new LibraryStoreError('Invalid library owner', 'configuration')
	}
	await withOwnerLock(canonicalOwnerKey, () =>
		ensureOwnerImportedUnlocked(env, canonicalOwnerKey, legacyOwnerKeys),
	)
}

export async function listLibraryBoards(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	legacyOwnerKeys: string[] = [],
): Promise<LibraryBoard[]> {
	return withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		const database = databaseSession(env)
		const result = await runD1(() =>
			database
				.prepare(
					`SELECT owner_key, board_id, title, last_accessed_at, preview_data_url
					 FROM library_boards
					 WHERE owner_key = ?
					   AND NOT EXISTS (
						 SELECT 1 FROM library_board_tombstones
						 WHERE owner_key = library_boards.owner_key
						   AND board_id = library_boards.board_id
					   )
					 ORDER BY julianday(last_accessed_at) DESC`,
				)
				.bind(ownerKey)
				.all<BoardRow>(),
		)
		return result.results.map(boardFromRow)
	})
}

export async function getLibraryBoard(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	boardId: string,
	legacyOwnerKeys: string[] = [],
): Promise<LibraryBoard | null> {
	return withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		const database = databaseSession(env)
		const row = await runD1(() =>
			database
				.prepare(
					`SELECT owner_key, board_id, title, last_accessed_at, preview_data_url
					 FROM library_boards
					 WHERE owner_key = ? AND board_id = ?
					   AND NOT EXISTS (
						 SELECT 1 FROM library_board_tombstones
						 WHERE owner_key = library_boards.owner_key
						   AND board_id = library_boards.board_id
					   )
					 LIMIT 1`,
				)
				.bind(ownerKey, boardId)
				.first<BoardRow>(),
		)
		return row ? boardFromRow(row) : null
	})
}

export async function upsertLibraryBoard(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	board: LibraryBoard,
	legacyOwnerKeys: string[] = [],
): Promise<void> {
	if (!isLibraryBoardEntry(board)) {
		throw new LibraryStoreError('Invalid board entry', 'configuration')
	}
	await withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		await restoreBoard(databaseSession(env), ownerKey, board)
	})
}

/** Update only an existing board; this function never inserts/recreates rows. */
export async function patchLibraryBoardPreview(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	boardId: string,
	previewDataUrl: string,
	legacyOwnerKeys: string[] = [],
): Promise<LibraryBoard | null> {
	return withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		const database = databaseSession(env)
		await runD1(() =>
			database
				.prepare(
					`UPDATE library_boards
					 SET preview_data_url = ?
					 WHERE owner_key = ? AND board_id = ?
					   AND NOT EXISTS (
						 SELECT 1 FROM library_board_tombstones
						 WHERE owner_key = library_boards.owner_key
						   AND board_id = library_boards.board_id
					   )`,
				)
				.bind(previewDataUrl, ownerKey, boardId)
				.run(),
		)
		const row = await runD1(() =>
			database
				.prepare(
					`SELECT owner_key, board_id, title, last_accessed_at, preview_data_url
					 FROM library_boards
					 WHERE owner_key = ? AND board_id = ?
					   AND NOT EXISTS (
						 SELECT 1 FROM library_board_tombstones
						 WHERE owner_key = library_boards.owner_key
						   AND board_id = library_boards.board_id
					   )
					 LIMIT 1`,
				)
				.bind(ownerKey, boardId)
				.first<BoardRow>(),
		)
		return row ? boardFromRow(row) : null
	})
}

export async function deleteLibraryBoard(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	boardId: string,
	legacyOwnerKeys: string[] = [],
): Promise<void> {
	await withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		const database = databaseSession(env)
		await runD1Batch(database, [
			database
				.prepare(
					`INSERT INTO library_board_tombstones
						(owner_key, board_id, deleted_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(owner_key, board_id) DO UPDATE SET
						deleted_at = excluded.deleted_at`,
				)
				.bind(ownerKey, boardId, new Date().toISOString()),
			database
				.prepare(
					`DELETE FROM library_boards
					 WHERE owner_key = ? AND board_id = ?`,
				)
				.bind(ownerKey, boardId),
		])
	})
}

export async function listLibraryAssets(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	legacyOwnerKeys: string[] = [],
): Promise<LibraryAsset[]> {
	return withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		const database = databaseSession(env)
		const result = await runD1(() =>
			database
				.prepare(
					`SELECT owner_key, asset_id, title, created_at, last_accessed_at,
							mime_type, size, r2_key, source_board_ids_json
					 FROM library_assets
					 WHERE owner_key = ?
					   AND NOT EXISTS (
						 SELECT 1 FROM library_asset_tombstones
						 WHERE owner_key = library_assets.owner_key
						   AND asset_id = library_assets.asset_id
					   )
					 ORDER BY julianday(last_accessed_at) DESC`,
				)
				.bind(ownerKey)
				.all<AssetRow>(),
		)
		return result.results.map(assetFromRow)
	})
}

export async function upsertLibraryAsset(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	asset: LibraryAsset,
	legacyOwnerKeys: string[] = [],
): Promise<void> {
	if (!isLibraryAssetEntry(asset)) {
		throw new LibraryStoreError('Invalid asset entry', 'configuration')
	}
	await withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		await restoreAsset(databaseSession(env), ownerKey, asset)
	})
}

export async function deleteLibraryAsset(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	assetId: string,
	legacyOwnerKeys: string[] = [],
): Promise<void> {
	await withOwnerLock(ownerKey, async () => {
		await ensureOwnerImportedUnlocked(env, ownerKey, legacyOwnerKeys)
		const database = databaseSession(env)
		await runD1Batch(database, [
			database
				.prepare(
					`INSERT INTO library_asset_tombstones
						(owner_key, asset_id, deleted_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(owner_key, asset_id) DO UPDATE SET
						deleted_at = excluded.deleted_at`,
				)
				.bind(ownerKey, assetId, new Date().toISOString()),
			database
				.prepare(
					`DELETE FROM library_assets
					 WHERE owner_key = ? AND asset_id = ?`,
				)
				.bind(ownerKey, assetId),
		])
	})
}

export type LibraryExportKind = 'boards' | 'assets'

export type LibraryExportCursor = {
	ownerKey: string
	id: string
}

export type LibraryExportPage = {
	kind: LibraryExportKind
	rows: Array<(LibraryBoard | LibraryAsset) & { ownerKey: string }>
	nextCursor: LibraryExportCursor | null
}

export type LibraryOperatorImportResult = {
	inserted: number
	conflicts: number
	tombstoned: number
}

const IMPORTABLE_OWNER_KEY_RE = /^google:[A-Za-z0-9_.:@-]{1,128}$/

/** Operator imports are restricted to well-formed source owner keys. */
export function isImportableOwnerKey(ownerKey: string): boolean {
	return IMPORTABLE_OWNER_KEY_RE.test(ownerKey)
}

async function operatorInsertBoard(
	database: LibraryDatabase,
	ownerKey: string,
	board: LibraryBoard,
): Promise<number> {
	const result = await runD1(() =>
		database
			.prepare(
				`INSERT INTO library_boards
					(owner_key, board_id, title, last_accessed_at, preview_data_url)
				 SELECT ?, ?, ?, ?, ?
				 WHERE NOT EXISTS (
					 SELECT 1 FROM library_board_tombstones
					 WHERE owner_key = ? AND board_id = ?
				 )
				 ON CONFLICT(owner_key, board_id) DO NOTHING`,
			)
			.bind(
				ownerKey,
				board.id,
				board.title,
				board.lastAccessedAt,
				board.previewDataUrl ?? null,
				ownerKey,
				board.id,
			)
			.run(),
	)
	return result.meta.changes
}

async function operatorInsertAsset(
	database: LibraryDatabase,
	ownerKey: string,
	asset: LibraryAsset,
): Promise<number> {
	const result = await runD1(() =>
		database
			.prepare(
				`INSERT INTO library_assets
					(owner_key, asset_id, title, created_at, last_accessed_at,
					 mime_type, size, r2_key, source_board_ids_json)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE NOT EXISTS (
					 SELECT 1 FROM library_asset_tombstones
					 WHERE owner_key = ? AND asset_id = ?
				 )
				 ON CONFLICT(owner_key, asset_id) DO NOTHING`,
			)
			.bind(
				ownerKey,
				asset.id,
				asset.title,
				asset.createdAt,
				asset.lastAccessedAt,
				asset.mimeType,
				asset.size ?? null,
				asset.r2Key,
				asset.sourceBoardIds === undefined
					? null
					: JSON.stringify(asset.sourceBoardIds),
				ownerKey,
				asset.id,
			)
			.run(),
	)
	return result.meta.changes
}

async function operatorTombstoneExists(
	database: LibraryDatabase,
	table: 'library_board_tombstones' | 'library_asset_tombstones',
	ownerKey: string,
	id: string,
): Promise<boolean> {
	const column = table === 'library_board_tombstones' ? 'board_id' : 'asset_id'
	const row = await runD1(() =>
		database
			.prepare(
				`SELECT 1 AS present FROM ${table}
				 WHERE owner_key = ? AND ${column} = ? LIMIT 1`,
			)
			.bind(ownerKey, id)
			.first<{ present: number }>(),
	)
	return row !== null
}

/**
 * Insert an operator-verified page without changing existing D1 rows. This is
 * deliberately marker-free: a global R2 scan cannot distinguish a canonical
 * Google owner from a legacy Clerk-user fallback. Only an authenticated lazy
 * import with both identities may finalize the owner marker.
 */
export async function importLibraryRows(
	env: LibraryStoreEnvironment,
	ownerKey: string,
	boards: LibraryBoard[],
	assets: LibraryAsset[],
): Promise<LibraryOperatorImportResult> {
	if (!isImportableOwnerKey(ownerKey)) {
		throw new LibraryStoreError('Unresolved library owner identity', 'configuration')
	}
	if (
		!boards.every(isLibraryBoardEntry) ||
		!assets.every(
			(entry) => isLibraryAssetEntry(entry) && entry.ownerKey === ownerKey,
		)
	) {
		throw new LibraryStoreError('Invalid library import row', 'configuration')
	}
	return withOwnerLock(ownerKey, async () => {
		const database = databaseSession(env)

		let inserted = 0
		let conflicts = 0
		let tombstoned = 0
		for (const board of boards) {
			if (await operatorTombstoneExists(database, 'library_board_tombstones', ownerKey, board.id)) {
				tombstoned += 1
				continue
			}
			if (await operatorInsertBoard(database, ownerKey, board)) inserted += 1
			else conflicts += 1
		}
		for (const asset of assets) {
			if (await operatorTombstoneExists(database, 'library_asset_tombstones', ownerKey, asset.id)) {
				tombstoned += 1
				continue
			}
			if (await operatorInsertAsset(database, ownerKey, asset)) inserted += 1
			else conflicts += 1
		}
		return {
			inserted,
			conflicts,
			tombstoned,
		}
	})
}

export async function exportLibraryPage(
	env: LibraryStoreEnvironment,
	options: {
		kind: LibraryExportKind
		ownerKey?: string
		cursor?: LibraryExportCursor | null
		limit?: number
	},
): Promise<LibraryExportPage> {
	const kind = options.kind
	const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 25)))
	const database = databaseSession(env)
	const cursor = options.cursor ?? null
	const idColumn = kind === 'boards' ? 'board_id' : 'asset_id'
	const table = kind === 'boards' ? 'library_boards' : 'library_assets'
	const tombstones =
		kind === 'boards'
			? 'library_board_tombstones'
			: 'library_asset_tombstones'
	const select =
		kind === 'boards'
			? 'owner_key, board_id, title, last_accessed_at, preview_data_url'
			: 'owner_key, asset_id, title, created_at, last_accessed_at, mime_type, size, r2_key, source_board_ids_json'
	const where: string[] = [
		`NOT EXISTS (
			SELECT 1 FROM ${tombstones} t
			WHERE t.owner_key = ${table}.owner_key
			  AND t.${idColumn} = ${table}.${idColumn}
		)`,
	]
	const values: unknown[] = []
	if (options.ownerKey) {
		where.push('owner_key = ?')
		values.push(options.ownerKey)
	}
	if (cursor) {
		where.push(`(owner_key > ? OR (owner_key = ? AND ${idColumn} > ?))`)
		values.push(cursor.ownerKey, cursor.ownerKey, cursor.id)
	}
	const result = await runD1(() =>
		database
			.prepare(
				`SELECT ${select}
				 FROM ${table}
				 WHERE ${where.join(' AND ')}
				 ORDER BY owner_key ASC, ${idColumn} ASC
				 LIMIT ?`,
			)
			.bind(...values, limit)
			.all<BoardRow & AssetRow>(),
	)
	const rows = result.results.map((row) => {
		if (kind === 'boards') {
			return { ownerKey: row.owner_key, ...boardFromRow(row as BoardRow) }
		}
		// The DTO ownerKey is normally derived from the media key for legacy
		// reads. Exports must retain the authoritative D1 owner instead.
		return { ...assetFromRow(row as AssetRow), ownerKey: row.owner_key }
	}) as LibraryExportPage['rows']
	const last = result.results[result.results.length - 1]
	return {
		kind,
		rows,
		nextCursor:
			result.results.length === limit && last
				? { ownerKey: last.owner_key, id: last[idColumn] as string }
				: null,
	}
}

/**
 * Membership used by Durable Objects when inferring an Owner from Clerk.
 * Passing candidate owner keys in canonical-first order keeps the same
 * canonical/legacy import semantics as authenticated library routes.
 */
export async function libraryContainsBoard(
	env: LibraryStoreEnvironment,
	ownerKeys: string | string[],
	boardId: string,
): Promise<boolean> {
	const keys = Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys]
	const [canonical, ...legacy] = [...new Set(keys.filter(Boolean))]
	if (!canonical || !boardId) return false
	const board = await getLibraryBoard(env, canonical, boardId, legacy)
	return board !== null
}

// Concise aliases make the store useful to migration/route tests without
// exposing its SQL implementation as part of the public Worker API.
export const listBoards = listLibraryBoards
export const getBoard = getLibraryBoard
export const upsertBoard = upsertLibraryBoard
export const patchBoardPreview = patchLibraryBoardPreview
export const deleteBoard = deleteLibraryBoard
export const listAssets = listLibraryAssets
export const upsertAsset = upsertLibraryAsset
export const deleteAsset = deleteLibraryAsset
export const containsBoard = libraryContainsBoard
