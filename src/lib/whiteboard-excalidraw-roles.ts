/**
 * PHASE 3.3 — Excalidraw role + follow helpers.
 * Canvas should import this hook only; do not rewrite scene sync here.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
	CaptureUpdateAction,
	getVisibleSceneBounds,
	zoomToFitBounds,
} from '@excalidraw/excalidraw'
import type { Collaborator, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { getActiveIdentity } from './whiteboard-identity'
import {
	generateGuestDisplayName,
	peopleListLabel,
} from './whiteboard-display-name'
import {
	isForceFollowPayload,
	isParticipantsPayload,
	isRolePayload,
	normalizeForceFollowPayload,
	parseParticipantRow,
	rememberBoardSessionAuth,
	type ForceFollowPayload,
	type ParticipantRow,
	type WhiteboardRole,
} from './whiteboard-participants'
import {
	isGuestConnectUserId,
	isWhiteboardRole,
	roleCanEdit,
} from './whiteboard-sync'

const PARTICIPANTS_EVENT = 'scsfoxchase:whiteboard-participants'
const FOLLOW_EVENT = 'scsfoxchase:whiteboard-follow'
const FOLLOWING_EVENT = 'scsfoxchase:whiteboard-following'
const FORCE_FOLLOW_EVENT = 'scsfoxchase:whiteboard-force-follow'
const HELLO_EVENT = 'scsfoxchase:whiteboard-hello'
const BOUNDS_THROTTLE_MS = 120
/** Auto-pong keeps the socket OPEN without waking DO JS; resubscribe after this silence. */
export const FOLLOW_SOCKET_GAP_MS = 10_000

type UserToFollow = { socketId: string; username: string }

/**
 * Signed-out connect `userId` for this board page load. Module-local so
 * WebSocket reconnects keep the same guest; a new visit mints a new UUID.
 * Must not use localStorage `deviceInstallId` — that is Chromebook-lifetime
 * and would let period 2 inherit period 1's stored Editor role.
 */
let guestVisitUserId = ''

function getGuestVisitUserId(): string {
	if (guestVisitUserId && isGuestConnectUserId(guestVisitUserId)) {
		return guestVisitUserId
	}
	guestVisitUserId = crypto.randomUUID()
	return guestVisitUserId
}

export function getBoardConnectIdentity(): { displayName: string; userId: string } {
	const identity = getActiveIdentity()
	if (identity) {
		return {
			displayName: identity.displayName.slice(0, 48),
			userId: identity.accountId,
		}
	}
	const userId = getGuestVisitUserId()
	return {
		displayName: generateGuestDisplayName(userId),
		userId,
	}
}

function publishParticipants(
	participants: ParticipantRow[],
	yourSessionId: string,
	yourRole: WhiteboardRole,
) {
	if (typeof window === 'undefined') return
	window.dispatchEvent(
		new CustomEvent(PARTICIPANTS_EVENT, {
			detail: { participants, yourSessionId, yourRole },
		}),
	)
}

function publishFollowing(followingUserId: string | null) {
	if (typeof window === 'undefined') return
	window.dispatchEvent(
		new CustomEvent(FOLLOWING_EVENT, {
			detail: { followingUserId },
		}),
	)
}

function publishForceFollow(payload: ForceFollowPayload) {
	if (typeof window === 'undefined') return
	window.dispatchEvent(
		new CustomEvent(FORCE_FOLLOW_EVENT, {
			detail: payload,
		}),
	)
}

function publishHello(detail: {
	sessionId: string
	role: WhiteboardRole
	canEdit: boolean
	authToken: string
	title?: string
}) {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new CustomEvent(HELLO_EVENT, { detail }))
}

function parseBounds(value: unknown): [number, number, number, number] | null {
	if (!Array.isArray(value) || value.length !== 4) return null
	const nums = value.map((n) => Number(n))
	if (nums.some((n) => !Number.isFinite(n))) return null
	return [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
}

function collaboratorsFromPeople(
	people: ParticipantRow[],
	yourSessionId: string,
): Map<string, Collaborator> {
	const map = new Map<string, Collaborator>()
	for (const person of people) {
		if (!person.sessionId) continue
		map.set(person.sessionId, {
			id: person.userId || person.sessionId,
			socketId: person.sessionId as Collaborator['socketId'],
			username: peopleListLabel(person.displayName, person.sessionId),
			isCurrentUser: person.sessionId === yourSessionId,
		})
	}
	return map
}

function sceneCollaborators(
	people: ParticipantRow[],
	yourSessionId: string,
): Map<NonNullable<Collaborator['socketId']>, Collaborator> {
	return collaboratorsFromPeople(people, yourSessionId) as Map<
		NonNullable<Collaborator['socketId']>,
		Collaborator
	>
}

export function useWhiteboardExcalidrawRoles(opts: {
	boardId: string
	apiRef: RefObject<ExcalidrawImperativeAPI | null>
	wsRef: RefObject<WebSocket | null>
}) {
	const { boardId, apiRef, wsRef } = opts
	const [role, setRole] = useState<WhiteboardRole>('viewer')
	const [canEdit, setCanEdit] = useState(false)
	const [helloReceived, setHelloReceived] = useState(false)
	const [collaborators, setCollaborators] = useState<Map<string, Collaborator>>(
		() => new Map(),
	)
	const [displayName] = useState(() => getBoardConnectIdentity().displayName)

	const peopleRef = useRef<ParticipantRow[]>([])
	const sessionIdRef = useRef('')
	const userIdRef = useRef(getBoardConnectIdentity().userId)
	const roleRef = useRef<WhiteboardRole>('viewer')
	const voluntaryTargetRef = useRef<UserToFollow | null>(null)
	const forceFollowRef = useRef<ForceFollowPayload>({
		type: 'wb:forceFollow',
		forceFollow: false,
		targetUserId: '',
		targetSessionId: '',
		subjects: {},
	})
	const followedByRef = useRef(false)
	const applyingFollowRef = useRef(false)
	const applyingGenRef = useRef(0)
	const boundsTimerRef = useRef<number | null>(null)
	const lastBoundsJsonRef = useRef('')
	const lastRemoteBoundsBySocketRef = useRef(
		new Map<string, [number, number, number, number]>(),
	)
	const forceCameraRafRef = useRef<number | null>(null)
	const followPaintRafRef = useRef<number | null>(null)
	const pendingFollowApplyRef = useRef(false)
	const [forceFollowLocked, setForceFollowLocked] = useState(false)

	const beginApplyingFollow = () => {
		applyingFollowRef.current = true
		const gen = ++applyingGenRef.current
		requestAnimationFrame(() => {
			if (gen === applyingGenRef.current) {
				applyingFollowRef.current = false
			}
		})
	}

	const cancelForceCameraRaf = () => {
		if (forceCameraRafRef.current == null) return
		window.cancelAnimationFrame(forceCameraRafRef.current)
		forceCameraRafRef.current = null
	}

	const myUserId = () => userIdRef.current
	const mySessionId = () => sessionIdRef.current

	const findPerson = useCallback(
		(pred: (row: ParticipantRow) => boolean): ParticipantRow | undefined =>
			peopleRef.current.find(pred),
		[],
	)

	const forcedTarget = useCallback((): UserToFollow | null => {
		const state = forceFollowRef.current
		const uid = myUserId()
		const sid = mySessionId()
		let targetUserId = ''
		if (state.forceFollow && state.targetUserId) {
			targetUserId = state.targetUserId
		}
		if (uid && state.subjects[uid]) {
			targetUserId = state.subjects[uid]!
		}
		if (!targetUserId) return null
		if (targetUserId === uid) return null
		const person =
			findPerson((row) => row.userId === targetUserId) ||
			(state.targetSessionId
				? findPerson((row) => row.sessionId === state.targetSessionId)
				: undefined)
		if (!person) {
			if (state.targetSessionId && state.targetSessionId !== sid) {
				return {
					socketId: state.targetSessionId,
					username: 'Follow',
				}
			}
			return null
		}
		if (person.sessionId === sid) return null
		return {
			socketId: person.sessionId,
			username: peopleListLabel(person.displayName, person.sessionId),
		}
	}, [findPerson])

	const effectiveFollow = useCallback((): UserToFollow | null => {
		return forcedTarget() ?? voluntaryTargetRef.current
	}, [forcedTarget])

	const applyUserToFollow = useCallback(
		(target: UserToFollow | null) => {
			const api = apiRef.current
			if (!api) {
				pendingFollowApplyRef.current = true
				const person = target
					? findPerson((row) => row.sessionId === target.socketId)
					: undefined
				publishFollowing(person?.userId ?? (target ? target.socketId : null))
				return
			}
			pendingFollowApplyRef.current = false
			beginApplyingFollow()
			api.updateScene({
				collaborators: sceneCollaborators(
					peopleRef.current,
					sessionIdRef.current,
				),
				appState: {
					userToFollow: target
						? {
								socketId: target.socketId as Collaborator['socketId'],
								username: target.username,
							}
						: null,
				},
				captureUpdate: CaptureUpdateAction.NEVER,
			})
			const person = target
				? findPerson((row) => row.sessionId === target.socketId)
				: undefined
			publishFollowing(person?.userId ?? (target ? target.socketId : null))
		},
		[apiRef, findPerson],
	)

	const applyRemoteBounds = useCallback(
		(socketId: string, bounds: [number, number, number, number]) => {
			const target = effectiveFollow()
			if (!target || target.socketId !== socketId) return
			const api = apiRef.current
			if (!api) {
				pendingFollowApplyRef.current = true
				return
			}
			const current = api.getAppState()
			const next = zoomToFitBounds({
				bounds,
				appState: current,
				fitToViewport: true,
				viewportZoomFactor: 1,
			})
			const cameraFitted =
				current.scrollX === next.appState.scrollX &&
				current.scrollY === next.appState.scrollY &&
				current.zoom.value === next.appState.zoom.value
			beginApplyingFollow()
			api.updateScene({
				collaborators: sceneCollaborators(
					peopleRef.current,
					sessionIdRef.current,
				),
				appState: {
					...(cameraFitted ? {} : next.appState),
					userToFollow: {
						socketId: target.socketId as Collaborator['socketId'],
						username: target.username,
					},
				},
				captureUpdate: CaptureUpdateAction.NEVER,
			})
			const person = findPerson((row) => row.sessionId === target.socketId)
			publishFollowing(person?.userId ?? target.socketId)
		},
		[apiRef, effectiveFollow, findPerson],
	)

	const reassertFollow = useCallback(() => {
		const forced = forcedTarget()
		const target = forced ?? voluntaryTargetRef.current
		if (forced) {
			const cached = lastRemoteBoundsBySocketRef.current.get(forced.socketId)
			if (cached) {
				applyRemoteBounds(forced.socketId, cached)
				return
			}
		}
		applyUserToFollow(target)
	}, [applyRemoteBounds, applyUserToFollow, forcedTarget])

	const scheduleReassertAfterPaint = useCallback(() => {
		if (followPaintRafRef.current != null) {
			window.cancelAnimationFrame(followPaintRafRef.current)
		}
		followPaintRafRef.current = window.requestAnimationFrame(() => {
			followPaintRafRef.current = null
			reassertFollow()
		})
	}, [reassertFollow])

	const scheduleForceCameraLock = useCallback(() => {
		if (forceCameraRafRef.current != null) return
		forceCameraRafRef.current = window.requestAnimationFrame(() => {
			forceCameraRafRef.current = null
			if (!forcedTarget()) return
			reassertFollow()
		})
	}, [forcedTarget, reassertFollow])

	const sendJson = useCallback(
		(payload: unknown) => {
			const ws = wsRef.current
			if (!ws || ws.readyState !== WebSocket.OPEN) return
			ws.send(JSON.stringify(payload))
		},
		[wsRef],
	)

	const sendSceneBounds = useCallback(
		(force = false) => {
			const api = apiRef.current
			if (!api) return
			if (forcedTarget()) return
			if (!followedByRef.current && !force) return
			const bounds = getVisibleSceneBounds(api.getAppState())
			const json = JSON.stringify(bounds)
			if (!force && json === lastBoundsJsonRef.current) return
			lastBoundsJsonRef.current = json
			sendJson({
				type: 'wb:sceneBounds',
				socketId: mySessionId(),
				bounds,
			})
		},
		[apiRef, forcedTarget, sendJson],
	)

	const scheduleSceneBounds = useCallback(() => {
		if (!followedByRef.current) return
		if (boundsTimerRef.current != null) return
		boundsTimerRef.current = window.setTimeout(() => {
			boundsTimerRef.current = null
			sendSceneBounds()
		}, BOUNDS_THROTTLE_MS)
	}, [sendSceneBounds])

	const subscribeFollow = useCallback(
		(target: UserToFollow | null) => {
			sendJson({
				type: 'wb:follow',
				targetUserId: target
					? (findPerson((row) => row.sessionId === target.socketId)?.userId ??
						null)
					: null,
				targetSessionId: target?.socketId ?? null,
			})
		},
		[findPerson, sendJson],
	)

	/** Replay wb:follow while the socket is OPEN after a gap (open/reconnect or hibernation). */
	const resubscribeFollow = useCallback(() => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		const target = effectiveFollow()
		if (!target) return
		subscribeFollow(target)
	}, [effectiveFollow, subscribeFollow, wsRef])

	const setVoluntaryFollow = useCallback(
		(target: UserToFollow | null) => {
			if (forcedTarget()) return
			voluntaryTargetRef.current = target
			applyUserToFollow(target)
			subscribeFollow(target)
		},
		[applyUserToFollow, forcedTarget, subscribeFollow],
	)

	const onUserFollow = useCallback(
		(payload: { userToFollow: UserToFollow; action: 'FOLLOW' | 'UNFOLLOW' }) => {
			if (applyingFollowRef.current) return
			if (forcedTarget()) {
				cancelForceCameraRaf()
				reassertFollow()
				return
			}
			if (payload.action === 'UNFOLLOW') {
				if (voluntaryTargetRef.current) {
					voluntaryTargetRef.current = null
					subscribeFollow(null)
					publishFollowing(null)
				}
				return
			}
			voluntaryTargetRef.current = payload.userToFollow
			subscribeFollow(payload.userToFollow)
			const person = findPerson(
				(row) => row.sessionId === payload.userToFollow.socketId,
			)
			publishFollowing(person?.userId ?? payload.userToFollow.socketId)
		},
		[findPerson, forcedTarget, reassertFollow, subscribeFollow],
	)

	const onScrollChange = useCallback(() => {
		if (applyingFollowRef.current) return
		if (forcedTarget()) {
			scheduleForceCameraLock()
			return
		}
		scheduleSceneBounds()
	}, [forcedTarget, scheduleForceCameraLock, scheduleSceneBounds])

	const refreshFollowedBy = useCallback(() => {
		const sid = mySessionId()
		const uid = myUserId()
		const force = forceFollowRef.current
		const amRoomTarget =
			force.forceFollow &&
			Boolean(uid) &&
			(force.targetUserId === uid || force.targetSessionId === sid)
		const amSubjectTarget = Object.values(force.subjects).includes(uid)
		followedByRef.current = amRoomTarget || amSubjectTarget
		if (followedByRef.current) sendSceneBounds(true)
	}, [sendSceneBounds])

	const handleSocketMessage = useCallback(
		(data: Record<string, unknown>): boolean => {
			if (data.type === 'wb:hello') {
				const sessionId =
					typeof data.sessionId === 'string' ? data.sessionId : ''
				const nextRole: WhiteboardRole = isWhiteboardRole(data.role)
					? data.role
					: data.isHost
						? 'owner'
						: 'viewer'
				const authToken =
					typeof data.authToken === 'string' ? data.authToken : ''
				sessionIdRef.current = sessionId
				roleRef.current = nextRole
				setRole(nextRole)
				setCanEdit(roleCanEdit(nextRole))
				setHelloReceived(true)
				if (boardId && sessionId && authToken) {
					rememberBoardSessionAuth(boardId, {
						sessionId,
						authToken,
						role: nextRole,
					})
				}
				publishHello({
					sessionId,
					role: nextRole,
					canEdit: roleCanEdit(nextRole),
					authToken,
					title: typeof data.title === 'string' ? data.title : undefined,
				})
				resubscribeFollow()
				return true
			}

			if (data.type === 'wb:title' && typeof data.title === 'string') {
				publishHello({
					sessionId: sessionIdRef.current,
					role: roleRef.current,
					canEdit: roleCanEdit(roleRef.current),
					authToken: '',
					title: data.title,
				})
				return true
			}

			if (isRolePayload(data)) {
				roleRef.current = data.role
				setRole(data.role)
				setCanEdit(roleCanEdit(data.role))
				if (boardId) {
					const prev = {
						sessionId: sessionIdRef.current,
						authToken: '',
						role: data.role,
					}
					try {
						const raw = sessionStorage.getItem(
							`scsfoxchase.whiteboard.auth.${boardId}`,
						)
						if (raw) {
							const parsed = JSON.parse(raw) as { authToken?: string }
							if (typeof parsed.authToken === 'string') {
								prev.authToken = parsed.authToken
							}
						}
					} catch {
						// ignore
					}
					if (prev.sessionId && prev.authToken) {
						rememberBoardSessionAuth(boardId, prev)
					}
				}
				return true
			}

			if (isParticipantsPayload(data)) {
				const rows = data.participants
					.map(parseParticipantRow)
					.filter((row): row is ParticipantRow => Boolean(row))
				peopleRef.current = rows
				const yourSessionId =
					typeof data.yourSessionId === 'string'
						? data.yourSessionId
						: sessionIdRef.current
				sessionIdRef.current = yourSessionId
				const self = rows.find((row) => row.sessionId === yourSessionId)
				if (self) {
					userIdRef.current = self.userId || userIdRef.current
					roleRef.current = self.role
					setRole(self.role)
					setCanEdit(roleCanEdit(self.role))
				}
				const map = collaboratorsFromPeople(rows, yourSessionId)
				setCollaborators(map)
				const api = apiRef.current
				if (api) {
					api.updateScene({
						collaborators: sceneCollaborators(rows, yourSessionId),
						captureUpdate: CaptureUpdateAction.NEVER,
					})
				} else {
					pendingFollowApplyRef.current = true
				}
				publishParticipants(
					rows,
					yourSessionId,
					self?.role ?? roleRef.current,
				)
				setForceFollowLocked(Boolean(forcedTarget()))
				refreshFollowedBy()
				scheduleReassertAfterPaint()
				return true
			}

			if (isForceFollowPayload(data)) {
				const payload = normalizeForceFollowPayload(data)
				forceFollowRef.current = payload
				publishForceFollow(payload)
				if (payload.forceFollow) {
					voluntaryTargetRef.current = null
				}
				setForceFollowLocked(Boolean(forcedTarget()))
				refreshFollowedBy()
				scheduleReassertAfterPaint()
				subscribeFollow(effectiveFollow())
				return true
			}

			if (data.type === 'wb:followedBy') {
				followedByRef.current = Boolean(data.followed)
				if (followedByRef.current) sendSceneBounds(true)
				return true
			}

			if (data.type === 'wb:sceneBounds') {
				const socketId =
					typeof data.socketId === 'string' ? data.socketId : ''
				const bounds = parseBounds(data.bounds)
				if (socketId && bounds) {
					lastRemoteBoundsBySocketRef.current.set(socketId, bounds)
					applyRemoteBounds(socketId, bounds)
				}
				return true
			}

			return false
		},
		[
			applyRemoteBounds,
			apiRef,
			boardId,
			effectiveFollow,
			forcedTarget,
			refreshFollowedBy,
			resubscribeFollow,
			scheduleReassertAfterPaint,
			sendSceneBounds,
			subscribeFollow,
		],
	)

	useEffect(() => {
		const onFollowRequest = (event: Event) => {
			const detail = (event as CustomEvent<{ userId?: string }>).detail
			const userId = typeof detail?.userId === 'string' ? detail.userId : ''
			if (!userId) {
				setVoluntaryFollow(null)
				return
			}
			const current = effectiveFollow()
			const person = findPerson((row) => row.userId === userId)
			if (!person) return
			if (current && person.sessionId === current.socketId) {
				setVoluntaryFollow(null)
				return
			}
			setVoluntaryFollow({
				socketId: person.sessionId,
				username: peopleListLabel(person.displayName, person.sessionId),
			})
		}
		window.addEventListener(FOLLOW_EVENT, onFollowRequest)
		return () => window.removeEventListener(FOLLOW_EVENT, onFollowRequest)
	}, [effectiveFollow, findPerson, setVoluntaryFollow])

	useEffect(() => {
		if (!helloReceived) return
		const api = apiRef.current
		if (!api) return
		const locked = !roleCanEdit(role)
		api.updateScene({
			appState: { viewModeEnabled: locked },
			captureUpdate: CaptureUpdateAction.NEVER,
		})
	}, [apiRef, helloReceived, role])

	useEffect(() => {
		scheduleReassertAfterPaint()
	}, [collaborators, role, canEdit, forceFollowLocked, scheduleReassertAfterPaint])

	useEffect(() => {
		return () => {
			if (boundsTimerRef.current != null) {
				window.clearTimeout(boundsTimerRef.current)
			}
			cancelForceCameraRaf()
			if (followPaintRafRef.current != null) {
				window.cancelAnimationFrame(followPaintRafRef.current)
			}
		}
	}, [])

	return {
		role,
		canEdit,
		helloReceived,
		viewModeEnabled: !roleCanEdit(role),
		forceFollowLocked,
		displayName,
		collaborators,
		onUserFollow,
		onScrollChange,
		handleSocketMessage,
		reassertFollow,
		resubscribeFollow,
	}
}
