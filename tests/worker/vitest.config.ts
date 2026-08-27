import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const wranglerConfigPath = fileURLToPath(
	new URL('./wrangler.jsonc', import.meta.url),
)
const astroHandlerStub = fileURLToPath(
	new URL('./helpers/astro-handler-stub.ts', import.meta.url),
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
		cloudflareTest({
			wrangler: { configPath: wranglerConfigPath },
		}),
	],
	test: {
		name: 'worker',
		include: ['**/*.test.ts'],
		testTimeout: 90_000,
		hookTimeout: 30_000,
	},
})
