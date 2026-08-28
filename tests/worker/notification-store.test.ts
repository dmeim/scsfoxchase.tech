import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	claimNotifications,
	clearNotifications,
	cleanupExpiredNotifications,
	createStoredNotification,
	dismissNotification,
	listNotifications,
	markAllNotificationsRead,
} from '../../src/worker/notificationStore'

const ownerKey = 'google:notification-test-user'

describe('notification store', () => {
	beforeEach(async () => {
		await clearNotifications(env, ownerKey)
	})

	it('creates, reads, and dismisses a notification', async () => {
		const created = await createStoredNotification(env, ownerKey, {
			kind: 'success',
			icon: 'circle-check',
			title: 'Saved',
			subtitle: 'Whiteboard',
			description: 'Your changes are safe.',
		})

		expect(created?.title).toBe('Saved')
		expect(await listNotifications(env, ownerKey)).toHaveLength(1)

		await markAllNotificationsRead(env, ownerKey)
		expect((await listNotifications(env, ownerKey))[0]?.readAt).toBeTruthy()

		await dismissNotification(env, ownerKey, created!.id)
		expect(await listNotifications(env, ownerKey)).toEqual([])
	})

	it('claims signed-out records idempotently and honors dedupe keys', async () => {
		const id = '11111111-1111-4111-8111-111111111111'
		const local = {
			id,
			kind: 'info',
			icon: 'bell',
			title: 'Welcome back',
			dedupeKey: 'welcome-back',
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		}

		expect(await claimNotifications(env, ownerKey, [local, local])).toEqual([id, id])
		expect(await listNotifications(env, ownerKey)).toHaveLength(1)

		await createStoredNotification(env, ownerKey, {
			kind: 'info',
			icon: 'bell',
			title: 'Duplicate wording',
			dedupeKey: 'welcome-back',
		})
		expect(await listNotifications(env, ownerKey)).toHaveLength(1)
	})

	it('rejects invalid input and removes expired rows in bounded cleanup', async () => {
		expect(await createStoredNotification(env, ownerKey, {
			kind: 'unknown',
			icon: 'not-lucide',
			title: '',
		})).toBeNull()

		await env.NOTIFICATIONS.prepare(`
			INSERT INTO notifications (
				owner_key, notification_id, kind, icon_name, title,
				toast_persist, created_at, expires_at
			) VALUES (?1, ?2, 'warning', 'triangle-alert', 'Expired', 0, ?3, ?4)
		`).bind(
			ownerKey,
			'22222222-2222-4222-8222-222222222222',
			new Date(Date.now() - 120_000).toISOString(),
			new Date(Date.now() - 60_000).toISOString(),
		).run()

		await cleanupExpiredNotifications(env)
		const count = await env.NOTIFICATIONS.prepare(
			'SELECT COUNT(*) AS count FROM notifications WHERE owner_key = ?1',
		).bind(ownerKey).first<{ count: number }>()
		expect(count?.count).toBe(0)
	})
})
