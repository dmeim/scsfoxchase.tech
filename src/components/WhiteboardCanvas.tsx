import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  getSceneVersion,
  reconcileElements,
  restoreElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import {
  getActiveIdentity,
  getSessionTokenFresh,
  getSessionTokenSettled,
  isSignedIn,
  onAuthChange,
  peekSessionToken,
  whenAuthReady,
} from '../lib/whiteboard-identity'
import {
  buildWhiteboardConnectUrl,
  CLIENT_PING_MS,
  elementsWithIncreasedVersion,
  getOrCreateSessionId,
  isMutationId,
  mergeSceneElements,
  preflightSceneMutationFrame,
  reconnectDelayMs,
  rememberElementVersions,
  sceneOutboxAcknowledge,
  sceneOutboxClearPending,
  sceneOutboxQueue,
  sceneOutboxReplay,
  sceneOutboxRetry,
  sceneOutboxStart,
  sceneOutboxTerminalFailure,
  SCENE_EDIT_NOT_ALLOWED_CODE,
  SCENE_EDIT_NOT_ALLOWED_MESSAGE,
  SCENE_MALFORMED_CODE,
  SCENE_MALFORMED_MESSAGE,
  SCENE_PERSIST_FAILED_CODE,
  SCENE_TOO_LARGE_CODE,
  SCENE_TOO_LARGE_MESSAGE,
  SCENE_FLUSH_MS,
  type SceneAppState,
  type SceneElement,
  type SceneMutationFrame,
  type SceneOutboxState,
} from '../lib/whiteboard-sync'
import { getHostSecret } from '../scripts/whiteboard-library'
// PHASE 3.2
import { useWhiteboardExcalidrawFiles } from '../lib/whiteboard-excalidraw-files'
// PHASE 3.3
import {
  FOLLOW_SOCKET_GAP_MS,
  getBoardConnectIdentity,
  useWhiteboardExcalidrawRoles,
} from '../lib/whiteboard-excalidraw-roles'
import {
	bindPreviewLifecycle,
  createPreviewCoordinator,
  exportBoardPreview,
  uploadBoardPreview,
  type PreviewCoordinator,
} from '../lib/whiteboard-preview'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Backoff for re-checking Clerk after a `wb:auth` the server did not accept. */
const AUTH_RETRY_MS = 1000
const AUTH_RETRY_MAX_MS = 10_000
const AUTH_RETRY_GIVE_UP_MS = 60_000

function readBoardIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const pathMatch = window.location.pathname.match(/\/board\/([^/]+)\/?$/i)
  if (pathMatch?.[1]) {
    const id = decodeURIComponent(pathMatch[1])
    if (UUID_RE.test(id)) return id
  }

  return undefined
}

function ensureExcalidrawAssetPath() {
  if (typeof window === 'undefined') return
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'
}

function immutableSceneElements(
	elements: readonly SceneElement[],
): readonly SceneElement[] {
	return Object.freeze(
		elements.map((element) => Object.freeze({ ...element })),
	)
}

ensureExcalidrawAssetPath()

type WhiteboardCanvasProps = {
  boardId?: string
}

type OutboxMutation = Omit<SceneMutationFrame, 'type'>
type PendingSceneMutation = {
  elements: readonly OrderedExcalidrawElement[]
  appState: AppState
  /** Revision observed when this coalesced snapshot was captured. */
  baseRevision: number
}

/**
 * Whiteboard canvas island. Phase 2: Durable Object WebSocket collab.
 * Remote applies use CaptureUpdateAction.NEVER so they stay out of undo.
 */
export default function WhiteboardCanvas({
  boardId: boardIdProp,
}: WhiteboardCanvasProps) {
  const boardId = boardIdProp ?? readBoardIdFromLocation() ?? ''
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const applyingRemoteRef = useRef(false)
  const lastSceneVersionRef = useRef(0)
  /** Observed scene versions are only a local dirty detector. */
  const observedElementVersionsRef = useRef(new Map<string, number>())
  /** Versions are retired only after an ack for their exact mutation. */
  const ackedElementVersionsRef = useRef(new Map<string, number>())
  /** Server's durable scene order; mutation frames carry this as their base. */
  const sceneRevisionRef = useRef(0)
  const forceFullNextRef = useRef(false)
  const outboxRef = useRef<
    SceneOutboxState<OutboxMutation, PendingSceneMutation>
  >({ inFlight: null, pending: null })
  const mutationSocketRef = useRef<WebSocket | null>(null)
  const flushTimerRef = useRef<number | null>(null)
  const fullSyncCounterRef = useRef(0)
  const pendingRemoteRef = useRef<{
    elements: SceneElement[]
    appState: SceneAppState | null
    revision?: number
  } | null>(null)
  /**
   * True once this Excalidraw instance has applied a server scene. Outgoing
   * updates are blocked until then — a freshly (re)mounted empty canvas must
   * never push a full (empty) scene over the stored board.
   */
  const sceneHydratedRef = useRef(false)
  /**
   * True once `wb:auth` has been sent on the current socket. The server drops
   * every message until auth, so sends before this would be lost while still
   * being marked as delivered by version bookkeeping.
   */
  const authSentRef = useRef(false)
  /**
   * True once the server has greeted the *current* socket. `roles.helloReceived`
   * is sticky for the page, so it cannot tell a reconnect whether this socket's
   * `wb:auth` was accepted.
   */
  const helloOnSocketRef = useRef(false)
  const persistErrorToastAtRef = useRef(0)
  const previewSkipOwnerRef = useRef(false)
  const previewCoordinatorRef = useRef<PreviewCoordinator | null>(null)
  // PHASE 3.2
  const media = useWhiteboardExcalidrawFiles(boardId, apiRef)

  // PHASE 3.3
  const roles = useWhiteboardExcalidrawRoles({ boardId, apiRef, wsRef })
  const handleRoleMessageRef = useRef(roles.handleSocketMessage)
  handleRoleMessageRef.current = roles.handleSocketMessage
  const onUserFollowRef = useRef(roles.onUserFollow)
  onUserFollowRef.current = roles.onUserFollow
  const reassertFollowRef = useRef(roles.reassertFollow)
  reassertFollowRef.current = roles.reassertFollow
  const resubscribeFollowRef = useRef(roles.resubscribeFollow)
  resubscribeFollowRef.current = roles.resubscribeFollow
  const unsubUserFollowRef = useRef<(() => void) | null>(null)
  const canEditRef = useRef(roles.canEdit)
  canEditRef.current = roles.canEdit
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || !roles.forceFollowLocked) return
    const stop = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const opts: AddEventListenerOptions = { capture: true, passive: false }
    const types = [
      'wheel',
      'gesturestart',
      'gesturechange',
      'gestureend',
      'pointerdown',
      'touchstart',
      'touchmove',
    ] as const
    for (const type of types) {
      el.addEventListener(type, stop, opts)
    }
    return () => {
      for (const type of types) {
        el.removeEventListener(type, stop, opts)
      }
    }
  }, [roles.forceFollowLocked])

  useEffect(() => {
    return () => {
      unsubUserFollowRef.current?.()
      unsubUserFollowRef.current = null
    }
  }, [])

  useEffect(() => {
    ensureExcalidrawAssetPath()
    const root = document.documentElement
    const syncTheme = () => {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
    }
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const applyRemoteElements = useCallback(
    (
      remoteElements: SceneElement[],
      remoteAppState: SceneAppState | null,
      revision?: number,
    ) => {
      // This is the server baseline, not the reconciled local scene. In
      // particular, do not mark local-only elements as acknowledged merely
      // because reconcileElements returned them in the rendered scene.
      rememberElementVersions(
        remoteElements,
        ackedElementVersionsRef.current,
      )
      if (
        typeof revision === 'number' &&
        Number.isSafeInteger(revision) &&
        revision >= sceneRevisionRef.current
      ) {
        sceneRevisionRef.current = revision
      }
      const api = apiRef.current
      if (!api) {
        const pending = pendingRemoteRef.current
        if (!pending) {
          pendingRemoteRef.current = {
            elements: remoteElements,
            appState: remoteAppState,
            revision,
          }
        } else {
          pendingRemoteRef.current = {
            elements: mergeSceneElements(pending.elements, remoteElements).next,
            appState: remoteAppState ?? pending.appState,
            revision:
              revision === undefined
                ? pending.revision
                : Math.max(revision, pending.revision ?? 0),
          }
        }
        return
      }
      applyingRemoteRef.current = true
      try {
        const local = api.getSceneElementsIncludingDeleted()
        const localAppState = api.getAppState()
        const restored = restoreElements(
          remoteElements as unknown as Parameters<typeof restoreElements>[0],
          local,
        )
        const reconciled = reconcileElements(
          local,
          restored as unknown as Parameters<typeof reconcileElements>[1],
          localAppState,
        )
        const viewBackgroundColor =
          typeof remoteAppState?.viewBackgroundColor === 'string'
            ? remoteAppState.viewBackgroundColor
            : undefined
        api.updateScene({
          elements: reconciled,
          ...(viewBackgroundColor
            ? { appState: { viewBackgroundColor } }
            : {}),
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        lastSceneVersionRef.current = getSceneVersion(reconciled)
        // Keep the local observed map separate from the server ack baseline.
        rememberElementVersions(
          reconciled as SceneElement[],
          observedElementVersionsRef.current,
        )
        sceneHydratedRef.current = true
      } finally {
        queueMicrotask(() => {
          applyingRemoteRef.current = false
        })
      }
    },
    [],
  )

  type MutationSendResult = 'sent' | 'not-ready' | 'terminal'

  const showClientSceneError = useCallback(
    (code: 'scene_too_large' | 'malformed_scene' | 'edit_not_allowed') => {
      const now = Date.now()
      if (now - persistErrorToastAtRef.current < 5000) return
      persistErrorToastAtRef.current = now
      apiRef.current?.setToast?.({
        message:
          code === SCENE_EDIT_NOT_ALLOWED_CODE
            ? SCENE_EDIT_NOT_ALLOWED_MESSAGE
            : code === SCENE_MALFORMED_CODE
              ? SCENE_MALFORMED_MESSAGE
              : SCENE_TOO_LARGE_MESSAGE,
        duration: 8000,
        closable: true,
      })
    },
    [],
  )

  const sendMutationFrame = useCallback(
    (
      mutation: {
        mutationId: string
        elements: readonly SceneElement[]
        full: boolean
        databaseJson?: string
        baseRevision?: number
      },
      ws: WebSocket,
    ): MutationSendResult => {
      if (
        ws.readyState !== WebSocket.OPEN ||
        !authSentRef.current ||
        !sceneHydratedRef.current
      ) {
        return 'not-ready'
      }
      const preflight = preflightSceneMutationFrame(mutation)
      if (!preflight.ok) {
        showClientSceneError(preflight.code)
        return 'terminal'
      }
      try {
        ws.send(preflight.json)
      } catch {
        return 'not-ready'
      }
      mutationSocketRef.current = ws
      return 'sent'
    },
    [showClientSceneError],
  )

  const sendSceneUpdate = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      forceFull: boolean,
      forceDispatch = false,
      baseRevisionOverride?: number,
    ): MutationSendResult => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return 'not-ready'
      if (applyingRemoteRef.current) return 'not-ready'
      if (!canEditRef.current || !sceneHydratedRef.current) return 'not-ready'
      // Exactly one immutable mutation may be in flight. The caller retains
      // the latest snapshot as the sole coalesced queued item until its ack.
      if (outboxRef.current.inFlight) return 'not-ready'

      const version = getSceneVersion(elements)
      const asScene = elements as unknown as SceneElement[]
      const dirty = elementsWithIncreasedVersion(
        asScene,
        ackedElementVersionsRef.current,
      )
      if (!forceDispatch && dirty.length === 0) {
        lastSceneVersionRef.current = version
        return 'sent'
      }

      fullSyncCounterRef.current += 1
      const full =
        forceFull ||
        forceFullNextRef.current ||
        fullSyncCounterRef.current % 15 === 0
      forceFullNextRef.current = false
      // A coalesced local snapshot is an explicit delivery obligation. Keep
      // its elements in the retry even if a peer frame happened to advance
      // the server baseline to the same versions in the meantime.
      const payload = immutableSceneElements(
        full || forceDispatch ? asScene : dirty,
      )
      let databaseJson: string | undefined
      try {
        databaseJson = serializeAsJSON(
          elements,
          { ...appState, viewModeEnabled: false },
          {},
          'database',
        )
      } catch {
        showClientSceneError(SCENE_MALFORMED_CODE)
        return 'terminal'
      }
      const mutationId = crypto.randomUUID()
      if (!isMutationId(mutationId)) return 'terminal'
      const mutation = {
        mutationId,
        elements: payload,
        full,
        baseRevision: baseRevisionOverride ?? sceneRevisionRef.current,
        ...(databaseJson ? { databaseJson } : {}),
      }
      const sendResult = sendMutationFrame(mutation, ws)
      if (sendResult !== 'sent') return sendResult
      outboxRef.current = sceneOutboxStart(outboxRef.current, mutation)
      rememberElementVersions(payload, observedElementVersionsRef.current)
      lastSceneVersionRef.current = version
      return 'sent'
    },
    [sendMutationFrame, showClientSceneError],
  )

  const flushPending = useCallback(
    (forceFull = false) => {
      const ws = wsRef.current
      const inFlight = sceneOutboxReplay(outboxRef.current)
      if (inFlight) {
        // A reconnect gets the exact same ID and payload. Do not replay it on
        // the same socket merely because a remote scene arrived.
        if (ws && mutationSocketRef.current !== ws) {
          const replay = sendMutationFrame(inFlight, ws)
          if (replay === 'terminal') {
            outboxRef.current = sceneOutboxTerminalFailure(outboxRef.current)
            mutationSocketRef.current = null
            queueMicrotask(() => flushNowRef.current(false))
          }
        }
        return
      }
      const pending = outboxRef.current.pending
      if (!pending) return
      const sent = sendSceneUpdate(
        pending.elements,
        pending.appState,
        forceFull,
        true,
        pending.baseRevision,
      )
      if (sent === 'sent' || sent === 'terminal') {
        if (sent === 'terminal') {
          outboxRef.current = sceneOutboxClearPending(outboxRef.current)
        }
      }
    },
    [sendMutationFrame, sendSceneUpdate],
  )

  const flushNow = useCallback(
    (forceFull = false) => {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      flushPending(forceFull)
    },
    [flushPending],
  )
  const flushNowRef = useRef(flushNow)
  flushNowRef.current = flushNow

  if (!previewCoordinatorRef.current) {
    previewCoordinatorRef.current = createPreviewCoordinator({
      getVersion: () => {
        const api = apiRef.current
        return api ? getSceneVersion(api.getSceneElementsIncludingDeleted()) : 0
      },
      canCapture: () => {
        const api = apiRef.current
        return Boolean(
          api &&
            canEditRef.current &&
            sceneHydratedRef.current &&
            !previewSkipOwnerRef.current,
        )
      },
      exportPreview: () => {
        const api = apiRef.current
        return api ? exportBoardPreview(api) : Promise.resolve(null)
      },
      uploadPreview: (blob, keepalive) =>
        uploadBoardPreview({ boardId, blob, keepalive }),
      isVisible: () =>
        typeof document === 'undefined' || document.visibilityState === 'visible',
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timer) => window.clearTimeout(timer),
      onTerminalStatus: (status) => {
        if (status === 'skipped-not-owner' || status === 'skipped-deleted') {
          previewSkipOwnerRef.current = true
        }
      },
    })
  }

  useEffect(() => {
    // Role changes can make capture illegal without remounting the component.
    // Invalidate pending exports before a late completion can cache/upload.
    previewCoordinatorRef.current?.invalidate()
  }, [roles.canEdit, roles.role])

  const schedulePreviewCapture = useCallback(() => {
    if (previewSkipOwnerRef.current) return
    if (!isSignedIn()) return
    previewCoordinatorRef.current?.scheduleCapture()
  }, [])

  const handleChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      // PHASE 3.2 — upload/hydrate R2 files; do not gate on remote-apply.
      media.syncFiles(elements, files)
      if (applyingRemoteRef.current) return
      if (!canEditRef.current) return
      // Nothing this instance holds is trustworthy until a server scene lands.
      if (!sceneHydratedRef.current) return
      const version = getSceneVersion(elements)
      if (version === lastSceneVersionRef.current) return
      outboxRef.current = sceneOutboxQueue(outboxRef.current, {
        // Excalidraw reuses/mutates scene objects between callbacks. Keep one
        // immutable queued snapshot so a retry cannot change underneath it.
        elements: immutableSceneElements(
          elements as unknown as SceneElement[],
        ) as unknown as readonly OrderedExcalidrawElement[],
        appState: { ...appState },
        baseRevision: sceneRevisionRef.current,
      })
      schedulePreviewCapture()
      if (flushTimerRef.current != null) return
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        flushPending()
      }, SCENE_FLUSH_MS)
    },
    [flushPending, media.syncFiles, schedulePreviewCapture],
  )

  useEffect(() => {
    const persist = () => {
      flushNowRef.current(true)
      previewCoordinatorRef.current?.persist()
    }
    return bindPreviewLifecycle(
      { window, document },
      { persist, visible: () => previewCoordinatorRef.current?.visible() },
    )
  }, [])

  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    let pingTimer: number | null = null
    let resyncTimer: number | null = null
    let reconnectTimer: number | null = null
    let authRetryTimer: number | null = null
    let authFetchInFlight = false
    let authStartedAt = 0
    let lastAuthTokenSent = ''
    let lastAuthSignedInSent = false
    let attempt = 0
    let preserveReconnectBackoff = false
    let lastSocketJsAt = 0
    let observedIdentity = getActiveIdentity()
    let refreshProfileOnNextAuth = false

    const clearAuthRetry = () => {
      if (authRetryTimer == null) return
      window.clearTimeout(authRetryTimer)
      authRetryTimer = null
    }

    const clearTimers = () => {
      if (pingTimer != null) {
        window.clearInterval(pingTimer)
        pingTimer = null
      }
      if (resyncTimer != null) {
        window.clearInterval(resyncTimer)
        resyncTimer = null
      }
    }

    /**
     * Send one `wb:auth` frame. `signedIn` always reflects this tab's own view
     * of Clerk, even when a token is attached: the server cannot otherwise
     * tell "this token failed to verify" apart from "this is a guest", and
     * would greet a real Owner as Viewer. Only a frame the server can act on
     * unlocks outgoing scene updates — it drops everything until a socket is
     * greeted, and silently dropped sends would still be marked delivered.
     */
    const sendAuthFrame = (ws: WebSocket, token: string) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const hostSecret = getHostSecret(boardId)
      const signedIn = isSignedIn()
      const identity = getActiveIdentity()
      const refreshProfile = Boolean(token && refreshProfileOnNextAuth)
      ws.send(
        JSON.stringify({
          type: 'wb:auth',
          ...(token ? { token } : {}),
          ...(hostSecret ? { hostSecret } : {}),
          ...(signedIn ? { signedIn: true } : {}),
          ...(token && identity?.profileUpdatedAt
            ? { profileUpdatedAt: identity.profileUpdatedAt }
            : {}),
          ...(refreshProfile ? { refreshProfile: true } : {}),
        }),
      )
      if (refreshProfile) refreshProfileOnNextAuth = false
      lastAuthTokenSent = token
      lastAuthSignedInSent = signedIn
      // Resubscribe wb:follow on open/reconnect while the socket is OPEN.
      resubscribeFollowRef.current()
    }

    /**
     * After the first `wb:auth`, keep retrying a fresh signed-in JWT until the
     * server greets this socket (or 60s). A token can be expired or Clerk can
     * transiently fail verification, so merely sending one is not success.
     */
    const scheduleAuthRetry = (ws: WebSocket, delay: number) => {
      authRetryTimer = window.setTimeout(() => {
        authRetryTimer = null
        if (cancelled || wsRef.current !== ws) return
        if (helloOnSocketRef.current) return
        if (!isSignedIn()) {
          if (!helloOnSocketRef.current) sendAuthFrame(ws, '')
          return
        }
        if (Date.now() - authStartedAt > AUTH_RETRY_GIVE_UP_MS) {
          if (!helloOnSocketRef.current) {
            apiRef.current?.setToast?.({
              message:
                'Sign-in is taking too long. Reload the page to edit this board.',
              duration: 10000,
              closable: true,
            })
          }
          return
        }
        if (authFetchInFlight) {
          scheduleAuthRetry(ws, delay)
          return
        }
        authFetchInFlight = true
        void getSessionTokenFresh()
          .then((value) => {
            const token = value?.trim() ?? ''
            if (cancelled || wsRef.current !== ws) return
            if (token) sendAuthFrame(ws, token)
          })
          .finally(() => {
            authFetchInFlight = false
            if (cancelled || wsRef.current !== ws || helloOnSocketRef.current) {
              return
            }
            scheduleAuthRetry(ws, Math.min(delay * 2, AUTH_RETRY_MAX_MS))
          })
      }, delay)
    }

    /**
     * First `wb:auth` on WebSocket `open` — host secret + signedIn if known +
     * token only if already cached. Do not await Clerk first: a hang must not
     * block this frame and leave Connecting forever.
     */
    const sendConnectAuth = (ws: WebSocket) => {
      authStartedAt = Date.now()
      sendAuthFrame(ws, peekSessionToken()?.trim() ?? '')

      void (async () => {
        await whenAuthReady()
        if (cancelled || wsRef.current !== ws) return
        const signedIn = isSignedIn()
        const next = signedIn
          ? ((await getSessionTokenSettled())?.trim() ?? '')
          : ''
        if (cancelled || wsRef.current !== ws) return
        if (next !== lastAuthTokenSent || signedIn !== lastAuthSignedInSent) {
          sendAuthFrame(ws, next)
        }
        if (signedIn && !helloOnSocketRef.current) {
          scheduleAuthRetry(ws, AUTH_RETRY_MS)
        }
      })()
    }

    const connect = () => {
      if (cancelled) return

      const identity = getBoardConnectIdentity()
      const sessionId = getOrCreateSessionId(boardId)
      // Guest identity hint only. Signed-in users are identified by the
      // verified `wb:auth` JWT; a non-UUID userId is dropped from the URL.
      const uri = buildWhiteboardConnectUrl(window.location.origin, {
        boardId,
        sessionId,
        displayName: identity.displayName,
        userId: identity.userId,
      })

      authSentRef.current = false
      helloOnSocketRef.current = false
      lastAuthTokenSent = ''
      lastAuthSignedInSent = false
      clearAuthRetry()
      const ws = new WebSocket(uri)
      wsRef.current = ws

      ws.addEventListener('open', () => {
        if (!preserveReconnectBackoff) attempt = 0
        preserveReconnectBackoff = false
        clearTimers()
        void sendConnectAuth(ws)
        pingTimer = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send('{"type":"ping"}')
          // Auto-pong does not wake DO JS. After a gap, replay wb:follow even
          // if the tab never disconnected.
          if (Date.now() - lastSocketJsAt >= FOLLOW_SOCKET_GAP_MS) {
            resubscribeFollowRef.current()
          }
        }, CLIENT_PING_MS)
        resyncTimer = window.setInterval(() => {
          const api = apiRef.current
          if (!api || ws.readyState !== WebSocket.OPEN) return
          sendSceneUpdate(
            api.getSceneElementsIncludingDeleted(),
            api.getAppState(),
            true,
          )
        }, 30_000)
        // The full scene arrives unprompted on every connect. Pending strokes
        // flush only after wb:hello confirms the server accepted authentication.
      })

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          return
        }
        if (!parsed || typeof parsed !== 'object') return
        const data = parsed as Record<string, unknown>

        if (data.type === 'pong') {
          // Socket stayed OPEN across a hibernation gap; resubscribe wb:follow.
          if (Date.now() - lastSocketJsAt >= FOLLOW_SOCKET_GAP_MS) {
            resubscribeFollowRef.current()
          }
          return
        }
        lastSocketJsAt = Date.now()

        if (data.type === 'wb:hello') {
          helloOnSocketRef.current = true
          authSentRef.current = true
          clearAuthRetry()
          // Push anything drawn while the socket was down or auth was pending.
          queueMicrotask(() => flushNowRef.current(true))
        }

        if (
          data.type === 'scene:ack' &&
          isMutationId(data.mutationId) &&
          (data.status === 'applied' ||
            data.status === 'duplicate' ||
            data.status === 'noop')
        ) {
          if (
            typeof data.revision === 'number' &&
            Number.isSafeInteger(data.revision) &&
            data.revision >= sceneRevisionRef.current
          ) {
            sceneRevisionRef.current = data.revision
          }
          const inFlight = outboxRef.current.inFlight
          if (inFlight?.mutationId === data.mutationId) {
            outboxRef.current = sceneOutboxAcknowledge(
              outboxRef.current,
              (flight) => flight.mutationId === data.mutationId,
            )
            mutationSocketRef.current = null
            rememberElementVersions(
              inFlight.elements,
              ackedElementVersionsRef.current,
            )
            queueMicrotask(() => flushNowRef.current(false))
          }
          return
        }

        if (data.type === 'wb:error') {
          const message =
            typeof data.message === 'string' && data.message.trim()
              ? data.message
              : 'This board is too large to save. The last change was not stored.'
          const now = Date.now()
          if (now - persistErrorToastAtRef.current >= 5000) {
            persistErrorToastAtRef.current = now
            apiRef.current?.setToast?.({
              message,
              duration: 8000,
              closable: true,
            })
          }
          const errorMutationId = isMutationId(data.mutationId)
            ? data.mutationId
            : null
          const inFlight = outboxRef.current.inFlight
          if (inFlight && inFlight.mutationId === errorMutationId) {
            const terminal =
              data.terminal === true ||
              data.code === SCENE_EDIT_NOT_ALLOWED_CODE ||
              data.code === SCENE_TOO_LARGE_CODE ||
              data.code === SCENE_MALFORMED_CODE
            if (terminal) {
              // Permanent failures are visible but must not retry forever.
              // Re-send a complete snapshot on the next higher-version edit;
              // the rejected payload may have contained elements unknown to
              // the server (for example, an over-4000 scene).
              forceFullNextRef.current = true
              outboxRef.current = sceneOutboxTerminalFailure(
                outboxRef.current,
                (flight) => flight.mutationId === errorMutationId,
              )
              mutationSocketRef.current = null
              if (data.code === SCENE_EDIT_NOT_ALLOWED_CODE) {
                // A coalesced snapshot was made under the same permission that
                // rejected the flight. Report it as unsaved and rehydrate from
                // the server before any later edit can leave this tab.
                outboxRef.current = sceneOutboxClearPending(outboxRef.current)
                if (flushTimerRef.current != null) {
                  window.clearTimeout(flushTimerRef.current)
                  flushTimerRef.current = null
                }
                sceneHydratedRef.current = false
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'scene:request' }))
                }
              } else {
                queueMicrotask(() => flushNowRef.current(false))
              }
            } else if (data.code === SCENE_PERSIST_FAILED_CODE) {
              // Keep the immutable mutation. A reconnect (with the normal
              // bounded backoff) is the only retry trigger.
              preserveReconnectBackoff = true
              outboxRef.current = sceneOutboxRetry(outboxRef.current)
              try {
                ws.close(1011, 'retry scene persistence')
              } catch {
                // ignore a socket already closing
              }
            }
          }
          return
        }

        // PHASE 3.3
        if (handleRoleMessageRef.current(data)) return

        if (data.type === 'scene:sync' || data.type === 'scene:update') {
          const elements = Array.isArray(data.elements)
            ? (data.elements as SceneElement[])
            : []
          const appState =
            data.appState && typeof data.appState === 'object'
              ? (data.appState as SceneAppState)
              : null
          const revision =
            typeof data.revision === 'number' &&
            Number.isSafeInteger(data.revision) &&
            data.revision >= 0
              ? data.revision
              : undefined
          applyRemoteElements(elements, appState, revision)
          // The 101 and hello may now arrive before a cold scene read finishes.
          // Once the scene is hydrated, flush any edits retained across reconnect.
          flushNowRef.current(true)
          return
        }
      })

      ws.addEventListener('close', () => {
        clearTimers()
        clearAuthRetry()
        if (wsRef.current === ws) {
          if (mutationSocketRef.current === ws) mutationSocketRef.current = null
          const api = apiRef.current
          if (
            api &&
            canEditRef.current &&
            !outboxRef.current.pending &&
            !applyingRemoteRef.current
          ) {
            const elements = api.getSceneElementsIncludingDeleted()
            if (getSceneVersion(elements) !== lastSceneVersionRef.current) {
              outboxRef.current = sceneOutboxQueue(outboxRef.current, {
                elements: immutableSceneElements(
                  elements as unknown as SceneElement[],
                ) as unknown as readonly OrderedExcalidrawElement[],
                appState: { ...api.getAppState() },
                baseRevision: sceneRevisionRef.current,
              })
            }
          }
          wsRef.current = null
        }
        if (cancelled) return
        const delay = reconnectDelayMs(attempt)
        attempt += 1
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, delay)
      })
    }

    const onVisibleAfterGap = () => {
      if (document.visibilityState !== 'visible') return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastSocketJsAt < FOLLOW_SOCKET_GAP_MS) return
      // Tab stayed connected; still resubscribe wb:follow after a gap.
      resubscribeFollowRef.current()
    }
    document.addEventListener('visibilitychange', onVisibleAfterGap)

    const stopAuthChange = onAuthChange((identity) => {
      const previous = observedIdentity
      observedIdentity = identity
      if (
        !previous ||
        !identity ||
        previous.clerkUserId !== identity.clerkUserId ||
        previous.displayName === identity.displayName
      ) {
        return
      }
      refreshProfileOnNextAuth = true
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const cached = peekSessionToken()?.trim() ?? ''
      if (cached) {
        sendAuthFrame(ws, cached)
        return
      }
      void getSessionTokenSettled().then((value) => {
        const token = value?.trim() ?? ''
        if (!token || cancelled || wsRef.current !== ws) return
        sendAuthFrame(ws, token)
      })
    })

    void connect()

    return () => {
      cancelled = true
      stopAuthChange()
      document.removeEventListener('visibilitychange', onVisibleAfterGap)
      clearTimers()
      clearAuthRetry()
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      flushNowRef.current(true)
      previewCoordinatorRef.current?.persist()
      previewCoordinatorRef.current?.dispose()
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }
  }, [
    applyRemoteElements,
    boardId,
    sendSceneUpdate,
  ])

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      // Excalidraw is remounted when its edit/view mode changes. Any export
      // started by the prior API must not publish that old scene afterward.
      previewCoordinatorRef.current?.invalidate()
      apiRef.current = api
      // New (or remounted, via key={canEdit}) instance starts empty; block
      // outgoing scene pushes until a server scene has been applied, and drop
      // anything the previous instance had queued so the empty starting scene
      // can never be flushed over the stored board.
      sceneHydratedRef.current = false
      const discardedPendingEdit =
        !canEditRef.current && outboxRef.current.pending !== null
      outboxRef.current = sceneOutboxClearPending(outboxRef.current)
      if (discardedPendingEdit) {
        showClientSceneError(SCENE_EDIT_NOT_ALLOWED_CODE)
      }
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      // Version bookkeeping belongs to the old instance. Left in place, the new
      // empty instance's first onChange looks like a real edit and queues an
      // empty snapshot that a later forceFull flush would push as the scene.
      lastSceneVersionRef.current = 0
      observedElementVersionsRef.current.clear()
      unsubUserFollowRef.current?.()
      unsubUserFollowRef.current = api.onUserFollow((payload) => {
        onUserFollowRef.current(payload)
      })
      api.updateScene({
        appState: { viewModeEnabled: !canEditRef.current },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      requestAnimationFrame(() => {
        reassertFollowRef.current()
      })
      const pending = pendingRemoteRef.current
      if (pending) {
        pendingRemoteRef.current = null
        applyRemoteElements(
          pending.elements,
          pending.appState,
          pending.revision,
        )
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'scene:request' }))
      }
    },
    [applyRemoteElements, showClientSceneError],
  )

  if (!boardId) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          color: 'var(--text-muted, #666)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Invalid board link
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'absolute',
        inset: 0,
        touchAction: roles.forceFollowLocked ? 'none' : undefined,
      }}
    >
      {/* Mounted before `wb:hello` so the board paints as soon as the scene
          arrives. Starts view-only; the `key` remount flips Excalidraw out of
          view mode once a can-edit role lands (0.18.1 can otherwise stick). */}
      <Excalidraw
        key={roles.canEdit ? 'edit' : 'view'}
        excalidrawAPI={handleApi}
        theme={theme}
        onChange={handleChange}
        // R2 media writes are intentionally paused while the board runtime is
        // restored. Existing scene images remain renderable/hydratable; the
        // built-in image tool must not create new, unpersistable references.
        UIOptions={{ tools: { image: false } }}
        validateEmbeddable={media.validateEmbeddable}
        renderEmbeddable={media.renderEmbeddable}
        onPaste={media.onPaste}
        isCollaborating
        name={roles.displayName}
        viewModeEnabled={roles.viewModeEnabled}
        onScrollChange={roles.onScrollChange}
      />
      {roles.forceFollowLocked ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            background: 'transparent',
            touchAction: 'none',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {!roles.helloReceived ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 7,
            padding: '4px 10px',
            borderRadius: 2,
            background: 'var(--primary-color)',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          Connecting…
        </div>
      ) : roles.viewModeEnabled ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 7,
            padding: '4px 10px',
            borderRadius: 2,
            background: 'var(--primary-color)',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          View only
        </div>
      ) : null}
    </div>
  )
}
