import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	cloudflareTest,
	readD1Migrations,
} from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const wranglerConfigPath = fileURLToPath(
	new URL('./wrangler.jsonc', import.meta.url),
)
const rootWranglerConfigPath = fileURLToPath(
	new URL('../../wrangler.jsonc', import.meta.url),
)
const d1MigrationSetupPath = fileURLToPath(
	new URL('./helpers/apply-d1-migrations.ts', import.meta.url),
)
const astroHandlerStub = fileURLToPath(
	new URL('./helpers/astro-handler-stub.ts', import.meta.url),
)

function parseJsonc(source: string): Record<string, unknown> {
	const stripped = source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
	const parsed: unknown = JSON.parse(stripped)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('wrangler config is not a JSON object')
	}
	return parsed as Record<string, unknown>
}

const rootWranglerConfig = parseJsonc(
	readFileSync(rootWranglerConfigPath, 'utf8'),
)
const rootD1Databases = rootWranglerConfig.d1_databases
if (!Array.isArray(rootD1Databases)) {
	throw new Error('wrangler.jsonc is missing d1_databases')
}
const rootLibraryDatabase = rootD1Databases.find(
	(database) =>
		database &&
		typeof database === 'object' &&
		!Array.isArray(database) &&
		(database as Record<string, unknown>).binding === 'WHITEBOARD_LIBRARY',
)
const configuredMigrationsDir =
	rootLibraryDatabase &&
	typeof rootLibraryDatabase === 'object' &&
	!Array.isArray(rootLibraryDatabase)
		? (rootLibraryDatabase as Record<string, unknown>).migrations_dir
		: undefined
if (typeof configuredMigrationsDir !== 'string' || !configuredMigrationsDir) {
	throw new Error(
		'wrangler.jsonc WHITEBOARD_LIBRARY is missing migrations_dir',
	)
}
const migrationsPath = resolve(
	dirname(rootWranglerConfigPath),
	configuredMigrationsDir,
)
const rootNotificationDatabase = rootD1Databases.find(
	(database) =>
		database &&
		typeof database === 'object' &&
		!Array.isArray(database) &&
		(database as Record<string, unknown>).binding === 'NOTIFICATIONS',
)
const notificationMigrationsDir = rootNotificationDatabase &&
	typeof rootNotificationDatabase === 'object' &&
	!Array.isArray(rootNotificationDatabase)
		? (rootNotificationDatabase as Record<string, unknown>).migrations_dir
		: undefined
if (typeof notificationMigrationsDir !== 'string' || !notificationMigrationsDir) {
	throw new Error('wrangler.jsonc NOTIFICATIONS is missing migrations_dir')
}
const notificationMigrationsPath = resolve(
	dirname(rootWranglerConfigPath),
	notificationMigrationsDir,
)

export default defineConfig({
	define: {
		__BUILD_SHA__: JSON.stringify('worker-test'),
		__BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
	},
	resolve: {
		alias: {
			'@astrojs/cloudflare/handler': astroHandlerStub,
		},
	},
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(migrationsPath)
			const notificationMigrations = await readD1Migrations(notificationMigrationsPath)

			return {
				wrangler: { configPath: wranglerConfigPath },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						NOTIFICATION_MIGRATIONS: notificationMigrations,
					},
				},
			}
		}),
	],
	test: {
		name: 'worker',
		include: ['**/*.test.ts'],
		setupFiles: [d1MigrationSetupPath],
		testTimeout: 90_000,
		hookTimeout: 30_000,
	},
})
