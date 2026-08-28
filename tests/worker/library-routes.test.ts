import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { kvCodeKey } from '../../src/worker/shareCode'
import * as clerkAuth from '../../src/worker/clerkAuth'
import { handleLibraryRequest } from '../../src/worker/libraryRoutes'
import {
	LIBRARY_IMPORT_VERSION,
	upsertLibraryBoard,
} from '../../src/worker/libraryStore'

const WORKER_ORIGIN = 'https://example.com'

describe('library board deletion authorization boundary', () => {
	it('does not revoke another owner board code when the row is absent', async () => {
		vi.spyOn(clerkAuth, 'requireClerkWhiteboardAuth').mockResolvedValue({
			ok: true,
			auth: {
				clerkUserId: 'clerk-owner-a',
				accountId: 'account-owner-a',
				ownerKey: 'google:owner-a',
				email: 'owner-a@example.com',
				displayName: 'Owner A',
			},
		})
		const ownerB = `google:owner-b-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const code = `1A2B${crypto.randomUUID().slice(0, 4)}`.toUpperCase()
		await upsertLibraryBoard(
			env as unknown as Env,
			ownerB,
			{
				id: boardId,
				title: 'Owner B board',
				lastAccessedAt: '2026-08-27T12:00:00.000Z',
			},
		)
		await env.WHITEBOARD_LIBRARY
			.prepare(
				`INSERT OR REPLACE INTO library_owner_imports
				 (owner_key, imported_at, import_version) VALUES (?, ?, ?)`,
			)
			.bind('google:owner-a', '2026-08-27T12:00:00.000Z', LIBRARY_IMPORT_VERSION)
			.run()
		await env.WHITEBOARD_CODES.put(
			kvCodeKey(code),
			JSON.stringify({ boardId }),
		)

		let revokeCalls = 0
		let testEnv: Env
		const namespace = {
			idFromName: () => ({}),
			get: () => ({
				revokeShareCodeMapping: async () => {
					revokeCalls += 1
					await env.WHITEBOARD_CODES.delete(kvCodeKey(code))
				},
			}),
		}
		testEnv = new Proxy(env as unknown as Env, {
			get(target, property, receiver) {
				if (property === 'WHITEBOARDS') return namespace
				return Reflect.get(target, property, receiver)
			},
		}) as unknown as Env

		const response = await handleLibraryRequest(
			new Request(
				`${WORKER_ORIGIN}/api/whiteboard/library/boards/${boardId}`,
				{ method: 'DELETE' },
			),
			testEnv,
		)

		const responseBody = await response!.text()
		expect(response?.status, responseBody).toBe(404)
		expect(revokeCalls).toBe(0)
		expect(await env.WHITEBOARD_CODES.get(kvCodeKey(code))).toBe(
			JSON.stringify({ boardId }),
		)
	})
})
