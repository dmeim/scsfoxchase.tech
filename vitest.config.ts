import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'node',
					environment: 'node',
					setupFiles: ['./tests/setup.ts'],
					include: ['tests/*.test.ts'],
					clearMocks: true,
					restoreMocks: true,
					testTimeout: 5000,
					hookTimeout: 5000,
				},
			},
			'./tests/worker/vitest.config.ts',
		],
	},
})
