import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  getSceneVersion,
  newElementWith,
  reconcileElements,
  restoreElements,
  sceneCoordsToViewportCoords,
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
  getSessionToken,
  isSignedIn,
  waitForSessionToken,
  whenAuthReady,
} from '../lib/whiteboard-identity'
import {
  buildWhiteboardConnectUrl,
  CLIENT_PING_MS,
  elementsWithIncreasedVersion,
  elementWins,
  getOrCreateSessionId,
  mergeSceneElements,
  rememberElementVersions,
  SCENE_FLUSH_MS,
  type SceneAppState,
  type SceneElement,
} from '../lib/whiteboard-sync'
import {
  cloneSceneElementsForFlush,
  collectAcknowledgedImageFileIds,
  filterFlushableSceneElements,
} from '../lib/whiteboard-scene-publication'
import { shouldRestoreRecoveredImage } from '../lib/whiteboard-file-sync-plan'
import type {
  WhiteboardUploadElementSnapshot,
  WhiteboardUploadJob,
} from '../lib/whiteboard-upload-outbox'
import {
  getHostSecret,
  touchBoardActive,
} from '../scripts/whiteboard-library'
// PHASE 3.2
import { useWhiteboardExcalidrawFiles } from '../lib/whiteboard-excalidraw-files'
// PHASE 3.3
import {
  FOLLOW_SOCKET_GAP_MS,
  getBoardConnectIdentity,
  useWhiteboardExcalidrawRoles,
} from '../lib/whiteboard-excalidraw-roles'
import {
  exportBoardPreview,
  PREVIEW_IDLE_MS,
  PREVIEW_KEEPALIVE_MAX_BYTES,
  previewExportBlockReason,
  uploadBoardPreview,
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
const UPLOAD_SUCCESS_FADE_MS = 150

type InFlightSceneMutation = {
  elements: SceneElement[]
  sceneVersion: number
  fileIds: string[]
  deletedFileIds: string[]
}

type UploadOverlayItem = {
  element: OrderedExcalidrawElement
  job: WhiteboardUploadJob
  left: number
  top: number
  width: number
  height: number
  angle: number
  largeEnough: boolean
  success: boolean
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Failed to read recovered upload'))
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read recovered upload'))
    reader.readAsDataURL(blob)
  })
}

function isUploadFailed(job: WhiteboardUploadJob): boolean {
  return (
    job.state === 'failed' ||
    job.state === 'auth-blocked' ||
    job.state === 'permanent-failure'
  )
}

function isSceneElementSnapshot(
  value: unknown,
): value is OrderedExcalidrawElement {
  if (!value || typeof value !== 'object') return false
  const element = value as Partial<OrderedExcalidrawElement>
  return (
    typeof element.id === 'string' &&
    typeof element.version === 'number' &&
    typeof element.versionNonce === 'number' &&
    typeof element.type === 'string'
  )
}

function sceneImageFileIds(
  elements: readonly { type?: string; fileId?: unknown }[],
): string[] {
  return [
    ...new Set(
      elements.flatMap((element) =>
        element.type === 'image' &&
        typeof element.fileId === 'string' &&
        element.fileId
          ? [element.fileId]
          : [],
      ),
    ),
  ]
}

function sceneImageTombstoneFileIds(
  elements: readonly {
    type?: string
    isDeleted?: boolean
    fileId?: unknown
  }[],
): string[] {
  return [
    ...new Set(
      elements.flatMap((element) =>
        element.isDeleted &&
        element.type === 'image' &&
        typeof element.fileId === 'string' &&
        element.fileId
          ? [element.fileId]
          : [],
      ),
    ),
  ]
}

function uploadSceneState(appState: AppState): SceneAppState {
  return {
    ...(typeof appState.viewBackgroundColor === 'string'
      ? { viewBackgroundColor: appState.viewBackgroundColor }
      : {}),
  }
}

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

ensureExcalidrawAssetPath()

type WhiteboardCanvasProps = {
  boardId?: string
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
  /** Versions the server has confirmed, never merely versions sent locally. */
  const acknowledgedSceneVersionRef = useRef(0)
  const acknowledgedElementVersionsRef = useRef(new Map<string, number>())
  /** Each mutation remains here until its matching scene:ack arrives. */
  const inFlightMutationsRef = useRef(
    new Map<string, InFlightSceneMutation>(),
  )
  const socketSceneHydratedRef = useRef(false)
  const flushTimerRef = useRef<number | null>(null)
  const pendingFlushRef = useRef<{
    elements: readonly OrderedExcalidrawElement[]
    appState: AppState
  } | null>(null)
  const fullSyncCounterRef = useRef(0)
  const pendingRemoteRef = useRef<{
    elements: SceneElement[]
    appState: SceneAppState | null
    isServerScene: boolean
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
  const previewTimerRef = useRef<number | null>(null)
  const lastPreviewBlobRef = useRef<Blob | null>(null)
  const lastPreviewVersionRef = useRef(0)
  const lastUploadedPreviewVersionRef = useRef(0)
  const previewSkipOwnerRef = useRef(false)
  const previewUploadingRef = useRef(false)
  // PHASE 3.2
  const media = useWhiteboardExcalidrawFiles(boardId, apiRef)
  const uploadSnapshotRef = useRef(media.uploadOutbox)
  uploadSnapshotRef.current = media.uploadOutbox
  const markServerSceneHydratedRef = useRef(media.markServerSceneHydrated)
  markServerSceneHydratedRef.current = media.markServerSceneHydrated
  const resetServerSceneHydrationRef = useRef(media.resetServerSceneHydration)
  resetServerSceneHydrationRef.current = media.resetServerSceneHydration
  const getRecoveryDataRef = useRef(media.getRecoveryData)
  getRecoveryDataRef.current = media.getRecoveryData
  const updatePendingSnapshotsRef = useRef(
    media.updatePendingElementSnapshots,
  )
  updatePendingSnapshotsRef.current = media.updatePendingElementSnapshots
  const markSceneAcknowledgedRef = useRef(media.markSceneAcknowledged)
  markSceneAcknowledgedRef.current = media.markSceneAcknowledged
  const retryUploadRef = useRef(media.retryUpload)
  retryUploadRef.current = media.retryUpload
  const retryAllUploadsRef = useRef(media.retryAllUploads)
  retryAllUploadsRef.current = media.retryAllUploads
  const [uploadOverlayRevision, setUploadOverlayRevision] = useState(0)
  const [socketConnected, setSocketConnected] = useState(false)
  const [socketSceneReady, setSocketSceneReady] = useState(false)
  const [uploadSavedUntil, setUploadSavedUntil] = useState(0)
  const uploadReadyAtRef = useRef(new Map<string, number>())
  const uploadFadeTimerRef = useRef<number | null>(null)
  const uploadSavedTimerRef = useRef<number | null>(null)
  const recoveredFileIdsRef = useRef(new Set<string>())
  const recoveryInFlightRef = useRef(false)
  const acknowledgedImageFileIdsRef = useRef(new Set<string>())
  const acknowledgedBoardIdRef = useRef(boardId)

  useEffect(() => {
    if (acknowledgedBoardIdRef.current === boardId) return
    acknowledgedBoardIdRef.current = boardId
    acknowledgedImageFileIdsRef.current.clear()
  }, [boardId])

  // PHASE 3.3
  const roles = useWhiteboardExcalidrawRoles({ boardId, apiRef, wsRef })
  const handleRoleMessageRef = useRef(roles.handleSocketMessage)
  handleRoleMessageRef.current = roles.handleSocketMessage
  const onUserFollowRef = useRef(roles.onUserFollow)
  onUserFollowRef.current = roles.onUserFollow
  const reassertFollowRef = useRef(roles.reassertFollow)
  reassertFollowRef.current = () => {
    roles.reassertFollow()
    setUploadOverlayRevision((revision) => revision + 1)
  }
  const resubscribeFollowRef = useRef(roles.resubscribeFollow)
  resubscribeFollowRef.current = roles.resubscribeFollow
  const unsubUserFollowRef = useRef<(() => void) | null>(null)
  const unsubScrollChangeRef = useRef<(() => void) | null>(null)
  const canEditRef = useRef(roles.canEdit)
  canEditRef.current = roles.canEdit
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || !roles.forceFollowLocked) return
    const stop = (event: Event) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.wb-upload-control')
      ) {
        return
      }
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
      unsubScrollChangeRef.current?.()
      unsubScrollChangeRef.current = null
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

  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    void whenAuthReady()
      .then(() => {
        if (cancelled) return
        return touchBoardActive(boardId)
      })
      .catch(() => {
        // Cloud upsert can fail offline; local create path still works when signed out
      })
    return () => {
      cancelled = true
    }
  }, [boardId])

  const applyRemoteElements = useCallback(
    (
      remoteElements: SceneElement[],
      remoteAppState: SceneAppState | null,
      isServerScene = false,
    ) => {
      const api = apiRef.current
      if (!api) {
        const pending = pendingRemoteRef.current
        if (!pending) {
          pendingRemoteRef.current = {
            elements: remoteElements,
            appState: remoteAppState,
            isServerScene,
          }
        } else {
          pendingRemoteRef.current = {
            elements: mergeSceneElements(pending.elements, remoteElements).next,
            appState: remoteAppState ?? pending.appState,
            isServerScene: pending.isServerScene || isServerScene,
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
        const inFlightRemoteVersions = new Map<string, number>()
        for (const mutation of inFlightMutationsRef.current.values()) {
          for (const element of mutation.elements) {
            const previous = inFlightRemoteVersions.get(element.id) ?? 0
            if (element.version > previous) {
              inFlightRemoteVersions.set(element.id, element.version)
            }
          }
        }
        const acknowledgedRemoteElements = remoteElements.filter(
          (element) =>
            element.version >
            (inFlightRemoteVersions.get(element.id) ?? -1),
        )
        rememberElementVersions(
          acknowledgedRemoteElements,
          acknowledgedElementVersionsRef.current,
        )
        acknowledgedSceneVersionRef.current = Math.max(
          acknowledgedSceneVersionRef.current,
          getSceneVersion(
            acknowledgedRemoteElements as unknown as OrderedExcalidrawElement[],
          ),
        )
        if (isServerScene || sceneHydratedRef.current) {
          sceneHydratedRef.current = true
        }
        if (isServerScene) {
          const fromServer = collectAcknowledgedImageFileIds(remoteElements)
          const fromLive = collectAcknowledgedImageFileIds(
            api.getSceneElementsIncludingDeleted() as unknown as SceneElement[],
          )
          for (const fileId of fromServer) {
            acknowledgedImageFileIdsRef.current.add(fileId)
          }
          // Intersect live canvas fileIds with the server scene so a remount
          // re-hydrates persisted images without acknowledging unpublished
          // local drops.
          for (const fileId of fromLive) {
            if (fromServer.has(fileId)) {
              acknowledgedImageFileIdsRef.current.add(fileId)
            }
          }
        }
        setUploadOverlayRevision((revision) => revision + 1)
      } finally {
        queueMicrotask(() => {
          applyingRemoteRef.current = false
        })
      }
    },
    [],
  )

  const recoverPendingUploads = useCallback(async () => {
    const api = apiRef.current
    if (!api || !sceneHydratedRef.current || recoveryInFlightRef.current) {
      return
    }
    const recovery = getRecoveryDataRef.current()
    if (recovery.length === 0) return

    recoveryInFlightRef.current = true
    try {
      const current = api.getSceneElementsIncludingDeleted()
      const byId = new Map(current.map((element) => [element.id, element]))
      const liveRecovery = new Map<string, OrderedExcalidrawElement>()
      const recoveryFileIds = new Set<string>()

      for (const item of recovery) {
        for (const snapshot of item.latestElementSnapshots) {
          if (!isSceneElementSnapshot(snapshot.element)) continue
          const element = snapshot.element
          if (
            element.isDeleted ||
            element.type !== 'image' ||
            element.fileId !== item.fileId
          ) {
            continue
          }
          const existing = byId.get(element.id)
          // A local/server deletion is authoritative for this recovery pass;
          // an old outbox snapshot must never resurrect it.
          if (existing?.isDeleted) continue
          const previous = liveRecovery.get(element.id) ?? existing
          if (
            !previous ||
            elementWins(
              element as unknown as SceneElement,
              previous as unknown as SceneElement,
            )
          ) {
            liveRecovery.set(element.id, element)
          }
          recoveryFileIds.add(item.fileId)
        }
      }

      const filesToAdd = []
      const existingFiles = api.getFiles()
      for (const job of uploadSnapshotRef.current.jobs) {
        if (!recoveryFileIds.has(job.fileId)) continue
        if (recoveredFileIdsRef.current.has(job.fileId)) continue
        if (existingFiles[job.fileId]?.dataURL) {
          recoveredFileIdsRef.current.add(job.fileId)
          continue
        }
        if (!job.blob) continue
        try {
          filesToAdd.push({
            id: job.fileId as Parameters<typeof api.addFiles>[0][number]['id'],
            mimeType: job.mimeType as Parameters<typeof api.addFiles>[0][number]['mimeType'],
            dataURL: (await blobToDataURL(job.blob)) as Parameters<typeof api.addFiles>[0][number]['dataURL'],
            created: job.createdAt,
          })
        } catch {
          // Keep the durable Blob for a later recovery attempt. Do not toast.
        }
      }
      if (filesToAdd.length > 0) api.addFiles(filesToAdd)

      const filesNow = api.getFiles()
      for (const added of filesToAdd) {
        if (filesNow[added.id]?.dataURL) {
          recoveredFileIdsRef.current.add(added.id)
        }
      }
      const restored = new Map<string, OrderedExcalidrawElement>()
      for (const [elementId, element] of liveRecovery) {
        if (element.type !== 'image') continue
        const fileId =
          typeof element.fileId === 'string' ? element.fileId : ''
        if (!fileId) continue
        const job = uploadSnapshotRef.current.jobs.find(
          (candidate) => candidate.fileId === fileId,
        )
        const file = filesNow[fileId]
        if (
          !shouldRestoreRecoveredImage({
            hasLocalDataURL: Boolean(file?.dataURL),
            hasBlob: Boolean(job?.blob),
            conversionOk: Boolean(file?.dataURL),
          })
        ) {
          continue
        }
        restored.set(elementId, element)
      }
      if (restored.size > 0) {
        for (const [elementId, element] of restored) {
          byId.set(elementId, element)
        }
        api.updateScene({
          elements: [...byId.values()],
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      }
      setUploadOverlayRevision((revision) => revision + 1)
    } finally {
      recoveryInFlightRef.current = false
    }
  }, [])

  const updatePendingSnapshotsForScene = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
    ) => {
      const sceneVersion = getSceneVersion(elements)
      for (const job of uploadSnapshotRef.current.jobs) {
        const latestElementSnapshots: WhiteboardUploadElementSnapshot[] =
          elements
            .filter(
              (element) =>
                !element.isDeleted &&
                element.type === 'image' &&
                element.fileId === job.fileId,
            )
            .map((element) => ({
              elementId: element.id,
              element,
              elementVersion: element.version,
            }))
        const snapshotsChanged =
          latestElementSnapshots.length !== job.latestElementSnapshots.length ||
          latestElementSnapshots.some(
            (snapshot, index) =>
              snapshot.elementId !==
                job.latestElementSnapshots[index]?.elementId ||
              snapshot.elementVersion !==
                job.latestElementSnapshots[index]?.elementVersion,
          )
        if (!snapshotsChanged) continue
        void updatePendingSnapshotsRef.current(job.fileId, {
          latestElementSnapshots,
          latestElementState: uploadSceneState(appState),
          sceneVersion,
        })
      }
    },
    [],
  )

  const sendSceneUpdate = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      forceFull: boolean,
      requiredElementIds?: ReadonlySet<string>,
    ): boolean => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      if (!authSentRef.current) return false
      if (applyingRemoteRef.current) return false
      if (!canEditRef.current) return false
      if (!sceneHydratedRef.current) return false
      if (!socketSceneHydratedRef.current) return false

      // Default-deny: clone, then keep images only if uploaded or already
      // acknowledged on the server. Unknown fileIds never ride a full resync.
      const uploadSnapshot = uploadSnapshotRef.current
      if (!uploadSnapshot.ready) return false
      if (uploadSnapshot.storageError) return false
      const uploadedFileIds = new Set(
        uploadSnapshot.jobs
          .filter((job) => job.state === 'uploaded')
          .map((job) => job.fileId),
      )
      const publicationElements = filterFlushableSceneElements(
        cloneSceneElementsForFlush(elements as unknown as SceneElement[]),
        {
          uploadedFileIds,
          acknowledgedImageFileIds: acknowledgedImageFileIdsRef.current,
        },
      )
      const version = getSceneVersion(elements)
      const asScene = publicationElements
      const dirty = elementsWithIncreasedVersion(
        asScene,
        acknowledgedElementVersionsRef.current,
      )

      const inFlightVersions = new Map<string, number>()
      for (const mutation of inFlightMutationsRef.current.values()) {
        for (const element of mutation.elements) {
          const previous = inFlightVersions.get(element.id) ?? 0
          if (element.version > previous) {
            inFlightVersions.set(element.id, element.version)
          }
        }
      }
      const required = requiredElementIds
        ? asScene.filter(
            (element) =>
              requiredElementIds.has(element.id) &&
              element.version > (inFlightVersions.get(element.id) ?? 0),
          )
        : []
      const notAlreadyInFlight = dirty.filter(
        (element) =>
          element.version > (inFlightVersions.get(element.id) ?? 0),
      )
      const pendingElements = [
        ...notAlreadyInFlight,
        ...required.filter(
          (element) =>
            !notAlreadyInFlight.some((candidate) => candidate.id === element.id),
        ),
      ]
      if (!forceFull && pendingElements.length === 0) return false

      fullSyncCounterRef.current += 1
      const full = forceFull || fullSyncCounterRef.current % 15 === 0
      const payload = full ? asScene : pendingElements

      let databaseJson: string | undefined
      try {
        databaseJson = serializeAsJSON(
          publicationElements as unknown as OrderedExcalidrawElement[],
          { ...appState, viewModeEnabled: false },
          {},
          'database',
        )
      } catch {
        databaseJson = undefined
      }

      try {
        const mutationId = crypto.randomUUID()
        ws.send(
          JSON.stringify({
            type: 'scene:update',
            elements: payload,
            full,
            databaseJson,
            mutationId,
          }),
        )
        inFlightMutationsRef.current.set(mutationId, {
          elements: payload.map((element) => ({ ...element })),
          sceneVersion: version,
          fileIds: sceneImageFileIds(
            payload as unknown as OrderedExcalidrawElement[],
          ),
          deletedFileIds: sceneImageTombstoneFileIds(
            payload as unknown as OrderedExcalidrawElement[],
          ),
        })
      } catch {
        return false
      }

      return true
    },
    [],
  )

  const flushPending = useCallback(
    (forceFull = false) => {
      const pending = pendingFlushRef.current
      if (!pending) return
      const sent = sendSceneUpdate(
        pending.elements,
        pending.appState,
        forceFull,
      )
      if (sent) pendingFlushRef.current = null
    },
    [sendSceneUpdate],
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

  const forceSendReadyUploads = useCallback(() => {
    const api = apiRef.current
    if (!api) return false
    const readyFileIds = new Set(
      uploadSnapshotRef.current.jobs
        .filter((job) => job.state === 'uploaded')
        .map((job) => job.fileId),
    )
    if (readyFileIds.size === 0) return false
    const elementIds = new Set<string>()
    for (const element of api.getSceneElementsIncludingDeleted()) {
      if (
        !element.isDeleted &&
        element.type === 'image' &&
        typeof element.fileId === 'string' &&
        readyFileIds.has(element.fileId)
      ) {
        elementIds.add(element.id)
      }
    }
    if (elementIds.size === 0) return false
    const sent = sendSceneUpdate(
      api.getSceneElementsIncludingDeleted(),
      api.getAppState(),
      false,
      elementIds,
    )
    if (sent) pendingFlushRef.current = null
    return sent
  }, [apiRef, sendSceneUpdate])

  const handleScenePersistError = useCallback(
    (mutationId: string, code?: string) => {
      const mutation = inFlightMutationsRef.current.get(mutationId)
      if (!mutation) return
      inFlightMutationsRef.current.delete(mutationId)

      const api = apiRef.current
      if (!api || !canEditRef.current || !sceneHydratedRef.current) return
      // Requeue the current scene. Asset-not-ready errors remain blocked by
      // default-deny until the durable upload reaches R2, then the upload-state
      // effect calls forceSendReadyUploads(). Other persistence failures get
      // one normal retry without waiting for a reconnect.
      pendingFlushRef.current = {
        elements: api.getSceneElementsIncludingDeleted(),
        appState: api.getAppState(),
      }
      if (code === 'asset_not_ready') {
        forceSendReadyUploads()
        return
      }
      if (flushTimerRef.current != null) return
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        flushNowRef.current()
      }, SCENE_FLUSH_MS)
    },
    [forceSendReadyUploads],
  )

  const handleSceneAcknowledgement = useCallback((mutationId: string) => {
    const mutation = inFlightMutationsRef.current.get(mutationId)
    if (!mutation) return
    inFlightMutationsRef.current.delete(mutationId)
    rememberElementVersions(
      mutation.elements,
      acknowledgedElementVersionsRef.current,
    )
    acknowledgedSceneVersionRef.current = Math.max(
      acknowledgedSceneVersionRef.current,
      mutation.sceneVersion,
    )
    const sentImageVersions = new Map<string, Map<string, number>>()
    for (const element of mutation.elements) {
      if (
        element.type !== 'image' ||
        typeof element.fileId !== 'string'
      ) {
        continue
      }
      const versions = sentImageVersions.get(element.fileId) ?? new Map()
      versions.set(
        element.id,
        Math.max(versions.get(element.id) ?? 0, element.version),
      )
      sentImageVersions.set(element.fileId, versions)
    }
    const currentElements =
      apiRef.current?.getSceneElementsIncludingDeleted() ?? []
    const trackedFileIds = [
      ...new Set([...mutation.fileIds, ...mutation.deletedFileIds]),
    ]
    const acknowledgedFileIds = trackedFileIds.filter((fileId) => {
      const sentVersions = sentImageVersions.get(fileId)
      if (!sentVersions) return false
      const currentReferences = currentElements.filter(
        (element) =>
          !element.isDeleted &&
          element.type === 'image' &&
          element.fileId === fileId,
      )
      if (currentReferences.length === 0) {
        return mutation.deletedFileIds.includes(fileId)
      }
      return currentReferences.every(
        (element) => (sentVersions.get(element.id) ?? -1) >= element.version,
      )
    })
    const acknowledgedUploadIds = acknowledgedFileIds.filter((fileId) =>
      uploadSnapshotRef.current.jobs.some((job) => job.fileId === fileId),
    )
    for (const fileId of mutation.fileIds) {
      if (fileId) acknowledgedImageFileIdsRef.current.add(fileId)
    }
    for (const fileId of mutation.deletedFileIds) {
      if (fileId) acknowledgedImageFileIdsRef.current.add(fileId)
    }
    if (acknowledgedUploadIds.length > 0) {
      const savedUntil = Date.now() + 1500
      setUploadSavedUntil(savedUntil)
      if (uploadSavedTimerRef.current != null) {
        window.clearTimeout(uploadSavedTimerRef.current)
      }
      uploadSavedTimerRef.current = window.setTimeout(() => {
        uploadSavedTimerRef.current = null
        setUploadSavedUntil(0)
      }, 1500)
    }
    void markSceneAcknowledgedRef.current({
      boardId,
      sceneVersion: mutation.sceneVersion,
      fileIds: acknowledgedFileIds,
      deletedFileIds: mutation.deletedFileIds.filter((fileId) =>
        acknowledgedFileIds.includes(fileId),
      ),
    })
  }, [boardId])

  const markServerSceneApplied = useCallback(() => {
    if (!apiRef.current || !sceneHydratedRef.current) return
    socketSceneHydratedRef.current = true
    setSocketSceneReady(true)
    const serverElements = apiRef.current.getSceneElementsIncludingDeleted()
    const hydration = markServerSceneHydratedRef.current({
      sceneVersion: getSceneVersion(serverElements),
      deletedFileIds: sceneImageTombstoneFileIds(serverElements),
    })
    void hydration
      .then(() => recoverPendingUploads())
      .finally(() => {
        flushNowRef.current(true)
        forceSendReadyUploads()
      })
  }, [forceSendReadyUploads, recoverPendingUploads])

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current == null) return
    window.clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
  }, [])

  const uploadCachedPreview = useCallback(
    (keepalive: boolean) => {
      if (!boardId || previewSkipOwnerRef.current) return
      const blob = lastPreviewBlobRef.current
      const version = lastPreviewVersionRef.current
      if (!blob || version === 0) return
      if (version === lastUploadedPreviewVersionRef.current) return
      if (keepalive && blob.size > PREVIEW_KEEPALIVE_MAX_BYTES) return
      previewUploadingRef.current = true
      void uploadBoardPreview({ boardId, blob, keepalive })
        .then((status) => {
          if (status === 'skipped-not-owner') {
            previewSkipOwnerRef.current = true
            return
          }
          if (status === 'uploaded') {
            lastUploadedPreviewVersionRef.current = version
          }
        })
        .catch(() => {
          // Keep the blob; a later idle or hide can retry.
        })
        .finally(() => {
          previewUploadingRef.current = false
        })
    },
    [boardId],
  )
  const uploadCachedPreviewRef = useRef(uploadCachedPreview)
  uploadCachedPreviewRef.current = uploadCachedPreview

  const captureBoardPreviewRef = useRef<() => void>(() => {})
  const captureBoardPreview = useCallback(() => {
    const api = apiRef.current
    if (!api || !canEditRef.current || !sceneHydratedRef.current) return
    if (previewSkipOwnerRef.current) return
    const blocked = previewExportBlockReason(api)
    if (blocked === 'empty') return
    if (blocked === 'files') {
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null
        captureBoardPreviewRef.current()
      }, PREVIEW_IDLE_MS)
      return
    }
    const version = getSceneVersion(api.getSceneElementsIncludingDeleted())
    void exportBoardPreview(api).then((blob) => {
      if (!blob) return
      lastPreviewBlobRef.current = blob
      lastPreviewVersionRef.current = version
      if (document.visibilityState === 'visible') {
        uploadCachedPreviewRef.current(false)
      }
    })
  }, [])
  captureBoardPreviewRef.current = captureBoardPreview

  const schedulePreviewCapture = useCallback(() => {
    if (previewSkipOwnerRef.current) return
    if (!isSignedIn()) return
    clearPreviewTimer()
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null
      captureBoardPreviewRef.current()
    }, PREVIEW_IDLE_MS)
  }, [clearPreviewTimer])

  const handleChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      // PHASE 3.2 — upload/hydrate R2 files; do not gate on remote-apply.
      const sceneVersion = getSceneVersion(elements)
      media.syncFiles(elements, files, {
        sceneVersion,
        sceneState: uploadSceneState(appState),
      })
      // syncFiles stages local bytes independently of this flush. Default-deny
      // publication still omits images until they are uploaded or acknowledged.
      uploadSnapshotRef.current = media.uploadOutbox.outbox.getSnapshot()
      updatePendingSnapshotsForScene(elements, appState)
      setUploadOverlayRevision((revision) => revision + 1)
      if (applyingRemoteRef.current) return
      if (!canEditRef.current) return
      // Nothing this instance holds is trustworthy until a server scene lands.
      if (!sceneHydratedRef.current) return
      pendingFlushRef.current = {
        elements: cloneSceneElementsForFlush(
          elements as unknown as SceneElement[],
        ) as unknown as OrderedExcalidrawElement[],
        appState,
      }
      schedulePreviewCapture()
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
      }
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        flushPending()
      }, SCENE_FLUSH_MS)
    },
    [
      flushPending,
      media.syncFiles,
      media.uploadOutbox.outbox,
      schedulePreviewCapture,
      updatePendingSnapshotsForScene,
    ],
  )

  useEffect(() => {
    const persist = () => {
      // pagehide cannot await conversion or IndexedDB. Default-deny omits
      // images that are not uploaded or already on the server.
      flushNowRef.current(true)
      uploadCachedPreviewRef.current(true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onVisibility)
    }
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
    let attempt = 0
    let lastSocketJsAt = 0

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
      ws.send(
        JSON.stringify({
          type: 'wb:auth',
          ...(token ? { token } : {}),
          ...(hostSecret ? { hostSecret } : {}),
          ...(signedIn ? { signedIn: true } : {}),
        }),
      )
      lastAuthTokenSent = token
      if (token || !signedIn) authSentRef.current = true
      // Resubscribe wb:follow on open/reconnect while the socket is OPEN.
      resubscribeFollowRef.current()
    }

    /**
     * Send `wb:auth` as soon as Clerk has settled, then keep retrying until the
     * server greets this socket. Auth never blocks the socket or the canvas:
     * the server sends the full scene on connect, and a token accepted later
     * upgrades the role in place via `wb:role`. Retries back off and give up
     * rather than polling Clerk once a second forever — a classroom of stuck
     * tabs doing that is how boards started taking a minute to load.
     */
    const scheduleAuthRetry = (ws: WebSocket, delay: number) => {
      authRetryTimer = window.setTimeout(() => {
        authRetryTimer = null
        if (cancelled || wsRef.current !== ws || helloOnSocketRef.current) return
        if (!isSignedIn()) {
          sendAuthFrame(ws, '')
          return
        }
        if (Date.now() - authStartedAt > AUTH_RETRY_GIVE_UP_MS) {
          apiRef.current?.setToast?.({
            message:
              'Sign-in is taking too long. Reload the page to edit this board.',
            duration: 10000,
            closable: true,
          })
          return
        }
        if (authFetchInFlight) {
          scheduleAuthRetry(ws, delay)
          return
        }
        authFetchInFlight = true
        void getSessionToken()
          .then((value) => {
            const token = value?.trim() ?? ''
            if (cancelled || wsRef.current !== ws) return
            if (token && token !== lastAuthTokenSent) sendAuthFrame(ws, token)
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

    const sendConnectAuth = async (ws: WebSocket) => {
      await whenAuthReady()
      if (cancelled || wsRef.current !== ws) return
      const first = isSignedIn()
        ? ((await waitForSessionToken(6, 100))?.trim() ?? '')
        : ''
      if (cancelled || wsRef.current !== ws) return
      authStartedAt = Date.now()
      sendAuthFrame(ws, first)
      if (!isSignedIn()) return
      scheduleAuthRetry(ws, AUTH_RETRY_MS)
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
      socketSceneHydratedRef.current = false
      setSocketSceneReady(false)
      resetServerSceneHydrationRef.current()
      lastAuthTokenSent = ''
      clearAuthRetry()
      const ws = new WebSocket(uri)
      wsRef.current = ws

      ws.addEventListener('open', () => {
        attempt = 0
        setSocketConnected(true)
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
          if (
            !api ||
            ws.readyState !== WebSocket.OPEN ||
            !socketSceneHydratedRef.current
          ) {
            return
          }
          sendSceneUpdate(
            api.getSceneElementsIncludingDeleted(),
            api.getAppState(),
            true,
          )
        }, 30_000)
        // Publication waits for the current socket's scene:sync. The full
        // scene arrives unprompted on every connect, after which recovery and
        // any pending local work are flushed.
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
        }

        if (data.type === 'wb:error') {
          if (typeof data.mutationId === 'string' && data.mutationId) {
            handleScenePersistError(
              data.mutationId,
              typeof data.code === 'string' ? data.code : undefined,
            )
          }
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
          return
        }

        if (data.type === 'scene:ack') {
          if (typeof data.mutationId === 'string' && data.mutationId) {
            handleSceneAcknowledgement(data.mutationId)
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
          const isServerScene = data.type === 'scene:sync'
          const hasCanvas = Boolean(apiRef.current)
          applyRemoteElements(elements, appState, isServerScene)
          if (isServerScene && hasCanvas) markServerSceneApplied()
          return
        }
      })

      ws.addEventListener('close', () => {
        clearTimers()
        clearAuthRetry()
        if (wsRef.current === ws) {
          setSocketConnected(false)
          socketSceneHydratedRef.current = false
          setSocketSceneReady(false)
          resetServerSceneHydrationRef.current()
          inFlightMutationsRef.current.clear()
          const api = apiRef.current
          if (
            api &&
            canEditRef.current &&
            !pendingFlushRef.current &&
            !applyingRemoteRef.current
          ) {
            const elements = api.getSceneElementsIncludingDeleted()
            if (
              getSceneVersion(elements) > acknowledgedSceneVersionRef.current
            ) {
              pendingFlushRef.current = {
                elements: cloneSceneElementsForFlush(
                  elements as unknown as SceneElement[],
                ) as unknown as OrderedExcalidrawElement[],
                appState: api.getAppState(),
              }
            }
          }
          wsRef.current = null
        }
        if (cancelled) return
        const delay = Math.min(10_000, 500 * 2 ** attempt)
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

    void connect()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibleAfterGap)
      clearTimers()
      clearAuthRetry()
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      flushNowRef.current(true)
      uploadCachedPreviewRef.current(true)
      const ws = wsRef.current
      setSocketConnected(false)
      socketSceneHydratedRef.current = false
      setSocketSceneReady(false)
      resetServerSceneHydrationRef.current()
      inFlightMutationsRef.current.clear()
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
    handleSceneAcknowledgement,
    handleScenePersistError,
    markServerSceneApplied,
    sendSceneUpdate,
  ])

  useEffect(() => {
    const api = apiRef.current
    if (api) {
      updatePendingSnapshotsForScene(
        api.getSceneElementsIncludingDeleted(),
        api.getAppState(),
      )
    }
    let changed = false
    const now = Date.now()
    for (const job of media.uploadOutbox.jobs) {
      if (job.state === 'uploaded') {
        if (!uploadReadyAtRef.current.has(job.fileId)) {
          uploadReadyAtRef.current.set(job.fileId, now)
          changed = true
        }
      } else if (uploadReadyAtRef.current.delete(job.fileId)) {
        changed = true
      }
    }
    for (const fileId of uploadReadyAtRef.current.keys()) {
      if (!media.uploadOutbox.jobs.some((job) => job.fileId === fileId)) {
        uploadReadyAtRef.current.delete(fileId)
        changed = true
      }
    }
    if (uploadFadeTimerRef.current != null) {
      window.clearTimeout(uploadFadeTimerRef.current)
      uploadFadeTimerRef.current = null
    }
    const fadeAt = [...uploadReadyAtRef.current.values()]
      .map((readyAt) => readyAt + UPLOAD_SUCCESS_FADE_MS)
      .filter((value) => value > now)
      .sort((a, b) => a - b)[0]
    if (fadeAt !== undefined) {
      uploadFadeTimerRef.current = window.setTimeout(() => {
        uploadFadeTimerRef.current = null
        setUploadOverlayRevision((revision) => revision + 1)
      }, Math.max(0, fadeAt - now))
    }
    if (changed) setUploadOverlayRevision((revision) => revision + 1)

    if (sceneHydratedRef.current && media.uploadOutbox.recoveryReady) {
      void recoverPendingUploads().finally(() => {
        forceSendReadyUploads()
      })
    }
  }, [
    forceSendReadyUploads,
    media.uploadOutbox.jobs,
    media.uploadOutbox.recoveryReady,
    recoverPendingUploads,
    updatePendingSnapshotsForScene,
  ])

  useEffect(() => {
    const refresh = () =>
      setUploadOverlayRevision((revision) => revision + 1)
    window.addEventListener('resize', refresh)
    return () => {
      window.removeEventListener('resize', refresh)
      if (uploadFadeTimerRef.current != null) {
        window.clearTimeout(uploadFadeTimerRef.current)
        uploadFadeTimerRef.current = null
      }
      if (uploadSavedTimerRef.current != null) {
        window.clearTimeout(uploadSavedTimerRef.current)
        uploadSavedTimerRef.current = null
      }
    }
  }, [])

  const handleRetryUpload = useCallback((fileId: string) => {
    void retryUploadRef.current(fileId)
  }, [])

  const handleRemoveUpload = useCallback((job: WhiteboardUploadJob) => {
    const api = apiRef.current
    const elementIds = new Set(
      job.latestElementSnapshots.map((snapshot) => snapshot.elementId),
    )
    if (api && elementIds.size > 0) {
      const elements = api.getSceneElementsIncludingDeleted()
      const next = elements.map((element) =>
        elementIds.has(element.id) &&
        element.type === 'image' &&
        element.fileId === job.fileId &&
        !element.isDeleted
          ? newElementWith(element, { isDeleted: true })
          : element,
      )
      if (next.some((element, index) => element !== elements[index])) {
        api.updateScene({
          elements: next,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        })
      }
    }
  }, [])

  const handleRetryAllUploads = useCallback(() => {
    void retryAllUploadsRef.current()
  }, [])

  const handleScrollChange = useCallback(
    (_scrollX: number, _scrollY: number, _zoom: AppState['zoom']) => {
      roles.onScrollChange()
      setUploadOverlayRevision((revision) => revision + 1)
    },
    [roles.onScrollChange],
  )

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api
      // New (or remounted, via key={canEdit}) instance starts empty; block
      // outgoing scene pushes until a server scene has been applied, and drop
      // anything the previous instance had queued so the empty starting scene
      // can never be flushed over the stored board.
      sceneHydratedRef.current = false
      socketSceneHydratedRef.current = false
      setSocketSceneReady(false)
      resetServerSceneHydrationRef.current()
      pendingFlushRef.current = null
      inFlightMutationsRef.current.clear()
      acknowledgedSceneVersionRef.current = 0
      acknowledgedElementVersionsRef.current.clear()
      // Keep acknowledged image fileIds across canEdit remounts on the same
      // board. Clearing them here would default-deny already-persisted images
      // from the next full scene:update until a later scene:sync rebuilds the
      // set. A boardId change still resets the set.
      recoveredFileIdsRef.current.clear()
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      if (previewTimerRef.current != null) {
        window.clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
      }
      unsubUserFollowRef.current?.()
      unsubUserFollowRef.current = api.onUserFollow((payload) => {
        onUserFollowRef.current(payload)
      })
      unsubScrollChangeRef.current?.()
      unsubScrollChangeRef.current = api.onScrollChange(() => {
        setUploadOverlayRevision((revision) => revision + 1)
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
          pending.isServerScene,
        )
        if (pending.isServerScene) markServerSceneApplied()
        else if (!sceneHydratedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'scene:request' }))
        }
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'scene:request' }))
      }
    },
    [applyRemoteElements, markServerSceneApplied],
  )

  const uploadOverlayItems: UploadOverlayItem[] = []
  const canvasApi = apiRef.current
  if (canvasApi) {
    const appState = canvasApi.getAppState()
    const sceneElements = canvasApi.getSceneElementsIncludingDeleted()
    const elementsById = new Map(
      sceneElements.map((element) => [element.id, element]),
    )
    const now = Date.now()
    const seenElementIds = new Set<string>()
    for (const job of media.uploadOutbox.jobs) {
      const success = job.state === 'uploaded'
      const readyAt = uploadReadyAtRef.current.get(job.fileId)
      if (
        success &&
        readyAt !== undefined &&
        now - readyAt >= UPLOAD_SUCCESS_FADE_MS
      ) {
        continue
      }
      if (!success && !isUploadFailed(job) && job.state !== 'pending' && job.state !== 'uploading') {
        continue
      }
      for (const snapshot of job.latestElementSnapshots) {
        if (seenElementIds.has(snapshot.elementId)) continue
        const element = elementsById.get(snapshot.elementId)
        if (
          !element ||
          element.isDeleted ||
          element.type !== 'image' ||
          element.fileId !== job.fileId
        ) {
          continue
        }
        const zoom = appState.zoom.value
        const position = sceneCoordsToViewportCoords(
          { sceneX: element.x, sceneY: element.y },
          appState,
        )
        const width = Math.max(1, Math.abs(element.width * zoom))
        const height = Math.max(1, Math.abs(element.height * zoom))
        uploadOverlayItems.push({
          element,
          job,
          left: position.x - appState.offsetLeft,
          top: position.y - appState.offsetTop,
          width,
          height,
          angle: element.angle,
          largeEnough: width >= 96 && height >= 48,
          success,
        })
        seenElementIds.add(snapshot.elementId)
      }
    }
  }

  const uploadSnapshot = media.uploadOutbox
  const hasUploadWork =
    uploadSnapshot.pendingCount > 0 || uploadSnapshot.awaitingSceneAckCount > 0
  const uploadStatus = uploadSnapshot.storageError
    ? {
        kind: 'blocking',
        message:
          'Uploads cannot be saved for offline recovery. Do not reload this board.',
      }
    : uploadSnapshot.failedCount > 0
      ? {
          kind: 'failed',
          message: `${uploadSnapshot.failedCount} upload${uploadSnapshot.failedCount === 1 ? '' : 's'} failed`,
        }
      : uploadSavedUntil > Date.now()
        ? { kind: 'saved', message: 'Uploads saved' }
        : (!socketConnected || !socketSceneReady) && hasUploadWork
          ? { kind: 'waiting', message: 'Waiting for connection…' }
          : hasUploadWork
            ? {
                kind: 'saving',
                message: `Saving ${uploadSnapshot.pendingCount + uploadSnapshot.awaitingSceneAckCount} file${uploadSnapshot.pendingCount + uploadSnapshot.awaitingSceneAckCount === 1 ? '' : 's'}…`,
              }
            : null

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
        generateIdForFile={media.generateIdForFile}
        validateEmbeddable={media.validateEmbeddable}
        renderEmbeddable={media.renderEmbeddable}
        onPaste={media.onPaste}
        isCollaborating
        name={roles.displayName}
        viewModeEnabled={roles.viewModeEnabled}
        collaborators={roles.collaborators}
        onScrollChange={handleScrollChange}
      />
      <div
        className="wb-upload-overlay-layer"
        data-revision={uploadOverlayRevision}
        aria-hidden={uploadOverlayItems.length === 0 ? true : undefined}
      >
        {uploadOverlayItems.map((item) => {
          const failed = isUploadFailed(item.job)
          const className = [
            'wb-upload-overlay',
            item.success
              ? 'wb-upload-overlay--success'
              : failed
                ? 'wb-upload-overlay--failed'
                : 'wb-upload-overlay--pending',
          ].join(' ')
          return (
            <div
              key={`${item.job.fileId}:${item.element.id}`}
              className={className}
              style={{
                left: item.left,
                top: item.top,
                width: item.width,
                height: item.height,
                transform: `rotate(${item.angle}rad)`,
              }}
              title={failed ? item.job.error?.message : undefined}
            >
              {item.success ? (
                <span className="wb-upload-success-mark" aria-label="Upload saved">
                  ✓
                </span>
              ) : failed ? (
                <>
                  <span className="wb-upload-failed-badge">Upload failed</span>
                  <span className="wb-upload-controls">
                    <button
                      type="button"
                      className="wb-upload-control wb-upload-retry"
                      aria-label={`Retry upload for ${item.job.fileId}`}
                      onClick={() => handleRetryUpload(item.job.fileId)}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="wb-upload-control wb-upload-remove"
                      aria-label={`Remove failed upload for ${item.job.fileId}`}
                      onClick={() => handleRemoveUpload(item.job)}
                    >
                      Remove
                    </button>
                  </span>
                </>
              ) : (
                <span
                  className={`wb-upload-loader${item.largeEnough ? '' : ' wb-upload-loader--compact'}`}
                  role="status"
                  aria-label="Uploading"
                >
                  {item.largeEnough ? (
                    <>
                      <span className="wb-upload-loader-bar" />
                      <span>Uploading</span>
                    </>
                  ) : (
                    <span className="wb-upload-spinner" />
                  )}
                </span>
              )}
            </div>
          )
        })}
      </div>
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
      {uploadStatus ? (
        <div
          className={`wb-upload-status wb-upload-status--${uploadStatus.kind}`}
          role={uploadStatus.kind === 'blocking' ? 'alert' : undefined}
          aria-live={uploadStatus.kind === 'blocking' ? 'assertive' : 'polite'}
        >
          <span>{uploadStatus.message}</span>
          {uploadStatus.kind === 'failed' ? (
            <button
              type="button"
              className="wb-upload-status-retry wb-upload-control"
              onClick={handleRetryAllUploads}
            >
              Retry
            </button>
          ) : null}
        </div>
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
