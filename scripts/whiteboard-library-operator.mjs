#!/usr/bin/env node

/**
 * Bounded operator client for the R2-library/D1 cutover.
 *
 * The CLI only talks to the authenticated admin HTTP surface. It never writes
 * R2, and it keeps the admin secret in an Authorization header only.
 */
import { access, appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

export const ADMIN_PATH = '/api/whiteboard/admin/library'
export const PAGE_LIMIT = 25
export const MAX_RETRIES = 3
const EXPORT_PHASES = new Set(['fetching', 'publishing', 'complete'])
const EXPORT_OPERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_EXPORT_PAGES = 1_000_000
const MAX_EXPORT_FILES = 1_000_000
const MAX_EXPORT_CURSOR_BYTES = 1024
const EXPORT_MARKER_MAX_BYTES = 8192
const SCAN_CURSOR_MAX_BYTES = 512
const MAX_SCAN_RESPONSE_BYTES = 512 * 1024
const MAX_SCAN_PAGES = 1_000_000
const MAX_SCAN_DIAGNOSTIC_ITEMS = 4096
const MAX_SCAN_REASON_LENGTH = 64
const MAX_SCAN_COUNT = Number.MAX_SAFE_INTEGER
const EXACT_INDEX_RE = /^library\/([^/]+)\/(boards|assets)\.json$/

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function valueAfter(argv, index, option) {
	const value = argv[index + 1]
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
	return value
}

/** Parse safe, non-secret CLI options. --secret is intentionally rejected. */
export function parseArgs(argv) {
	const [command = ''] = argv
	if (!['scan', 'import', 'export'].includes(command)) {
		throw new Error('Usage: whiteboard-library-operator.mjs scan|import|export [options]')
	}
	const options = {
		command,
		baseUrl: process.env.WHITEBOARD_OPERATOR_URL || 'https://scsfoxchase-tech.dimitri-meimaridis.workers.dev',
		manifestPath: 'whiteboard-library-manifest.json',
		checkpointPath: null,
		outputPath: null,
		ownerKey: undefined,
		limit: PAGE_LIMIT,
		confirmImport: false,
	}
	for (let index = 1; index < argv.length; index += 1) {
		const option = argv[index]
		switch (option) {
			case '--base-url':
				options.baseUrl = valueAfter(argv, index++, option)
				break
			case '--manifest':
				options.manifestPath = valueAfter(argv, index++, option)
				break
			case '--checkpoint':
				options.checkpointPath = valueAfter(argv, index++, option)
				break
			case '--output':
				options.outputPath = valueAfter(argv, index++, option)
				break
			case '--owner':
				options.ownerKey = valueAfter(argv, index++, option)
				break
			case '--limit': {
				const raw = valueAfter(argv, index++, option)
				const limit = Number(raw)
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
					throw new Error(`--limit must be an integer from 1 to ${PAGE_LIMIT}`)
				}
				options.limit = limit
				break
			}
			case '--confirm-import':
				options.confirmImport = true
				break
			case '--secret':
				throw new Error('Do not pass the admin secret as an argument; use WHITEBOARD_ADMIN_SECRET')
			default:
				throw new Error(`Unknown option: ${option}`)
		}
	}
	if (options.command === 'export' && !options.outputPath) {
		throw new Error('export requires --output <new-directory>')
	}
	if (options.command === 'import' && !options.confirmImport) {
		throw new Error('import requires --confirm-import')
	}
	if (!options.checkpointPath) {
		options.checkpointPath = options.command === 'export'
			? `${options.outputPath}.checkpoint.json`
			: `${options.manifestPath}.checkpoint.json`
	}
	const parsedUrl = new URL(options.baseUrl)
	if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
		throw new Error('--base-url must be an http(s) origin without credentials or query parameters')
	}
	options.baseUrl = parsedUrl.origin
	return options
}

/** Redact a secret before an error or diagnostic is displayed. */
export function redactSecret(value, secret) {
	if (!secret) return String(value)
	return String(value).split(secret).join('[REDACTED]')
}

export function validateSecret(secret) {
	if (typeof secret !== 'string' || secret.trim().length === 0 || /[\r\n]/.test(secret)) {
		throw new Error('WHITEBOARD_ADMIN_SECRET is required in the environment or a protected prompt')
	}
	return secret.trim()
}

/** Read the secret from protected process state; never from argv or a URL. */
export async function readAdminSecret({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
	if (typeof env.WHITEBOARD_ADMIN_SECRET === 'string' && env.WHITEBOARD_ADMIN_SECRET.length > 0) {
		return env.WHITEBOARD_ADMIN_SECRET
	}
	if (!input.isTTY || typeof input.setRawMode !== 'function') {
		throw new Error('WHITEBOARD_ADMIN_SECRET is required in the environment (interactive prompt unavailable)')
	}
	output.write('Admin secret: ')
	return new Promise((resolvePromise, reject) => {
		let secret = ''
		const onData = (chunk) => {
			const text = String(chunk)
			for (const char of text) {
				if (char === '\u0003') {
					cleanup()
					reject(new Error('Secret prompt cancelled'))
					return
				}
				if (char === '\r' || char === '\n') {
					cleanup()
					output.write('\n')
					try {
						resolvePromise(validateSecret(secret))
					} catch (error) {
						reject(error)
					}
					return
				}
				if (char === '\u007f') secret = secret.slice(0, -1)
				else secret += char
			}
		}
		const cleanup = () => {
			input.off('data', onData)
			input.setRawMode(false)
			input.pause()
		}
		input.setRawMode(true)
		input.resume()
		input.on('data', onData)
	})
}

function adminUrl(baseUrl) {
	return new URL(ADMIN_PATH, `${baseUrl}/`).toString()
}

/** Create a bounded, secret-safe client for the Worker operator endpoint. */
export function createAdminClient({ baseUrl, secret, fetchImpl = fetch, retries = MAX_RETRIES, retrySleep = sleep }) {
	const credential = validateSecret(secret)
	const endpoint = adminUrl(baseUrl)
	const attempts = Math.max(1, Math.min(MAX_RETRIES, Math.floor(Number(retries) || 1)))
	return {
		async request(payload) {
			let lastError
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				try {
					const response = await fetchImpl(endpoint, {
						method: 'POST',
						headers: {
							Accept: 'application/json',
							'Content-Type': 'application/json',
							Authorization: `Bearer ${credential}`,
						},
						body: JSON.stringify(payload),
					})
					if (response.ok) return await response.json()
					if (response.status < 500 || attempt >= attempts - 1) {
						throw new Error(`Admin request failed (${response.status})`)
					}
					lastError = new Error(`Admin service unavailable (${response.status})`)
				} catch (error) {
					lastError = error
					if (attempt >= attempts - 1 || (error instanceof Error && /^Admin request failed \((?!5)/.test(error.message))) {
						throw error
					}
				}
				await retrySleep(Math.min(1000, 100 * 2 ** attempt))
			}
			throw lastError || new Error('Admin request failed')
		},
		async scan(cursor = null) {
			return this.request({ operation: 'scan', ...(cursor ? { cursor } : {}) })
		},
		async importObjects(objects) {
			return this.request({ operation: 'import', objects })
		},
		async exportRows(kind, cursor = null, ownerKey, limit = PAGE_LIMIT) {
			return this.request({
				operation: 'export',
				kind,
				limit,
				...(ownerKey ? { ownerKey } : {}),
				...(cursor ? { cursor } : {}),
			})
		},
	}
}

async function readJson(path, fallback) {
	try {
		return JSON.parse(await readFile(path, 'utf8'))
	} catch (error) {
		if (error && error.code === 'ENOENT' && fallback !== undefined) return fallback
		throw new Error(`Could not read JSON checkpoint: ${path}`)
	}
}

export async function writeJsonAtomic(path, value) {
	const target = resolve(path)
	await mkdir(dirname(target), { recursive: true })
	const temp = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
	try {
		await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
		await rename(temp, target)
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

function objectManifestKey(object) {
	return object && typeof object.key === 'string' ? object.key : null
}

function scanInvalid(reason) {
	throw new Error(`Scan response is invalid (${reason})`)
}

function isRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, maxBytes, nonEmpty = true) {
	if (typeof value !== 'string' || (nonEmpty && value.length === 0)) return false
	return new TextEncoder().encode(value).byteLength <= maxBytes
}

function boundedCount(value) {
	return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCAN_COUNT
}

function validateScanEntry(entry) {
	if (!isRecord(entry)) scanInvalid('malformed entry')
	if (!boundedText(entry.key, 512)) scanInvalid('malformed entry')
	const keyMatch = EXACT_INDEX_RE.exec(entry.key)
	if (!keyMatch || entry.kind !== keyMatch[2]) scanInvalid('malformed entry')
	if (!/^[0-9a-f]{64}$/i.test(entry.ownerKeyHash)) scanInvalid('malformed entry')
	if (entry.size !== null && !boundedCount(entry.size)) scanInvalid('malformed entry')
	if (entry.etag !== null && !boundedText(entry.etag, 256)) scanInvalid('malformed entry')
	if (entry.sha256 !== null && !/^[0-9a-f]{64}$/i.test(entry.sha256)) scanInvalid('malformed entry')
	if (entry.version !== null && !boundedCount(entry.version)) scanInvalid('malformed entry')
	if (typeof entry.valid !== 'boolean') scanInvalid('malformed entry')
	if (!boundedCount(entry.entryCount) || !boundedCount(entry.invalidEntryCount) || !boundedCount(entry.duplicateCount)) {
		scanInvalid('malformed entry')
	}
	if (entry.invalidEntryCount > entry.entryCount) scanInvalid('malformed entry')
	if (!Array.isArray(entry.duplicateIds) || entry.duplicateIds.length > MAX_SCAN_DIAGNOSTIC_ITEMS) {
		scanInvalid('malformed entry')
	}
	if (!entry.duplicateIds.every((id) => boundedText(id, 128))) scanInvalid('malformed entry')
	if (entry.duplicateCount !== entry.duplicateIds.length) scanInvalid('malformed entry')
	if (!Array.isArray(entry.reasonCodes) || entry.reasonCodes.length > MAX_SCAN_DIAGNOSTIC_ITEMS) {
		scanInvalid('malformed entry')
	}
	if (!entry.reasonCodes.every((reason) => boundedText(reason, MAX_SCAN_REASON_LENGTH))) {
		scanInvalid('malformed entry')
	}
	if (entry.valid !== (entry.reasonCodes.length === 0)) scanInvalid('malformed entry')
	return entry
}

function validateScanCounts(counts, objectCount) {
	if (!isRecord(counts)) scanInvalid('malformed counts')
	const fields = ['listed', 'matched', 'ignored', 'valid', 'invalid', 'duplicates']
	if (!fields.every((field) => boundedCount(counts[field]))) scanInvalid('malformed counts')
	if (
		counts.matched !== objectCount ||
		counts.listed !== counts.matched + counts.ignored ||
		counts.valid + counts.invalid !== counts.matched
	) {
		scanInvalid('inconsistent counts')
	}
}

function validateScanCursor(cursor) {
	return cursor === null || boundedText(cursor, SCAN_CURSOR_MAX_BYTES)
}

function validateScanState(state) {
	if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.objects)) {
		throw new Error('Scan checkpoint is invalid')
	}
	if (state.objects.length > MAX_SCAN_PAGES * PAGE_LIMIT) {
		throw new Error('Scan checkpoint is too large')
	}
	const keys = new Set()
	for (const entry of state.objects) {
		validateScanEntry(entry)
		if (keys.has(entry.key)) throw new Error('Scan checkpoint contains duplicate objects')
		keys.add(entry.key)
	}
	if (typeof state.completed !== 'boolean' || !validateScanCursor(state.cursor ?? null)) {
		throw new Error('Scan checkpoint is invalid')
	}
	if (state.completed && (state.cursor ?? null) !== null) {
		throw new Error('Scan checkpoint is invalid')
	}
	if (state.cursorHistory !== undefined) {
		if (!Array.isArray(state.cursorHistory) || state.cursorHistory.length > MAX_SCAN_PAGES) {
			throw new Error('Scan checkpoint is invalid')
		}
		const cursors = new Set()
		for (const cursor of state.cursorHistory) {
			if (!boundedText(cursor, SCAN_CURSOR_MAX_BYTES) || cursors.has(cursor)) {
				throw new Error('Scan checkpoint is invalid')
			}
			cursors.add(cursor)
		}
		if (state.cursor !== null && state.cursor !== undefined && !cursors.has(state.cursor)) {
			throw new Error('Scan checkpoint is invalid')
		}
	}
}

function validateScanPage(page, requestCursor) {
	if (!isRecord(page)) scanInvalid('malformed page')
	try {
		const encoded = JSON.stringify(page)
		if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_SCAN_RESPONSE_BYTES) {
			scanInvalid('response too large')
		}
	} catch {
		scanInvalid('malformed page')
	}
	if (page.operation !== 'scan') scanInvalid('unexpected operation')
	if (!Array.isArray(page.objects) || !Array.isArray(page.manifest)) scanInvalid('missing objects')
	if (page.objects.length > PAGE_LIMIT || page.manifest.length > PAGE_LIMIT || page.objects.length !== page.manifest.length) {
		scanInvalid('malformed objects')
	}
	const keys = new Set()
	for (let index = 0; index < page.objects.length; index += 1) {
		const object = validateScanEntry(page.objects[index])
		const manifestEntry = validateScanEntry(page.manifest[index])
		if (object.key !== manifestEntry.key || JSON.stringify(object) !== JSON.stringify(manifestEntry)) {
			scanInvalid('objects and manifest differ')
		}
		if (keys.has(object.key)) scanInvalid('duplicate objects')
		keys.add(object.key)
	}
	validateScanCounts(page.counts, page.objects.length)
	const validObjectCount = page.objects.filter((object) => object.valid === true).length
	const duplicateObjectCount = page.objects.reduce(
		(sum, object) => sum + object.duplicateCount,
		0,
	)
	if (
		page.counts.valid !== validObjectCount ||
		page.counts.invalid !== page.objects.length - validObjectCount ||
		page.counts.duplicates !== duplicateObjectCount
	) {
		scanInvalid('inconsistent counts')
	}
	if (
		typeof page.done !== 'boolean' ||
		!Object.prototype.hasOwnProperty.call(page, 'nextCursor') ||
		!validateScanCursor(page.nextCursor)
	) {
		scanInvalid('malformed cursor state')
	}
	const nextCursor = page.nextCursor
	if ((page.done && nextCursor !== null) || (!page.done && nextCursor === null)) {
		scanInvalid('inconsistent cursor state')
	}
	if (requestCursor !== null && nextCursor !== null && nextCursor === requestCursor) {
		scanInvalid('cursor cycle')
	}
	return { objects: page.objects, nextCursor, done: page.done }
}

/** Scan every bounded R2 page, checkpointing after each page for resume. */
export async function runScan({ client, manifestPath, checkpointPath = manifestPath }) {
	const checkpoint = resolve(checkpointPath)
	const manifest = resolve(manifestPath)
	let state = await readJson(checkpoint, {
		version: 1,
		objects: [],
		cursor: null,
		completed: false,
	})
	validateScanState(state)
	let known = new Map(state.objects.map((object) => [objectManifestKey(object), object]))
	let cursor = state.completed ? null : state.cursor ?? null
	const seenCursors = new Set(Array.isArray(state.cursorHistory) ? state.cursorHistory : [])
	if (cursor !== null) seenCursors.add(cursor)
	let pageCount = seenCursors.size
	while (!state.completed) {
		const page = await client.scan(cursor)
		const validated = validateScanPage(page, cursor)
		const nextKnown = new Map(known)
		for (const object of validated.objects) {
			const key = objectManifestKey(object)
			if (!key || nextKnown.has(key)) scanInvalid('duplicate objects')
			nextKnown.set(key, object)
		}
		if (pageCount >= MAX_SCAN_PAGES) {
			throw new Error('Scan exceeded the maximum page count')
		}
		const nextSeenCursors = new Set(seenCursors)
		if (validated.nextCursor !== null) {
			if (nextSeenCursors.has(validated.nextCursor)) scanInvalid('cursor cycle')
			nextSeenCursors.add(validated.nextCursor)
		}
		const nextState = {
			...state,
			objects: [...nextKnown.values()],
			cursor: validated.nextCursor,
			completed: validated.done,
			cursorHistory: [...nextSeenCursors],
			updatedAt: new Date().toISOString(),
		}
		await writeJsonAtomic(checkpoint, nextState)
		state = nextState
		known = nextKnown
		seenCursors.clear()
		for (const seenCursor of nextSeenCursors) seenCursors.add(seenCursor)
		pageCount += 1
		cursor = validated.nextCursor
	}
	if (checkpoint !== manifest) await writeJsonAtomic(manifest, state)
	return state
}

/** Import only valid scanned objects, checkpointing successful 25-object pages. */
export async function runImport({ client, manifestPath, checkpointPath = `${manifestPath}.checkpoint.json`, confirm = false }) {
	if (!confirm) throw new Error('Import requires explicit confirmation')
	const manifest = await readJson(manifestPath)
	if (!manifest || manifest.completed !== true || !Array.isArray(manifest.objects)) {
		throw new Error('Import requires a completed scan manifest')
	}
	if (manifest.objects.some((object) => !object || object.valid !== true || !objectManifestKey(object) || typeof object.etag !== 'string' || typeof object.sha256 !== 'string')) {
		throw new Error('Import refuses a scan manifest containing invalid objects')
	}
	const candidates = manifest.objects
	const checkpoint = await readJson(checkpointPath, { version: 1, importedKeys: [] })
	if (
		!checkpoint ||
		typeof checkpoint !== 'object' ||
		(!Array.isArray(checkpoint.importedSources) && Array.isArray(checkpoint.importedKeys) && checkpoint.importedKeys.length > 0)
	) {
		throw new Error('Import checkpoint is not pinned to source hashes; rescan and restart import')
	}
	const imported = new Map()
	if (Array.isArray(checkpoint.importedSources)) {
		for (const source of checkpoint.importedSources) {
			if (!source || typeof source !== 'object' || typeof source.key !== 'string' || typeof source.etag !== 'string' || typeof source.sha256 !== 'string') {
				throw new Error('Import checkpoint is not pinned to source hashes; rescan and restart import')
			}
			imported.set(source.key, { etag: source.etag, sha256: source.sha256 })
		}
	}
	for (const object of candidates) {
		const prior = imported.get(object.key)
		if (prior && (prior.etag !== object.etag || prior.sha256.toLowerCase() !== object.sha256.toLowerCase())) {
			throw new Error('Import checkpoint does not match the current scan manifest; rescan and restart import')
		}
	}
	const ownerGroups = new Map()
	for (const object of candidates) {
		const match = /^library\/([^/]+)\/(?:boards|assets)\.json$/.exec(object.key)
		if (!match) throw new Error('Import refuses a manifest with an unsafe object key')
		const group = ownerGroups.get(match[1]) || []
		group.push(object)
		ownerGroups.set(match[1], group)
	}
	const pages = []
	let current = []
	for (const group of ownerGroups.values()) {
		if (group.length > PAGE_LIMIT) {
			if (current.length) pages.push(current)
			current = []
			for (let index = 0; index < group.length; index += PAGE_LIMIT) pages.push(group.slice(index, index + PAGE_LIMIT))
			continue
		}
		if (current.length && current.length + group.length > PAGE_LIMIT) {
			pages.push(current)
			current = []
		}
		current.push(...group)
	}
	if (current.length) pages.push(current)
	for (const batch of pages) {
		const page = batch.filter((object) => !imported.has(object.key))
		if (page.length === 0) continue
		await client.importObjects(page.map(({ key, etag, sha256 }) => ({ key, etag, sha256 })))
		for (const object of page) imported.set(object.key, { etag: object.etag, sha256: object.sha256 })
		checkpoint.importedSources = [...imported].map(([key, source]) => ({ key, ...source }))
		checkpoint.importedKeys = [...imported.keys()]
		checkpoint.updatedAt = new Date().toISOString()
		await writeJsonAtomic(checkpointPath, checkpoint)
	}
	return { importedKeys: [...imported.keys()], count: imported.size }
}

function safeOwnerDirectory(ownerKey) {
	if (typeof ownerKey !== 'string' || ownerKey.length === 0 || ownerKey.length > 256 || ownerKey.includes('/') || ownerKey.includes('\\') || ownerKey === '.' || ownerKey === '..') {
		throw new Error('Export returned an unsafe owner key')
	}
	return ownerKey
}

async function pathExists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

function exportCheckpoint(workDir, root, ownerKey, state) {
	return {
		version: 2,
		operationId: state.operationId,
		phase: state.phase,
		outputPath: root,
		ownerKey: ownerKey ?? null,
		workDir,
		...(state.stagingPath ? { stagingPath: state.stagingPath } : {}),
		kinds: state.kinds,
		files: state.files ?? 0,
		updatedAt: new Date().toISOString(),
	}
}

function newExportState(root, ownerKey, workDir, stagingPath, operationId) {
	return {
		version: 2,
		operationId,
		phase: 'fetching',
		outputPath: root,
		ownerKey: ownerKey ?? null,
		workDir,
		stagingPath,
		kinds: {
			boards: { cursor: null, done: false, page: 0 },
			assets: { cursor: null, done: false, page: 0 },
		},
		files: 0,
	}
}

function exportFragmentPath(workDir, kind, page) {
	return join(workDir, `${kind}-${String(page).padStart(8, '0')}.json`)
}

function expectedExportPaths(checkpointPath, root, operationId) {
	const checkpoint = resolve(checkpointPath)
	if (checkpoint === dirname(checkpoint) || root === dirname(root)) {
		throw new Error('Export checkpoint has an unsafe artifact path')
	}
	if (typeof operationId !== 'string' || !EXPORT_OPERATION_RE.test(operationId)) {
		throw new Error('Export checkpoint has an invalid operation id')
	}
	const workDir = resolve(`${checkpoint}.export-work-${operationId}`)
	const stagingPath = resolve(`${root}.staging-${operationId}`)
	if (workDir === checkpoint || workDir === root || stagingPath === root || stagingPath === checkpoint) {
		throw new Error('Export checkpoint has an unsafe artifact path')
	}
	if (dirname(workDir) !== dirname(checkpoint) || dirname(stagingPath) !== dirname(root)) {
		throw new Error('Export checkpoint has an unsafe artifact path')
	}
	return { workDir, stagingPath }
}

function validateExportCursor(value) {
	if (value === null) return true
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const record = value
	if (
		typeof record.ownerKey !== 'string' ||
		typeof record.id !== 'string' ||
		record.ownerKey.length === 0 ||
		record.ownerKey.length > 256 ||
		record.id.length === 0 ||
		record.id.length > 128
	) return false
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_EXPORT_CURSOR_BYTES
	} catch {
		return false
	}
}

function validateExportProgress(progress, kind) {
	if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
		throw new Error(`Export checkpoint has invalid ${kind} progress`)
	}
	if (
		!Number.isSafeInteger(progress.page) ||
		progress.page < 0 ||
		progress.page > MAX_EXPORT_PAGES ||
		typeof progress.done !== 'boolean' ||
		!validateExportCursor(progress.cursor) ||
		(progress.done && progress.cursor !== null) ||
		(!progress.done && progress.page > 0 && progress.cursor === null)
	) {
		throw new Error(`Export checkpoint has invalid ${kind} progress`)
	}
}

function validateExportState(saved, checkpointPath, root, ownerKey) {
	if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 2) {
		throw new Error('Export checkpoint does not match this output or owner')
	}
	if (
		saved.outputPath !== root ||
		(saved.ownerKey ?? null) !== (ownerKey ?? null) ||
		!EXPORT_PHASES.has(saved.phase) ||
		!saved.kinds ||
		Array.isArray(saved.kinds) ||
		!saved.kinds.boards ||
		!saved.kinds.assets
	) {
		throw new Error('Export checkpoint does not match this output or owner')
	}
	if (saved.ownerKey !== null && saved.ownerKey !== undefined) safeOwnerDirectory(saved.ownerKey)
	const expected = expectedExportPaths(checkpointPath, root, saved.operationId)
	if (saved.workDir !== expected.workDir || saved.stagingPath !== expected.stagingPath) {
		throw new Error('Export checkpoint has unsafe artifact paths')
	}
	validateExportProgress(saved.kinds.boards, 'boards')
	validateExportProgress(saved.kinds.assets, 'assets')
	if (
		!Number.isSafeInteger(saved.files) ||
		saved.files < 0 ||
		saved.files > MAX_EXPORT_FILES ||
		(saved.phase !== 'fetching' && (!saved.kinds.boards.done || !saved.kinds.assets.done))
	) {
		throw new Error('Export checkpoint has invalid completion state')
	}
	return {
		...saved,
		workDir: expected.workDir,
		stagingPath: expected.stagingPath,
	}
}

function exportMarkerPath(root, operationId) {
	return join(root, `.whiteboard-library-export-${operationId}.json`)
}

// This hidden local marker proves ownership during crash recovery. It is audit
// metadata for the export tree, never an R2 source index or import authority.
async function readExportMarker(root, operationId) {
	const marker = exportMarkerPath(root, operationId)
	try {
		const details = await stat(marker)
		if (!details.isFile() || details.size > EXPORT_MARKER_MAX_BYTES) return null
		const parsed = JSON.parse(await readFile(marker, 'utf8'))
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			parsed.operationId !== operationId ||
			parsed.outputPath !== root ||
			!Number.isSafeInteger(parsed.files) ||
			parsed.files < 0 ||
			parsed.files > MAX_EXPORT_FILES
		) return null
		return parsed
	} catch {
		return null
	}
}

async function requireOwnedOutput(root, operationId) {
	const marker = await readExportMarker(root, operationId)
	if (!marker) throw new Error(`Refusing to adopt an existing export directory: ${root}`)
	return marker
}

async function readExportState(checkpointPath, root, ownerKey) {
	const saved = await readJson(checkpointPath, null)
	if (!saved) {
		if (await pathExists(root)) throw new Error(`Refusing to overwrite existing export directory: ${root}`)
		const operationId = randomUUID()
		const { workDir, stagingPath } = expectedExportPaths(checkpointPath, root, operationId)
		const state = newExportState(root, ownerKey, workDir, stagingPath, operationId)
		await mkdir(workDir, { recursive: true, mode: 0o700 })
		await writeJsonAtomic(checkpointPath, exportCheckpoint(workDir, root, ownerKey, state))
		return state
	}
	const state = validateExportState(saved, checkpointPath, root, ownerKey)
	if (state.phase === 'fetching' && await pathExists(root)) {
		throw new Error(`Refusing to adopt an existing export directory: ${root}`)
	}
	await mkdir(state.workDir, { recursive: true, mode: 0o700 })
	return state
}

async function fetchExportPages({ client, state, checkpointPath, ownerKey, limit }) {
	for (const kind of ['boards', 'assets']) {
		const progress = state.kinds[kind]
		while (!progress.done) {
			const page = await client.exportRows(kind, progress.cursor, ownerKey, limit)
			if (!page || !Array.isArray(page.rows) || page.rows.length > PAGE_LIMIT || (page.nextCursor && page.done === true) || (!page.nextCursor && page.done !== true)) {
				throw new Error('Export returned an invalid or incomplete page')
			}
			const fragment = exportFragmentPath(state.workDir, kind, progress.page)
			await writeJsonAtomic(fragment, {
				kind,
				cursor: progress.cursor,
				rows: page.rows,
				nextCursor: page.nextCursor ?? null,
				done: page.done === true,
			})
			progress.page += 1
			progress.cursor = page.nextCursor ?? null
			progress.done = page.done === true
			await writeJsonAtomic(checkpointPath, exportCheckpoint(state.workDir, state.outputPath, ownerKey, state))
		}
	}
}

async function collectExportOwnerRefs(state) {
	const refs = { boards: new Map(), assets: new Map() }
	for (const kind of ['boards', 'assets']) {
		const progress = state.kinds[kind]
		for (let page = 0; page < progress.page; page += 1) {
			const fragment = exportFragmentPath(state.workDir, kind, page)
			const data = await readJson(fragment)
			if (!data || !Array.isArray(data.rows)) throw new Error('Export page fragment is invalid')
			for (const row of data.rows) {
				const owner = safeOwnerDirectory(row?.ownerKey)
				if (state.ownerKey && owner !== state.ownerKey) continue
				const ownerRefs = refs[kind].get(owner) || []
				if (!ownerRefs.includes(fragment)) ownerRefs.push(fragment)
				refs[kind].set(owner, ownerRefs)
			}
		}
	}
	return refs
}

async function writeExportOwnerFile(staging, kind, owner, fragments) {
	const target = join(staging, 'library', owner, `${kind}.json`)
	const temp = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	let published = false
	try {
		await writeFile(temp, '[\n', { encoding: 'utf8', mode: 0o600 })
		let first = true
		for (const fragment of fragments) {
			const data = await readJson(fragment)
			for (const row of data.rows) {
				if (safeOwnerDirectory(row?.ownerKey) !== owner) continue
				const { ownerKey: ignoredOwner, ...dto } = row
				const output = kind === 'assets' ? { ...dto, ownerKey: owner } : dto
				await appendFile(temp, `${first ? '' : ',\n'}${JSON.stringify(output)}`, { encoding: 'utf8' })
				first = false
			}
		}
		await appendFile(temp, '\n]\n', { encoding: 'utf8' })
		await rename(temp, target)
		published = true
	} finally {
		if (!published) await rm(temp, { force: true }).catch(() => {})
	}
}

async function finalizeExport(state, checkpointPath, ownerKey) {
	const refs = await collectExportOwnerRefs(state)
	const { stagingPath } = expectedExportPaths(checkpointPath, state.outputPath, state.operationId)
	if (state.stagingPath !== stagingPath) throw new Error('Export checkpoint has unsafe artifact paths')
	const staging = stagingPath
	state.phase = 'publishing'
	state.stagingPath = staging
	await writeJsonAtomic(checkpointPath, exportCheckpoint(state.workDir, state.outputPath, ownerKey, state))
	if (await pathExists(state.outputPath)) {
		const marker = await requireOwnedOutput(state.outputPath, state.operationId)
		state.files = marker.files
		state.phase = 'complete'
		await writeJsonAtomic(checkpointPath, exportCheckpoint(state.workDir, state.outputPath, ownerKey, state))
		return { outputPath: state.outputPath, files: state.files ?? 0 }
	}
	await rm(staging, { recursive: true, force: true })
	await mkdir(staging, { recursive: true, mode: 0o700 })
	let files = 0
	for (const kind of ['boards', 'assets']) {
		for (const [owner, fragments] of refs[kind]) {
			await writeExportOwnerFile(staging, kind, owner, fragments)
			files += 1
		}
	}
	state.files = files
	await writeJsonAtomic(exportMarkerPath(staging, state.operationId), {
		operationId: state.operationId,
		outputPath: state.outputPath,
		files,
	})
	await writeJsonAtomic(checkpointPath, exportCheckpoint(state.workDir, state.outputPath, ownerKey, state))
	if (await pathExists(state.outputPath)) throw new Error(`Refusing to overwrite existing export directory: ${state.outputPath}`)
	await rename(staging, state.outputPath)
	state.phase = 'complete'
	await writeJsonAtomic(checkpointPath, exportCheckpoint(state.workDir, state.outputPath, ownerKey, state))
	return { outputPath: state.outputPath, files }
}

/** Export live D1 pages to a new rollback-compatible tree, resumably and without clobbering. */
export async function runExport({ client, outputPath, ownerKey = undefined, limit = PAGE_LIMIT, checkpointPath = `${outputPath}.checkpoint.json` }) {
	const root = resolve(outputPath)
	let state = await readExportState(checkpointPath, root, ownerKey)
	if ((state.phase === 'complete' || state.phase === 'publishing') && await pathExists(root)) {
		const marker = await requireOwnedOutput(root, state.operationId)
		state.files = marker.files
		state.phase = 'complete'
		await writeJsonAtomic(checkpointPath, exportCheckpoint(state.workDir, root, ownerKey, state))
		return { outputPath: root, files: state.files ?? 0 }
	}
	if (state.phase === 'fetching') await fetchExportPages({ client, state, checkpointPath, ownerKey, limit })
	return finalizeExport(state, checkpointPath, ownerKey)
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const secret = await readAdminSecret()
	const client = createAdminClient({ baseUrl: options.baseUrl, secret })
	if (options.command === 'scan') {
		const state = await runScan({ client, manifestPath: options.manifestPath, checkpointPath: options.checkpointPath })
		console.log(`scan complete: ${state.objects.length} exact objects`)
	} else if (options.command === 'import') {
		const result = await runImport({ client, manifestPath: options.manifestPath, checkpointPath: options.checkpointPath, confirm: options.confirmImport })
		console.log(`import complete: ${result.count} objects checkpointed`)
	} else {
		const result = await runExport({ client, outputPath: options.outputPath, ownerKey: options.ownerKey, limit: options.limit, checkpointPath: options.checkpointPath })
		console.log(`export complete: ${result.files} files`)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : 'Operator command failed')
		process.exitCode = 1
	})
}
