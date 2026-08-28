import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

await applyD1Migrations(env.WHITEBOARD_LIBRARY, env.TEST_MIGRATIONS)
