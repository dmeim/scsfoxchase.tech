// The application tsconfig intentionally omits Node typings; these tests run
// in Vitest's Node project and use the runtime modules directly.
// @ts-expect-error Node typings are provided by the Vitest Node environment.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
// @ts-expect-error Node typings are provided by the Vitest Node environment.
import { tmpdir } from 'node:os'
// @ts-expect-error Node typings are provided by the Vitest Node environment.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	parseArgs,
	redactSecret,
	runExport,
	runImport,
	runScan,
	writeJsonAtomic,
} from '../scripts/whiteboard-library-operator.mjs'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const ASSET_ID = '22222222-2222-4222-8222-222222222222'

function scanEntry(key: string, overrides: Record<string, unknown> = {}) {
	const kind = key.endsWith('/assets.json') ? 'assets' : 'boards'
	return {
		key,
		ownerKeyHash: 'a'.repeat(64),
		kind,
		size: 0,
		etag: 'etag',
		sha256: 'b'.repeat(64),
		version: 1,
		valid: true,
		entryCount: 0,
		invalidEntryCount: 0,
		duplicateCount: 0,
		duplicateIds: [],
		reasonCodes: [],
		...overrides,
	}
}

function scanPage(
	objects: Array<Record<string, unknown>>,
	nextCursor: string | null = null,
	done = nextCursor === null,
	overrides: Record<string, unknown> = {},
) {
	const valid = objects.filter((object) => object.valid === true).length
	const duplicates = objects.reduce(
		(sum, object) => sum + (typeof object.duplicateCount === 'number' ? object.duplicateCount : 0),
		0,
	)
	return {
		operation: 'scan',
		objects,
		manifest: objects.map((object) => ({ ...object })),
		counts: {
			listed: objects.length,
			matched: objects.length,
			ignored: 0,
			valid,
			invalid: objects.length - valid,
			duplicates,
		},
		nextCursor,
		done,
		...overrides,
	}
}

describe('whiteboard library operator CLI', () => {
	it('requires explicit import confirmation and never accepts a secret argument', () => {
		expect(() => parseArgs(['import'])).toThrow('--confirm-import')
		expect(() => parseArgs(['import', '--confirm-import', '--secret', 'top-secret'])).toThrow('Do not pass')
		expect(() => parseArgs(['scan', '--base-url', 'https://example.test/?secret=bad'])).toThrow('without credentials')
		expect(parseArgs(['scan']).baseUrl).toBe('https://scsfoxchase-tech.dimitri-meimaridis.workers.dev')
		expect(parseArgs(['scan', '--base-url', 'https://example.test']).baseUrl).toBe('https://example.test')
		expect(parseArgs(['export', '--output', 'library-export']).checkpointPath).toBe('library-export.checkpoint.json')
		expect(redactSecret('Authorization: Bearer top-secret', 'top-secret')).toBe('Authorization: Bearer [REDACTED]')
	})

	it('resumes scans from the atomic manifest checkpoint', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const manifestPath = join(root, 'manifest.json')
		const checkpointPath = join(root, 'scan.checkpoint.json')
		const calls: Array<string | null> = []
		const client = {
			scan: async (cursor: string | null) => {
				calls.push(cursor)
				if (!cursor) {
					return scanPage([scanEntry('library/google:one/boards.json')], 'page-2', false)
				}
				return scanPage([scanEntry('library/google:two/assets.json')])
			},
		}
		const state = await runScan({ client, manifestPath, checkpointPath })
		expect(calls).toEqual([null, 'page-2'])
		expect(state.completed).toBe(true)
		expect(state.objects).toHaveLength(2)
		const persisted = JSON.parse(await readFile(manifestPath, 'utf8'))
		expect(persisted.completed).toBe(true)
		expect(JSON.parse(await readFile(checkpointPath, 'utf8')).completed).toBe(true)
		await rm(root, { recursive: true, force: true })
	})

	it.each([
		['missing objects', () => {
			const page = scanPage([scanEntry('library/google:malformed/boards.json')]) as Record<string, unknown>
			delete page.objects
			return page
		}],
		['non-array objects', () => scanPage([scanEntry('library/google:malformed/boards.json')], null, true, { objects: {} })],
		['missing manifest', () => {
			const page = scanPage([scanEntry('library/google:malformed/boards.json')]) as Record<string, unknown>
			delete page.manifest
			return page
		}],
		['non-array manifest', () => scanPage([scanEntry('library/google:malformed/boards.json')], null, true, { manifest: {} })],
		['missing counts', () => {
			const page = scanPage([scanEntry('library/google:malformed/boards.json')]) as Record<string, unknown>
			delete page.counts
			return page
		}],
		['inconsistent counts', () => scanPage([scanEntry('library/google:malformed/boards.json')], null, true, {
			counts: { listed: 1, matched: 1, ignored: 0, valid: 0, invalid: 1, duplicates: 0 },
		})],
		['wrong operation', () => scanPage([scanEntry('library/google:malformed/boards.json')], null, true, { operation: 'import' })],
		['done with cursor', () => scanPage([scanEntry('library/google:malformed/boards.json')], 'next', true)],
		['not done without cursor', () => scanPage([scanEntry('library/google:malformed/boards.json')], null, false)],
		['missing cursor', () => {
			const page = scanPage([scanEntry('library/google:malformed/boards.json')]) as Record<string, unknown>
			delete page.nextCursor
			return page
		}],
		['malformed entry', () => {
			const entry = scanEntry('library/google:malformed/boards.json', { key: 42 })
			return scanPage([entry], null, true, { manifest: [entry] })
		}],
	] as const)('rejects %s scan responses without advancing state', async (_name, makePage) => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const manifestPath = join(root, 'manifest.json')
		const checkpointPath = join(root, 'scan.checkpoint.json')
		const initial = { version: 1, objects: [], cursor: null, completed: false }
		await writeJsonAtomic(checkpointPath, initial)
		try {
			await expect(runScan({ client: { scan: async () => makePage() }, manifestPath, checkpointPath })).rejects.toThrow(/^Scan response is invalid/)
			expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toEqual(initial)
			await expect(readFile(manifestPath, 'utf8')).rejects.toThrow()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects repeated cursors, preserves the last good checkpoint, and resumes after retry', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const manifestPath = join(root, 'manifest.json')
		const checkpointPath = join(root, 'scan.checkpoint.json')
		const first = scanPage([scanEntry('library/google:cycle/boards.json')], 'loop', false)
		const calls: Array<string | null> = []
		let retry = false
		const client = {
			scan: async (cursor: string | null) => {
				calls.push(cursor)
				if (!cursor) return first
				return retry
					? scanPage([scanEntry('library/google:cycle/assets.json')])
					: scanPage([scanEntry('library/google:cycle/assets.json')], 'loop', false)
			},
		}
		try {
			await expect(runScan({ client, manifestPath, checkpointPath })).rejects.toThrow('cursor cycle')
			expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
				objects: first.objects,
				cursor: 'loop',
				completed: false,
			})
			await expect(readFile(manifestPath, 'utf8')).rejects.toThrow()
			retry = true
			const completed = await runScan({ client, manifestPath, checkpointPath })
			expect(completed.completed).toBe(true)
			expect(calls).toEqual([null, 'loop', 'loop'])
			expect(JSON.parse(await readFile(manifestPath, 'utf8')).completed).toBe(true)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects duplicate exact keys across pages without advancing the checkpoint', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const manifestPath = join(root, 'manifest.json')
		const checkpointPath = join(root, 'scan.checkpoint.json')
		const entry = scanEntry('library/google:duplicate/boards.json')
		const client = {
			scan: async (cursor: string | null) => cursor
				? scanPage([entry])
				: scanPage([entry], 'page-2', false),
		}
		try {
			await expect(runScan({ client, manifestPath, checkpointPath })).rejects.toThrow('duplicate objects')
			expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
				objects: [entry],
				cursor: 'page-2',
				completed: false,
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('checkpoints imports and does not repeat successful pages', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const manifestPath = join(root, 'manifest.json')
		const checkpointPath = join(root, 'checkpoint.json')
		await writeJsonAtomic(manifestPath, {
			version: 1,
			completed: true,
			objects: [
				{ key: 'library/google:one/boards.json', valid: true, etag: 'a', sha256: 'a'.repeat(64) },
				{ key: 'library/google:one/assets.json', valid: false, etag: 'bad', sha256: 'b'.repeat(64) },
			],
		})
		const pages: unknown[][] = []
		const client = { importObjects: async (objects: unknown[]) => { pages.push(objects) } }
		await expect(runImport({ client, manifestPath, checkpointPath, confirm: true })).rejects.toThrow('invalid objects')
		await writeJsonAtomic(manifestPath, {
			version: 1,
			completed: true,
			objects: [
				{ key: 'library/google:one/boards.json', valid: true, etag: 'a', sha256: 'a'.repeat(64) },
			],
		})
		await runImport({ client, manifestPath, checkpointPath, confirm: true })
		await runImport({ client, manifestPath, checkpointPath, confirm: true })
		expect(pages).toHaveLength(1)
		expect(pages[0]).toEqual([{ key: 'library/google:one/boards.json', etag: 'a', sha256: 'a'.repeat(64) }])
		await writeJsonAtomic(manifestPath, {
			version: 1,
			completed: true,
			objects: [{ key: 'library/google:one/boards.json', valid: true, etag: 'changed', sha256: 'a'.repeat(64) }],
		})
		await expect(runImport({ client, manifestPath, checkpointPath, confirm: true })).rejects.toThrow('does not match the current scan manifest')
		await rm(root, { recursive: true, force: true })
	})

	it('groups import batches at owner boundaries while respecting the 25-object limit', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const manifestPath = join(root, 'manifest.json')
		const checkpointPath = join(root, 'checkpoint.json')
		const objects = Array.from({ length: 13 }, (_, index) => [
			{ key: `library/google:owner-${index}/boards.json`, valid: true, etag: 'a', sha256: 'a'.repeat(64) },
			{ key: `library/google:owner-${index}/assets.json`, valid: true, etag: 'b', sha256: 'b'.repeat(64) },
		]).flat()
		await writeJsonAtomic(manifestPath, { version: 1, completed: true, objects })
		const batches: any[][] = []
		const client = { importObjects: async (batch: any[]) => { batches.push(batch) } }
		await runImport({ client, manifestPath, checkpointPath, confirm: true })
		expect(batches.map((batch) => batch.length)).toEqual([24, 2])
		for (const batch of batches) {
			const owners = new Set(batch.map((object) => object.key.split('/')[1]))
			for (const owner of owners) expect(batch.filter((object) => object.key.includes(`/${owner}/`)).length % 2).toBe(0)
		}
		await rm(root, { recursive: true, force: true })
	})

	it('exports rollback-compatible arrays into a new no-clobber tree', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const output = join(root, 'export')
		const calls: string[] = []
		const client = {
			exportRows: async (kind: string, cursor: unknown) => {
				calls.push(`${kind}:${cursor ? 'next' : 'first'}`)
				if (kind === 'boards') {
					return cursor
						? { rows: [{ ownerKey: 'google:teacher', id: BOARD_ID, title: 'Board', lastAccessedAt: '2026-08-27T12:00:00.000Z' }], done: true, nextCursor: null }
						: { rows: [], done: false, nextCursor: { ownerKey: 'google:teacher', id: BOARD_ID } }
				}
				return { rows: [{ ownerKey: 'google:teacher', id: ASSET_ID, title: 'Asset', createdAt: '2026-08-27T11:00:00.000Z', lastAccessedAt: '2026-08-27T12:00:00.000Z', mimeType: 'image/jpeg', r2Key: `assets/google:teacher/${ASSET_ID}` }], done: true, nextCursor: null }
		},
		}
		await expect(runExport({ client, outputPath: output })).resolves.toEqual({ outputPath: output, files: 2 })
		expect(calls).toEqual(['boards:first', 'boards:next', 'assets:first'])
		expect(JSON.parse(await readFile(join(output, 'library/google:teacher/boards.json'), 'utf8'))).toEqual([
			{ id: BOARD_ID, title: 'Board', lastAccessedAt: '2026-08-27T12:00:00.000Z' },
		])
		expect(JSON.parse(await readFile(join(output, 'library/google:teacher/assets.json'), 'utf8'))[0]).toMatchObject({ id: ASSET_ID, ownerKey: 'google:teacher' })
		await expect(runExport({ client, outputPath: output, checkpointPath: join(root, 'new-checkpoint.json') })).rejects.toThrow('Refusing to overwrite')
		await rm(root, { recursive: true, force: true })
	})

	it('recovers only an operation-owned published tree and rejects tampered checkpoints', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const output = join(root, 'export')
		const checkpointPath = join(root, 'export-checkpoint.json')
		const operationId = '44444444-4444-4444-8444-444444444444'
		const progress = { cursor: null, done: true, page: 0 }
		await mkdir(output, { recursive: true })
		await writeJsonAtomic(join(output, 'unrelated.txt'), 'do not adopt')
		await writeJsonAtomic(checkpointPath, {
			version: 2,
			operationId,
			phase: 'publishing',
			outputPath: output,
			ownerKey: null,
			workDir: join(root, 'tampered-work'),
			stagingPath: join(root, 'tampered-staging'),
			kinds: { boards: progress, assets: progress },
			files: 0,
		})
		await expect(runExport({ client: {}, outputPath: output, checkpointPath })).rejects.toThrow('unsafe artifact paths')
		await rm(root, { recursive: true, force: true })

		const recoveryRoot = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const recoveryOutput = join(recoveryRoot, 'export')
		const recoveryCheckpoint = join(recoveryRoot, 'export-checkpoint.json')
		const client = {
			exportRows: async (kind: string) => kind === 'boards'
				? { rows: [{ ownerKey: 'google:owned', id: BOARD_ID, title: 'Owned', lastAccessedAt: '2026-08-27T12:00:00.000Z' }], done: true, nextCursor: null }
				: { rows: [], done: true, nextCursor: null },
		}
		await runExport({ client, outputPath: recoveryOutput, checkpointPath: recoveryCheckpoint })
		const completed = JSON.parse(await readFile(recoveryCheckpoint, 'utf8'))
		const marker = join(recoveryOutput, `.whiteboard-library-export-${completed.operationId}.json`)
		await writeJsonAtomic(recoveryCheckpoint, { ...completed, phase: 'publishing', files: 0 })
		await expect(runExport({ client: { exportRows: async () => { throw new Error('must not refetch') } }, outputPath: recoveryOutput, checkpointPath: recoveryCheckpoint })).resolves.toEqual({ outputPath: recoveryOutput, files: 1 })
		expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ operationId: completed.operationId, outputPath: recoveryOutput, files: 1 })
		await rm(recoveryRoot, { recursive: true, force: true })
	})

	it('resumes export after a durable page fragment without refetching earlier pages', async () => {
		const root = await mkdtemp(join(tmpdir(), 'whiteboard-operator-'))
		const output = join(root, 'export')
		const checkpointPath = join(root, 'export-checkpoint.json')
		const firstId = BOARD_ID
		const secondId = '33333333-3333-4333-8333-333333333333'
		const calls: string[] = []
		let interrupted = false
		const client = {
			exportRows: async (kind: string, cursor: any) => {
				calls.push(`${kind}:${cursor ? cursor.id : 'first'}`)
				if (kind === 'assets') return { rows: [], done: true, nextCursor: null }
				if (!cursor) return { rows: [{ ownerKey: 'google:resume', id: firstId, title: 'First', lastAccessedAt: '2026-08-27T12:00:00.000Z' }], done: false, nextCursor: { ownerKey: 'google:resume', id: firstId } }
				if (!interrupted) {
					interrupted = true
					throw new Error('simulated operator interruption')
				}
				if (cursor.id === firstId) return { rows: [{ ownerKey: 'google:resume', id: secondId, title: 'Second', lastAccessedAt: '2026-08-27T12:00:00.000Z' }], done: false, nextCursor: { ownerKey: 'google:resume', id: secondId } }
				return { rows: [], done: true, nextCursor: null }
			},
		}
		await expect(runExport({ client, outputPath: output, checkpointPath })).rejects.toThrow('simulated')
		await expect(runExport({ client, outputPath: output, checkpointPath })).resolves.toEqual({ outputPath: output, files: 1 })
		expect(calls).toEqual(['boards:first', `boards:${firstId}`, `boards:${firstId}`, `boards:${secondId}`, 'assets:first'])
		expect(JSON.parse(await readFile(join(output, 'library/google:resume/boards.json'), 'utf8'))).toHaveLength(2)
		await rm(root, { recursive: true, force: true })
	})
})
