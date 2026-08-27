/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Tests read `env` from both module names, so both are augmented. Note: under
// the ROOT tsconfig these augmentations do not take effect (it does not resolve
// `@cloudflare/vitest-pool-workers/types`, so `env` falls back to the global
// `Env`, which lacks the bindings). The worker vitest project compiles these
// files correctly; see plan §6.3a.
declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		WHITEBOARDS: DurableObjectNamespace
		WHITEBOARD_ASSETS: R2Bucket
		WHITEBOARD_CODES: KVNamespace
	}
}

declare module 'cloudflare:workers' {
	interface ProvidedEnv extends Env {
		WHITEBOARDS: DurableObjectNamespace
		WHITEBOARD_ASSETS: R2Bucket
		WHITEBOARD_CODES: KVNamespace
	}
}

declare module '*.jsonc?raw' {
	const source: string
	export default source
}
