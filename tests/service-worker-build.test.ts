import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveBuildSha } from '../scripts/build-metadata.mjs'
import {
	SERVICE_WORKER_BUILD_PLACEHOLDER,
	stampServiceWorker,
} from '../scripts/stamp-service-worker.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	)
})

describe('service-worker build versioning', () => {
	it('prefers CI build metadata and truncates it to the deployed version length', () => {
		expect(resolveBuildSha({ WORKERS_CI_COMMIT_SHA: '1234567890abcdef' })).toBe(
			'1234567890ab',
		)
	})

	it('stamps the generated worker with the build SHA', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'scs-service-worker-'))
		temporaryDirectories.push(directory)
		const filePath = join(directory, 'sw.js')
		await writeFile(
			filePath,
			`const CACHE_NAME = "scs-${SERVICE_WORKER_BUILD_PLACEHOLDER}";`,
			'utf8',
		)

		await stampServiceWorker({ filePath, buildSha: 'abc1234' })

		expect(await readFile(filePath, 'utf8')).toBe(
			'const CACHE_NAME = "scs-abc1234";',
		)
	})

	it('fails the build if the worker placeholder is missing', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'scs-service-worker-'))
		temporaryDirectories.push(directory)
		const filePath = join(directory, 'sw.js')
		await writeFile(filePath, 'const CACHE_NAME = "already-stamped";', 'utf8')

		await expect(
			stampServiceWorker({ filePath, buildSha: 'abc1234' }),
		).rejects.toThrow('Expected one')
	})
})
