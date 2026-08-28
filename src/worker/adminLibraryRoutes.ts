/**
 * Authenticated operator surface for the R2-library/D1 cutover.
 *
 * This route is intentionally separate from normal library CRUD. It only
 * reads exact R2 index objects, imports verified rows into D1, or exports
 * live D1 rows. It never writes R2, Durable Objects, or KV.
 */
import {
	bearerMatchesSecret,
	isAllowedOrigin,
	jsonHeaders,
	jsonResponse,
	logWhiteboardStorageFailure,
} from './httpSecurity'
import {
	exportLibraryPage,
	importLibraryRows,
	isImportableOwnerKey,
	type LibraryAsset,
	type LibraryBoard,
	type LibraryExportCursor,
	LibraryStoreError,
	isLibraryAssetEntry,
	isLibraryBoardEntry,
} from './libraryStore'

const ADMIN_LIBRARY_PATH = '/api/whiteboard/admin/library'
const MAX_R2_PAGE = 25
const MAX_BODY_BYTES = 256 * 1024
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_IMPORT_OBJECTS = 25
const SHA256_RE = /^[0-9a-f]{64}$/i
const ETAG_MAX_LENGTH = 256
const EXACT_INDEX_RE = /^library\/([^/]+)\/(boards|assets)\.json$/

type IndexKind = 'boards' | 'assets'

type IndexSummary = {
	key: string
	ownerKeyHash: string
	kind: IndexKind
	size: number | null
	etag: string | null
	sha256: string | null
	version: number | null
	valid: boolean
	entryCount: number
	invalidEntryCount: number
	duplicateCount: number
	duplicateIds: string[]
	reasonCodes: string[]
}

type InspectedIndex = {
	summary: IndexSummary
	boards: LibraryBoard[]
	assets: LibraryAsset[]
}

type ScanBody = {
	operation?: unknown
	cursor?: unknown
}

type ImportBody = {
	operation?: unknown
	objects?: unknown
}

type ExportBody = {
	operation?: unknown
	kind?: unknown
	ownerKey?: unknown
	limit?: unknown
	cursor?: unknown
}

function bodyError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), { status })
}

function json(status: number, body: unknown, request: Request): Response {
	return jsonResponse(request, status, body, {
		methods: 'POST, OPTIONS',
	})
}

function routeMatch(pathname: string): 'scan' | 'import' | 'export' | null {
	if (pathname === ADMIN_LIBRARY_PATH) return null
	const match = pathname.match(
		/^\/api\/whiteboard\/admin\/library\/(scan|import|export)\/?$/i,
	)
	return match ? (match[1].toLowerCase() as 'scan' | 'import' | 'export') : null
}

function isAdminLibraryPath(pathname: string): boolean {
	return (
		pathname === ADMIN_LIBRARY_PATH ||
		routeMatch(pathname) !== null ||
		pathname.startsWith(`${ADMIN_LIBRARY_PATH}/`)
	)
}

function parseOperation(body: unknown, pathOperation: 'scan' | 'import' | 'export' | null): string {
	if (pathOperation) return pathOperation
	if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
	const operation = (body as Record<string, unknown>).operation
	return typeof operation === 'string' ? operation.trim().toLowerCase() : ''
}

async function readJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get('Content-Type')?.toLowerCase() || ''
	if (!contentType.startsWith('application/json')) {
		throw bodyError(415, 'Content-Type must be application/json')
	}
	const declared = Number(request.headers.get('Content-Length') || '')
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw bodyError(413, 'Request body too large')
	}
	const reader = request.body?.getReader()
	let text = ''
	if (reader) {
		const chunks: Uint8Array[] = []
		let total = 0
		try {
			while (true) {
				const next = await reader.read()
				if (next.done) break
				total += next.value.byteLength
				if (total > MAX_BODY_BYTES) {
					await reader.cancel()
					throw bodyError(413, 'Request body too large')
				}
				chunks.push(next.value)
			}
		} catch (error) {
			if (error instanceof Response) throw error
			throw bodyError(400, 'Invalid JSON body')
		}
		const bytes = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		} catch {
			throw bodyError(400, 'Invalid JSON body')
		}
	}
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		})
	}
}

function parseScanCursor(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null
	return typeof value === 'string' && value.length <= 512 ? value : null
}

function exactIndexKey(key: string): { ownerKey: string; kind: IndexKind } | null {
	const match = key.match(EXACT_INDEX_RE)
	if (!match) return null
	return { ownerKey: match[1], kind: match[2] as IndexKind }
}

function uniqueReasons(reasons: string[]): string[] {
	return [...new Set(reasons)]
}

function duplicateIds(entries: unknown[]): string[] {
	const seen = new Set<string>()
	const duplicates = new Set<string>()
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const id = (entry as Record<string, unknown>).id
		if (typeof id !== 'string') continue
		if (seen.has(id)) duplicates.add(id)
		seen.add(id)
	}
	return [...duplicates]
}

function parseIndexPayload(
	kind: IndexKind,
	value: unknown,
	ownerKey: string,
): {
	version: number | null
	entries: unknown[]
	reasonCodes: string[]
	duplicateIds: string[]
	boards: LibraryBoard[]
	assets: LibraryAsset[]
} {
	let version: number | null = 1
	let rawEntries: unknown = value
	const reasons: string[] = []
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		version = typeof record.version === 'number' ? record.version : null
		rawEntries = record[kind]
		if (version !== 1) reasons.push('invalid_version')
	}
	if (!Array.isArray(rawEntries)) {
		return {
			version,
			entries: [],
			reasonCodes: uniqueReasons([...reasons, 'not_array']),
			duplicateIds: [],
			boards: [],
			assets: [],
		}
	}
	const duplicates = duplicateIds(rawEntries)
	if (duplicates.length > 0) reasons.push('duplicate_id')
	const validEntries = kind === 'boards'
		? rawEntries.filter(isLibraryBoardEntry)
		: rawEntries.filter((entry) =>
			isLibraryAssetEntry(entry) &&
			(entry as { ownerKey: string }).ownerKey === ownerKey,
		)
	if (validEntries.length !== rawEntries.length) {
		reasons.push(
			kind === 'assets' ? 'invalid_entry_or_owner' : 'invalid_entry',
		)
	}
	return {
		version,
		entries: rawEntries,
		reasonCodes: uniqueReasons(reasons),
		duplicateIds: duplicates,
		boards: kind === 'boards' ? (validEntries as LibraryBoard[]) : [],
		assets: kind === 'assets' ? (validEntries as LibraryAsset[]) : [],
	}
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function inspectObject(
	bucket: R2Bucket,
	key: string,
	ownerKey: string,
	kind: IndexKind,
): Promise<InspectedIndex> {
	const base: IndexSummary = {
		key,
		ownerKeyHash: await sha256Hex(new TextEncoder().encode(ownerKey)),
		kind,
		size: null,
		etag: null,
		sha256: null,
		version: null,
		valid: false,
		entryCount: 0,
		invalidEntryCount: 0,
		duplicateCount: 0,
		duplicateIds: [],
		reasonCodes: [],
	}
	let object: R2ObjectBody | null
	try {
		object = await bucket.get(key)
	} catch {
		logWhiteboardStorageFailure('r2', 'read', true)
		base.reasonCodes = ['r2_read_error']
		return { summary: base, boards: [], assets: [] }
	}
	if (!object) {
		base.reasonCodes = ['missing_object']
		return { summary: base, boards: [], assets: [] }
	}
	base.size = typeof object.size === 'number' ? object.size : null
	base.etag = object.etag || null
	if (base.size !== null && base.size > MAX_INDEX_BYTES) {
		base.reasonCodes = ['oversize']
		return { summary: base, boards: [], assets: [] }
	}
	let bytes: ArrayBuffer
	let parsed: unknown
	try {
		bytes = await object.arrayBuffer()
		if (bytes.byteLength > MAX_INDEX_BYTES) {
			base.size = bytes.byteLength
			base.reasonCodes = ['oversize']
			return { summary: base, boards: [], assets: [] }
		}
		base.size = bytes.byteLength
		base.sha256 = await sha256Hex(bytes)
	} catch {
		logWhiteboardStorageFailure('r2', 'read', true)
		base.reasonCodes = ['r2_read_error']
		return { summary: base, boards: [], assets: [] }
	}
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
	} catch {
		base.reasonCodes = ['invalid_json']
		return { summary: base, boards: [], assets: [] }
	}
	const inspection = parseIndexPayload(kind, parsed, ownerKey)
	base.version = inspection.version
	base.entryCount = inspection.entries.length
	const validEntryCount = kind === 'boards' ? inspection.boards.length : inspection.assets.length
	base.invalidEntryCount = inspection.entries.length - validEntryCount
	base.duplicateIds = inspection.duplicateIds
	base.duplicateCount = inspection.duplicateIds.length
	base.reasonCodes = inspection.reasonCodes
	base.valid = base.reasonCodes.length === 0
	return { summary: base, boards: inspection.boards, assets: inspection.assets }
}

async function scan(
	env: Env,
	body: ScanBody,
	request: Request,
): Promise<Response> {
	if (!env.WHITEBOARD_ASSETS) return json(503, { error: 'R2 library storage is not configured' }, request)
	const rawCursor = parseScanCursor(body.cursor)
	if (body.cursor !== undefined && body.cursor !== null && body.cursor !== '' && rawCursor === null) {
		return json(400, { error: 'Invalid scan cursor' }, request)
	}
	let listed: R2Objects
	try {
		listed = await env.WHITEBOARD_ASSETS.list({
			prefix: 'library/',
			limit: MAX_R2_PAGE,
			...(rawCursor ? { cursor: rawCursor } : {}),
		})
	} catch {
		logWhiteboardStorageFailure('r2', 'list', true)
		return json(503, { error: 'R2 library storage is temporarily unavailable' }, request)
	}
	const objects: IndexSummary[] = []
	let ignoredObjects = 0
	for (const listedObject of listed.objects) {
		const exact = exactIndexKey(listedObject.key)
		if (!exact) {
			ignoredObjects += 1
			continue
		}
		const inspected = await inspectObject(
			env.WHITEBOARD_ASSETS,
			listedObject.key,
			exact.ownerKey,
			exact.kind,
		)
		if (inspected.summary.reasonCodes.includes('r2_read_error')) {
			return json(503, { error: 'R2 library storage is temporarily unavailable' }, request)
		}
		if (inspected.summary.reasonCodes.includes('missing_object')) {
			return json(409, {
				error: 'R2 source changed; rescan before continuing',
				reasonCodes: ['source_drift'],
			}, request)
		}
		objects.push(inspected.summary)
	}
	const validObjects = objects.filter((object) => object.valid).length
	const invalidObjects = objects.length - validObjects
	const duplicateCount = objects.reduce((sum, object) => sum + object.duplicateCount, 0)
	return json(200, {
		operation: 'scan',
		objects,
		manifest: objects,
		counts: {
			listed: listed.objects.length,
			matched: objects.length,
			ignored: ignoredObjects,
			valid: validObjects,
			invalid: invalidObjects,
			duplicates: duplicateCount,
		},
		nextCursor: listed.truncated ? listed.cursor || null : null,
		done: !listed.truncated,
	}, request)
}

function parseImportObjects(value: unknown): Array<{ key: string; etag: string; sha256: string }> | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMPORT_OBJECTS) return null
	const keys = new Set<string>()
	const objects: Array<{ key: string; etag: string; sha256: string }> = []
	for (const item of value) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return null
		const record = item as Record<string, unknown>
		if (
			typeof record.key !== 'string' ||
			typeof record.etag !== 'string' ||
			typeof record.sha256 !== 'string' ||
			record.etag.length === 0 ||
			record.key.length > 512 ||
			record.etag.length > ETAG_MAX_LENGTH ||
			!SHA256_RE.test(record.sha256) ||
			keys.has(record.key)
		) return null
		if (!exactIndexKey(record.key)) return null
		objects.push({ key: record.key, etag: record.etag, sha256: record.sha256.toLowerCase() })
	}
	return objects
}

async function importIndexes(
	env: Env,
	body: ImportBody,
	request: Request,
): Promise<Response> {
	if (!env.WHITEBOARD_ASSETS || !env.WHITEBOARD_LIBRARY) {
		return json(503, { error: 'Library storage is not configured' }, request)
	}
	const objects = parseImportObjects(body.objects)
	if (!objects) return json(400, { error: 'objects must contain 1-25 exact scan manifest entries' }, request)
	const inspected = [] as Array<{
		manifest: { key: string; etag: string; sha256: string }
		index: InspectedIndex
		ownerKey: string
		kind: IndexKind
	}>
	for (const manifest of objects) {
		const exact = exactIndexKey(manifest.key)!
		if (!isImportableOwnerKey(exact.ownerKey)) {
			return json(422, { error: 'Unresolved owner identity', reasonCodes: ['unresolved_owner'] }, request)
		}
		const index = await inspectObject(
			env.WHITEBOARD_ASSETS,
			manifest.key,
			exact.ownerKey,
			exact.kind,
		)
		if (index.summary.reasonCodes.includes('r2_read_error')) {
			return json(503, { error: 'R2 library storage is temporarily unavailable' }, request)
		}
		if (
			index.summary.etag !== manifest.etag ||
			index.summary.sha256 !== manifest.sha256
		) {
			return json(409, {
				error: 'R2 source changed; rescan before importing',
				reasonCodes: ['source_drift'],
				key: manifest.key,
			}, request)
		}
		if (!index.summary.valid) {
			return json(422, {
				error: 'R2 source failed validation',
				reasonCodes: index.summary.reasonCodes,
				key: manifest.key,
			}, request)
		}
		inspected.push({ manifest, index, ownerKey: exact.ownerKey, kind: exact.kind })
	}

	const grouped = new Map<string, { boards: LibraryBoard[]; assets: LibraryAsset[] }>()
	for (const item of inspected) {
		const current = grouped.get(item.ownerKey) || { boards: [], assets: [] }
		if (item.kind === 'boards') current.boards.push(...item.index.boards)
		else current.assets.push(...item.index.assets)
		grouped.set(item.ownerKey, current)
	}
	const ownerResults: Array<Record<string, unknown>> = []
	for (const [ownerKey, rows] of grouped) {
		try {
			const result = await importLibraryRows(env, ownerKey, rows.boards, rows.assets)
			ownerResults.push({ ownerKeyHash: await sha256Hex(new TextEncoder().encode(ownerKey)), ...result })
		} catch (error) {
			if (error instanceof LibraryStoreError) return json(503, { error: error.message }, request)
			return json(503, { error: 'D1 library storage is temporarily unavailable' }, request)
		}
	}
	return json(200, {
		operation: 'import',
		objects: inspected.map(({ manifest, index }) => ({
			key: manifest.key,
			etag: manifest.etag,
			sha256: manifest.sha256,
			entryCount: index.summary.entryCount,
		})),
		owners: ownerResults,
	}, request)
}

function parseExportCursor(value: unknown): LibraryExportCursor | null | 'invalid' {
	if (value === undefined || value === null || value === '') return null
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
	const record = value as Record<string, unknown>
	if (
		typeof record.ownerKey !== 'string' ||
		typeof record.id !== 'string' ||
		record.ownerKey.length > 256 ||
		record.id.length > 128
	) return 'invalid'
	return { ownerKey: record.ownerKey, id: record.id }
}

async function exportRows(
	env: Env,
	body: ExportBody,
	request: Request,
): Promise<Response> {
	if (!env.WHITEBOARD_LIBRARY) return json(503, { error: 'D1 library storage is not configured' }, request)
	const kind = body.kind === 'assets' ? 'assets' : body.kind === 'boards' ? 'boards' : ''
	if (!kind) return json(400, { error: 'kind must be boards or assets' }, request)
	if (body.ownerKey !== undefined && (typeof body.ownerKey !== 'string' || body.ownerKey.length > 256)) {
		return json(400, { error: 'Invalid ownerKey' }, request)
	}
	const cursor = parseExportCursor(body.cursor)
	if (cursor === 'invalid') return json(400, { error: 'Invalid export cursor' }, request)
	const limit = body.limit === undefined ? 25 : Number(body.limit)
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) return json(400, { error: 'limit must be an integer from 1 to 25' }, request)
	try {
		const page = await exportLibraryPage(env, {
			kind,
			ownerKey: typeof body.ownerKey === 'string' ? body.ownerKey : undefined,
			cursor,
			limit,
		})
		return json(200, {
			operation: 'export',
			kind,
			rows: page.rows,
			nextCursor: page.nextCursor,
			done: page.nextCursor === null,
		}, request)
	} catch (error) {
		if (error instanceof LibraryStoreError) return json(503, { error: error.message }, request)
		return json(503, { error: 'D1 library storage is temporarily unavailable' }, request)
	}
}

export async function handleAdminLibraryRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (!isAdminLibraryPath(url.pathname)) return null
	const pathOperation = routeMatch(url.pathname)
	if (url.pathname !== ADMIN_LIBRARY_PATH && pathOperation === null) {
		return json(404, { error: 'Not found' }, request)
	}
	const origin = request.headers.get('Origin')?.trim()
	if (origin && !isAllowedOrigin(origin)) return json(403, { error: 'Origin not allowed' }, request)
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: jsonHeaders(request, { methods: 'POST, OPTIONS', maxAge: 86400 }),
		})
	}
	if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, request)
	if (!env.WHITEBOARD_ADMIN_SECRET?.trim()) {
		return json(503, { error: 'Admin library tooling is not configured' }, request)
	}
	if (!bearerMatchesSecret(request, env.WHITEBOARD_ADMIN_SECRET)) {
		return json(401, { error: 'Unauthorized' }, request)
	}
	let body: unknown
	try {
		body = await readJsonBody(request)
	} catch (error) {
		if (error instanceof Response) return new Response(error.body, { status: error.status, headers: jsonHeaders(request, { methods: 'POST, OPTIONS' }) })
		return json(400, { error: 'Invalid JSON body' }, request)
	}
	const operation = parseOperation(body, pathOperation)
	if (operation === 'scan') return scan(env, (body || {}) as ScanBody, request)
	if (operation === 'import') return importIndexes(env, (body || {}) as ImportBody, request)
	if (operation === 'export') return exportRows(env, (body || {}) as ExportBody, request)
	return json(400, { error: 'operation must be scan, import, or export' }, request)
}
