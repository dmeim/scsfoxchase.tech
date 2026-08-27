/**
 * Client helpers for Phase 3.3 roles + retargetable force-follow.
 * PATCH /api/whiteboard/boards/:uuid/participants/:sessionId
 * PATCH /api/whiteboard/boards/:uuid/force-follow
 */

import { getHostSecret } from '../scripts/whiteboard-library'
import {
	isAssignableRole,
	isWhiteboardRole,
	isWbAuthReason,
	roleCanEdit,
	type AssignableRole,
	type WbAuthReason,
	type WhiteboardRole,
} from './whiteboard-sync'

export type { AssignableRole, WhiteboardRole }

export type ParticipantRow = {
	sessionId: string
	userId: string
	displayName: string
	role: WhiteboardRole
	canEdit: boolean
	isHost: boolean
}

export type ParticipantsPayload = {
	type: 'wb:participants'
	yourSessionId: string
	yourRole: WhiteboardRole
	participants: ParticipantRow[]
}

export type RolePayload = {
	type: 'wb:role'
	role: WhiteboardRole
	canEdit: boolean
	roleResolved?: boolean
}

export type AuthResultPayload = {
	type: 'wb:authResult'
	accepted: boolean
	roleResolved: boolean
	role: WhiteboardRole
	reason?: WbAuthReason
}

export type ForceFollowPayload = {
	type: 'wb:forceFollow'
	forceFollow: boolean
	targetUserId: string
	targetSessionId: string
	subjects: Record<string, string>
}

const AUTH_STORAGE_PREFIX = 'scsfoxchase.whiteboard.auth.'

export type BoardSessionAuth = {
	sessionId: string
	authToken: string
	role: WhiteboardRole
}

export function boardAuthStorageKey(boardId: string): string {
	return `${AUTH_STORAGE_PREFIX}${boardId}`
}

export function rememberBoardSessionAuth(
	boardId: string,
	auth: BoardSessionAuth,
): void {
	try {
		sessionStorage.setItem(boardAuthStorageKey(boardId), JSON.stringify(auth))
	} catch {
		// private mode
	}
}

export function getBoardSessionAuth(boardId: string): BoardSessionAuth | null {
	try {
		const raw = sessionStorage.getItem(boardAuthStorageKey(boardId))
		if (!raw) return null
		const parsed = JSON.parse(raw) as Partial<BoardSessionAuth>
		if (
			typeof parsed.sessionId !== 'string' ||
			typeof parsed.authToken !== 'string' ||
			!isWhiteboardRole(parsed.role)
		) {
			return null
		}
		return {
			sessionId: parsed.sessionId,
			authToken: parsed.authToken,
			role: parsed.role,
		}
	} catch {
		return null
	}
}

export function parseParticipantRow(value: unknown): ParticipantRow | null {
	if (!value || typeof value !== 'object') return null
	const row = value as Record<string, unknown>
	if (typeof row.sessionId !== 'string' || !row.sessionId) return null
	const role = isWhiteboardRole(row.role)
		? row.role
		: row.isHost
			? 'owner'
			: row.canEdit === false
				? 'viewer'
				: 'editor'
	return {
		sessionId: row.sessionId,
		userId: typeof row.userId === 'string' ? row.userId : '',
		displayName: typeof row.displayName === 'string' ? row.displayName : '',
		role,
		canEdit: typeof row.canEdit === 'boolean' ? row.canEdit : roleCanEdit(role),
		isHost: Boolean(row.isHost),
	}
}

export function isParticipantsPayload(data: unknown): data is ParticipantsPayload {
	if (!data || typeof data !== 'object') return false
	const d = data as Record<string, unknown>
	return d.type === 'wb:participants' && Array.isArray(d.participants)
}

export function isRolePayload(data: unknown): data is RolePayload {
	if (!data || typeof data !== 'object') return false
	const d = data as Record<string, unknown>
	return d.type === 'wb:role' && isWhiteboardRole(d.role)
}

export function isAuthResultPayload(data: unknown): data is AuthResultPayload {
	if (!data || typeof data !== 'object') return false
	const d = data as Record<string, unknown>
	return (
		d.type === 'wb:authResult' &&
		typeof d.accepted === 'boolean' &&
		typeof d.roleResolved === 'boolean' &&
		isWhiteboardRole(d.role) &&
		(d.reason === undefined || isWbAuthReason(d.reason))
	)
}

export function isForceFollowPayload(data: unknown): data is ForceFollowPayload {
	if (!data || typeof data !== 'object') return false
	const d = data as Record<string, unknown>
	if (d.type !== 'wb:forceFollow' || typeof d.forceFollow !== 'boolean') {
		return false
	}
	return true
}

export function normalizeForceFollowPayload(data: ForceFollowPayload | Record<string, unknown>): ForceFollowPayload {
	const subjects =
		data.subjects && typeof data.subjects === 'object' && !Array.isArray(data.subjects)
			? (data.subjects as Record<string, string>)
			: {}
	const targetUserId =
		typeof data.targetUserId === 'string'
			? data.targetUserId
			: typeof (data as { hostUserId?: unknown }).hostUserId === 'string'
				? ((data as { hostUserId: string }).hostUserId)
				: ''
	return {
		type: 'wb:forceFollow',
		forceFollow: Boolean(data.forceFollow),
		targetUserId,
		targetSessionId:
			typeof data.targetSessionId === 'string' ? data.targetSessionId : '',
		subjects,
	}
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		return (await res.json()) as Record<string, unknown>
	} catch {
		return {}
	}
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
	return typeof body.error === 'string' && body.error ? body.error : fallback
}

function actorHeaders(boardId: string): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	}
	const hostSecret = getHostSecret(boardId)
	if (hostSecret) {
		headers.Authorization = `Bearer ${hostSecret}`
		headers['X-Board-Host'] = hostSecret
	}
	const sessionAuth = getBoardSessionAuth(boardId)
	if (sessionAuth) {
		headers['X-Board-Session'] = sessionAuth.sessionId
		headers['X-Board-Auth'] = sessionAuth.authToken
	}
	return headers
}

function hasActorProof(boardId: string): boolean {
	return Boolean(getHostSecret(boardId) || getBoardSessionAuth(boardId)?.authToken)
}

/** Owner / Manager: set a connected participant's role. */
export async function setParticipantRole(
	boardId: string,
	sessionId: string,
	role: AssignableRole,
): Promise<ParticipantRow> {
	if (!hasActorProof(boardId)) {
		throw new Error('Only the Owner or a Manager can change roles.')
	}
	if (!isAssignableRole(role)) {
		throw new Error('Invalid role.')
	}

	const res = await fetch(
		`/api/whiteboard/boards/${encodeURIComponent(boardId)}/participants/${encodeURIComponent(sessionId)}`,
		{
			method: 'PATCH',
			headers: actorHeaders(boardId),
			body: JSON.stringify({ role }),
		},
	)
	const body = await readJson(res)
	if (!res.ok) {
		throw new Error(errorMessage(body, 'Could not update role.'))
	}

	return (
		parseParticipantRow(body) ?? {
			sessionId,
			userId: typeof body.userId === 'string' ? body.userId : '',
			displayName: typeof body.displayName === 'string' ? body.displayName : '',
			role,
			canEdit: roleCanEdit(role),
			isHost: Boolean(body.isHost),
		}
	)
}

export type ForceFollowResult = {
	forceFollow: boolean
	targetUserId: string
	targetSessionId: string
	subjects: Record<string, string>
}

/** Owner / Manager: force the room (or one person) to follow a target. */
export async function setForceFollow(
	boardId: string,
	forceFollow: boolean,
	opts?: { targetUserId?: string; subjectUserId?: string },
): Promise<ForceFollowResult> {
	if (!hasActorProof(boardId)) {
		throw new Error('Only the Owner or a Manager can force follow.')
	}

	const res = await fetch(
		`/api/whiteboard/boards/${encodeURIComponent(boardId)}/force-follow`,
		{
			method: 'PATCH',
			headers: actorHeaders(boardId),
			body: JSON.stringify({
				forceFollow,
				...(opts?.targetUserId ? { targetUserId: opts.targetUserId } : {}),
				...(opts?.subjectUserId ? { subjectUserId: opts.subjectUserId } : {}),
			}),
		},
	)
	const body = await readJson(res)
	if (!res.ok) {
		throw new Error(errorMessage(body, 'Could not update force follow.'))
	}

	const subjects =
		body.subjects && typeof body.subjects === 'object' && !Array.isArray(body.subjects)
			? (body.subjects as Record<string, string>)
			: {}

	return {
		forceFollow: Boolean(body.forceFollow),
		targetUserId: typeof body.targetUserId === 'string' ? body.targetUserId : '',
		targetSessionId:
			typeof body.targetSessionId === 'string' ? body.targetSessionId : '',
		subjects,
	}
}
