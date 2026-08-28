import {
	isNotificationIcon,
	isNotificationKind,
	type NotificationRecord,
} from '../lib/notifications'

const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_MS = MAX_RETENTION_MS
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type NotificationRow = {
	notification_id: string
	kind: string
	icon_name: string
	title: string
	subtitle: string | null
	description: string | null
	toast_persist: number
	dedupe_key: string | null
	created_at: string
	expires_at: string
	read_at: string | null
}

export class NotificationStoreError extends Error {
	constructor(
		message = 'Notification storage is temporarily unavailable',
		options?: { cause?: unknown },
	) {
		super(message, options)
		this.name = 'NotificationStoreError'
	}
}

function databaseFrom(env: Env): D1Database {
	if (!env.NOTIFICATIONS) {
		throw new NotificationStoreError('Notification storage is not configured')
	}
	return env.NOTIFICATIONS
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
	if (value === undefined || value === null || value === '') return undefined
	if (typeof value !== 'string') return undefined
	const text = value.trim()
	if (!text || text.length > maxLength) return undefined
	return text
}

function validIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	)
}

function normalizeInput(
	value: unknown,
	options: { preserveClientTimes: boolean },
): NotificationRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const input = value as Record<string, unknown>
	if (!isNotificationKind(input.kind) || !isNotificationIcon(input.icon)) {
		return null
	}
	if (typeof input.title !== 'string') return null
	const title = input.title.trim()
	if (!title || title.length > 100) return null
	const subtitle = cleanOptionalText(input.subtitle, 140)
	const description = cleanOptionalText(input.description, 500)
	if (input.subtitle !== undefined && input.subtitle !== '' && !subtitle) return null
	if (input.description !== undefined && input.description !== '' && !description) {
		return null
	}
	const dedupeKey = cleanOptionalText(input.dedupeKey, 120)
	if (input.dedupeKey !== undefined && input.dedupeKey !== '' && !dedupeKey) {
		return null
	}

	const now = Date.now()
	if (
		options.preserveClientTimes &&
		(typeof input.id !== 'string' ||
			!UUID_RE.test(input.id) ||
			!validIsoTimestamp(input.createdAt) ||
			!validIsoTimestamp(input.expiresAt))
	) {
		return null
	}
	const requestedCreatedAt = options.preserveClientTimes && validIsoTimestamp(input.createdAt)
		? Date.parse(input.createdAt)
		: now
	const createdAtMs = Math.min(requestedCreatedAt, now)
	const requestedExpiry = validIsoTimestamp(input.expiresAt)
		? Date.parse(input.expiresAt)
		: createdAtMs + DEFAULT_RETENTION_MS
	const expiresAtMs = Math.min(
		requestedExpiry,
		createdAtMs + MAX_RETENTION_MS,
		now + MAX_RETENTION_MS,
	)
	if (expiresAtMs <= now) return null

	const requestedId = input.id
	const id = typeof requestedId === 'string' && UUID_RE.test(requestedId)
		? requestedId.toLowerCase()
		: crypto.randomUUID()

	return {
		id,
		kind: input.kind,
		icon: input.icon,
		title,
		...(subtitle ? { subtitle } : {}),
		...(description ? { description } : {}),
		persist: input.persist === true,
		...(dedupeKey ? { dedupeKey } : {}),
		createdAt: new Date(createdAtMs).toISOString(),
		expiresAt: new Date(expiresAtMs).toISOString(),
	}
}

function fromRow(row: NotificationRow): NotificationRecord {
	return {
		id: row.notification_id,
		kind: isNotificationKind(row.kind) ? row.kind : 'info',
		icon: isNotificationIcon(row.icon_name) ? row.icon_name : 'bell',
		title: row.title,
		...(row.subtitle ? { subtitle: row.subtitle } : {}),
		...(row.description ? { description: row.description } : {}),
		persist: row.toast_persist === 1,
		...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		...(row.read_at ? { readAt: row.read_at } : {}),
	}
}

function insertStatement(
	database: D1Database,
	ownerKey: string,
	notification: NotificationRecord,
): D1PreparedStatement {
	return database.prepare(`
		INSERT OR IGNORE INTO notifications (
			owner_key, notification_id, kind, icon_name, title, subtitle,
			description, toast_persist, dedupe_key, created_at, expires_at, read_at
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
	`).bind(
		ownerKey,
		notification.id,
		notification.kind,
		notification.icon,
		notification.title,
		notification.subtitle ?? null,
		notification.description ?? null,
		notification.persist ? 1 : 0,
		notification.dedupeKey ?? null,
		notification.createdAt,
		notification.expiresAt,
		notification.readAt ?? null,
	)
}

function pruneOwnerStatement(
	database: D1Database,
	ownerKey: string,
): D1PreparedStatement {
	return database.prepare(`
		DELETE FROM notifications
		WHERE owner_key = ?1 AND notification_id NOT IN (
			SELECT notification_id FROM notifications
			WHERE owner_key = ?1 AND expires_at > ?2
			ORDER BY created_at DESC
			LIMIT 100
		)
	`).bind(ownerKey, new Date().toISOString())
}

export async function listNotifications(
	env: Env,
	ownerKey: string,
): Promise<NotificationRecord[]> {
	try {
		const result = await databaseFrom(env).prepare(`
			SELECT notification_id, kind, icon_name, title, subtitle, description,
				toast_persist, dedupe_key, created_at, expires_at, read_at
			FROM notifications
			WHERE owner_key = ?1 AND expires_at > ?2
			ORDER BY created_at DESC
			LIMIT 100
		`).bind(ownerKey, new Date().toISOString()).all<NotificationRow>()
		return result.results.map(fromRow)
	} catch (error) {
		throw new NotificationStoreError(undefined, { cause: error })
	}
}

export async function createStoredNotification(
	env: Env,
	ownerKey: string,
	input: unknown,
): Promise<NotificationRecord | null> {
	const notification = normalizeInput(input, { preserveClientTimes: false })
	if (!notification) return null
	try {
		const database = databaseFrom(env)
		await database.batch([
			insertStatement(database, ownerKey, notification),
			pruneOwnerStatement(database, ownerKey),
		])
		const row = await database.prepare(`
			SELECT notification_id, kind, icon_name, title, subtitle, description,
				toast_persist, dedupe_key, created_at, expires_at, read_at
			FROM notifications
			WHERE owner_key = ?1 AND (notification_id = ?2 OR (?3 IS NOT NULL AND dedupe_key = ?3))
			LIMIT 1
		`).bind(ownerKey, notification.id, notification.dedupeKey ?? null).first<NotificationRow>()
		return row ? fromRow(row) : notification
	} catch (error) {
		throw new NotificationStoreError(undefined, { cause: error })
	}
}

export async function claimNotifications(
	env: Env,
	ownerKey: string,
	values: unknown[],
): Promise<string[]> {
	const notifications = values
		.slice(0, 50)
		.map((value) => normalizeInput(value, { preserveClientTimes: true }))
		.filter((value): value is NotificationRecord => value !== null)
	if (notifications.length === 0) return []
	try {
		const database = databaseFrom(env)
		await database.batch([
			...notifications.map((notification) =>
				insertStatement(database, ownerKey, notification),
			),
			pruneOwnerStatement(database, ownerKey),
		])
		return notifications.map((notification) => notification.id)
	} catch (error) {
		throw new NotificationStoreError(undefined, { cause: error })
	}
}

export async function markNotificationRead(
	env: Env,
	ownerKey: string,
	notificationId: string,
): Promise<void> {
	await databaseFrom(env).prepare(`
		UPDATE notifications SET read_at = COALESCE(read_at, ?1)
		WHERE owner_key = ?2 AND notification_id = ?3
	`).bind(new Date().toISOString(), ownerKey, notificationId).run()
}

export async function markAllNotificationsRead(env: Env, ownerKey: string): Promise<void> {
	await databaseFrom(env).prepare(`
		UPDATE notifications SET read_at = COALESCE(read_at, ?1)
		WHERE owner_key = ?2 AND expires_at > ?1
	`).bind(new Date().toISOString(), ownerKey).run()
}

export async function dismissNotification(
	env: Env,
	ownerKey: string,
	notificationId: string,
): Promise<void> {
	await databaseFrom(env).prepare(`
		DELETE FROM notifications WHERE owner_key = ?1 AND notification_id = ?2
	`).bind(ownerKey, notificationId).run()
}

export async function clearNotifications(env: Env, ownerKey: string): Promise<void> {
	await databaseFrom(env).prepare(
		'DELETE FROM notifications WHERE owner_key = ?1',
	).bind(ownerKey).run()
}

export async function cleanupExpiredNotifications(env: Env): Promise<void> {
	const database = databaseFrom(env)
	for (let pass = 0; pass < 10; pass += 1) {
		const result = await database.prepare(`
			DELETE FROM notifications
			WHERE rowid IN (
				SELECT rowid FROM notifications WHERE expires_at <= ?1 LIMIT 500
			)
		`).bind(new Date().toISOString()).run()
		if ((result.meta.changes ?? 0) < 500) break
	}
}

export function isNotificationId(value: string): boolean {
	return UUID_RE.test(value)
}
