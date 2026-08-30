import { isSignedIn, onAuthChange, whenAuthReady } from '../lib/whiteboard-identity'
import {
  ensureBoardShareCode,
  fetchBoardShareCode,
  type ShareCodeState,
} from '../lib/whiteboard-codes'
import { peopleListLabel } from '../lib/whiteboard-display-name'
import {
  getBoardSessionAuth,
  setForceFollow,
  setParticipantRole,
  type ParticipantRow,
  type WhiteboardRole,
} from '../lib/whiteboard-participants'
import { assignableRolesFor } from '../lib/whiteboard-sync'
import {
  iconChevronDown,
  iconCrown,
  iconEye,
  iconEyeOff,
  iconPencil,
  iconShieldUser,
} from './icons'
import { uiClassNames } from '../components/ui/dom'
import {
  getEntryActive,
  getHostSecret,
  getScratchBoardTitle,
  patchLiveBoardTitle,
  readBoardIdFromPath,
  setBoardTitleActive,
} from './whiteboard-library'

const DEFAULT_LIVE_TITLE = 'Untitled board'
const JOIN_CODE_COOKIE_PREFIX = 'scsfoxchase_wbj_'
const JOIN_CODE_COOKIE_MAX_AGE = 12 * 60 * 60
const JOIN_CODE_STORAGE_PREFIX = 'scsfoxchase.whiteboard.joinCode.'
const JOIN_CODE_RE = /^([0-9][A-Z]){2}(([0-9][A-Z]){2})?$/

function writeJoinCodeCookie(boardId: string, code: string) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${JOIN_CODE_COOKIE_PREFIX}${boardId}=${encodeURIComponent(code)}; Path=/; Max-Age=${JOIN_CODE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
}

function rememberJoinCode(boardId: string, code: string) {
  const normalized = code.trim().toUpperCase()
  if (!boardId || !JOIN_CODE_RE.test(normalized)) return
  try {
    sessionStorage.setItem(`${JOIN_CODE_STORAGE_PREFIX}${boardId}`, normalized)
  } catch {
    // Private mode may block sessionStorage; cookie is enough for connect.
  }
  writeJoinCodeCookie(boardId, normalized)
}

function restoreJoinCodeCookie() {
  const boardId = readBoardIdFromPath()
  if (!boardId) return
  try {
    const code = sessionStorage.getItem(`${JOIN_CODE_STORAGE_PREFIX}${boardId}`)
    if (code) writeJoinCodeCookie(boardId, code)
  } catch {
    // ignore
  }
}

function installJoinCodeCapture() {
  const flagged = window as Window & { __scsfoxchaseJoinCodeCapture?: boolean }
  if (flagged.__scsfoxchaseJoinCodeCapture) return
  flagged.__scsfoxchaseJoinCodeCapture = true
  const orig = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init)
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : String(input)
      const match = url.match(/\/api\/whiteboard\/join\/([^/?#]+)/i)
      if (match?.[1] && res.ok) {
        const code = decodeURIComponent(match[1])
        const body = (await res.clone().json()) as { id?: unknown }
        if (typeof body.id === 'string' && body.id) {
          rememberJoinCode(body.id, code)
        }
      }
    } catch {
      // Join lookup still returns to the caller.
    }
    return res
  }
}

installJoinCodeCapture()
restoreJoinCodeCookie()

function isPlaceholderTitle(title: string): boolean {
  const cleaned = title.trim()
  return !cleaned || cleaned === DEFAULT_LIVE_TITLE
}

async function readLiveBoardTitle(boardId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { title?: unknown }
    return typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : null
  } catch {
    return null
  }
}

async function readClassCanEdit(boardId: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { classCanEdit?: unknown }
    return body.classCanEdit === true
  } catch {
    return null
  }
}

async function patchClassCanEdit(
  boardId: string,
  classCanEdit: boolean,
): Promise<boolean> {
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
  const body: Record<string, unknown> = { classCanEdit }
  if (sessionAuth) {
    body.sessionId = sessionAuth.sessionId
    body.authToken = sessionAuth.authToken
  }
  const res = await fetch(
    `/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    },
  )
  let payload: { classCanEdit?: unknown; error?: unknown } = {}
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    // ignore
  }
  if (!res.ok) {
    const message =
      typeof payload.error === 'string' && payload.error
        ? payload.error
        : 'Could not update Group Edit.'
    throw new Error(message)
  }
  return payload.classCanEdit === true
}

const PARTICIPANTS_EVENT = 'scsfoxchase:whiteboard-participants'
const FOLLOW_EVENT = 'scsfoxchase:whiteboard-follow'
const FOLLOWING_EVENT = 'scsfoxchase:whiteboard-following'
const FORCE_FOLLOW_EVENT = 'scsfoxchase:whiteboard-force-follow'
const HELLO_EVENT = 'scsfoxchase:whiteboard-hello'

function roleLabel(role: WhiteboardRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function roleIcon(role: WhiteboardRole): string {
  if (role === 'owner') return iconCrown
  if (role === 'manager') return iconShieldUser
  if (role === 'editor') return iconPencil
  return iconEye
}

function initWhiteboardMenu() {
  const root = document.querySelector<HTMLElement>('[data-whiteboard-menu]')
  if (!root) return

  const mode = root.getAttribute('data-whiteboard-mode')
  if (mode !== 'manage') return

  const toggle = root.querySelector<HTMLButtonElement>('[data-whiteboard-toggle]')
  const panel = root.querySelector<HTMLElement>('[data-whiteboard-panel]')
  const nameForm = root.querySelector<HTMLFormElement>('[data-wb-manage-name]')
  const nameWrap = root.querySelector<HTMLElement>('[data-wb-manage-name-wrap]')
  const titleDisplay = root.querySelector<HTMLButtonElement>('[data-wb-title-display]')
  const titleText = root.querySelector<HTMLElement>('[data-wb-title-text]')
  const titleInput = root.querySelector<HTMLInputElement>('[data-wb-manage-title]')
  const liveTitleEl = root.querySelector<HTMLElement>('[data-wb-live-title]')
  const hint = root.querySelector<HTMLElement>('[data-wb-manage-hint]')

  const shareBlock = root.querySelector<HTMLElement>('[data-wb-manage-share]')
  const shareCodeBtn = root.querySelector<HTMLButtonElement>('[data-wb-share-code]')
  const shareCodeValue = root.querySelector<HTMLElement>('[data-wb-share-code-value]')
  const shareCopyCode = root.querySelector<HTMLButtonElement>('[data-wb-share-copy-code]')
  const shareCopyLink = root.querySelector<HTMLButtonElement>('[data-wb-share-copy-link]')
  const shareHint = root.querySelector<HTMLElement>('[data-wb-share-hint]')
  const shareToast = root.querySelector<HTMLElement>('[data-wb-share-toast]')
  const featuresCol = root.querySelector<HTMLElement>('[data-wb-manage-features]')

  const peopleList = root.querySelector<HTMLUListElement>('[data-wb-people-list]')
  const peopleCount = root.querySelector<HTMLElement>('[data-wb-people-count]')
  const peopleEmpty = root.querySelector<HTMLElement>('[data-wb-people-empty]')
  const peopleHint = root.querySelector<HTMLElement>('[data-wb-people-hint]')

  const forceFollowBlock = root.querySelector<HTMLElement>(
    '[data-wb-manage-force-follow]',
  )
  const forceFollowToggle = root.querySelector<HTMLInputElement>(
    '[data-wb-force-follow-toggle]',
  )
  const forceFollowState = root.querySelector<HTMLElement>(
    '[data-wb-force-follow-state]',
  )
  const forceFollowHint = root.querySelector<HTMLElement>(
    '[data-wb-force-follow-hint]',
  )
  const forceFollowTarget = root.querySelector<HTMLSelectElement>(
    '[data-wb-force-follow-target]',
  )
  const forceFollowTargetField =
    forceFollowTarget?.closest<HTMLElement>('.whiteboard-people-target') ?? null
  const classCanEditToggle = root.querySelector<HTMLInputElement>(
    '[data-wb-class-can-edit-toggle]',
  )
  const classCanEditState = root.querySelector<HTMLElement>(
    '[data-wb-class-can-edit-state]',
  )

  if (!toggle || !panel) return

  const boardId = readBoardIdFromPath()
  let liveTitle = DEFAULT_LIVE_TITLE
  let titleDirty = false
  let titleSyncGen = 0
  let titleEditing = false
  let shareToastTimer: number | null = null
  let currentShare: ShareCodeState = { code: null }
  let participants: ParticipantRow[] = []
  let yourSessionId = ''
  let yourRole: WhiteboardRole | '' =
    (boardId && getBoardSessionAuth(boardId)?.role) || ''
  let followingUserId: string | null = null
  let roleBusy = false
  let forceFollowBusy = false
  let forceFollowOn = false
  let forceFollowTargetUserId = ''
  let classCanEditOn = false
  let classCanEditBusy = false
  const canForceFollow = () => yourRole === 'owner' || yourRole === 'manager'
  const canRenameBoard = () => canForceFollow()
  const canManageShare = () => canForceFollow()

  const renderNameFormUi = () => {
    const allowed = canRenameBoard()
    if (nameWrap) nameWrap.hidden = !allowed
    if (liveTitleEl) {
      liveTitleEl.hidden = allowed || !liveTitleEl.textContent
    }
    if (!allowed) {
      titleEditing = false
      if (nameForm) nameForm.hidden = true
      if (titleDisplay) titleDisplay.hidden = false
    } else if (titleEditing) {
      if (titleDisplay) titleDisplay.hidden = true
      if (nameForm) nameForm.hidden = false
    } else {
      if (titleDisplay) titleDisplay.hidden = false
      if (nameForm) nameForm.hidden = true
    }
  }

  const renderShareAdminUi = () => {
    const allowed = canManageShare()
    panel.classList.toggle('is-sharing', allowed)
    if (shareBlock) shareBlock.hidden = !allowed
    if (featuresCol) featuresCol.hidden = !allowed
    if (!allowed) {
      currentShare = { code: null }
      if (shareCodeBtn) shareCodeBtn.disabled = true
      if (shareCopyCode) shareCopyCode.disabled = true
      if (shareCodeValue) shareCodeValue.textContent = 'Code'
    }
  }

  const renderClassCanEditUi = (on: boolean) => {
    classCanEditOn = on
    if (classCanEditToggle) classCanEditToggle.checked = on
    if (classCanEditState) classCanEditState.textContent = on ? 'On' : 'Off'
  }

  if (forceFollowBlock) forceFollowBlock.hidden = !canForceFollow()
  renderNameFormUi()
  renderShareAdminUi()
  renderClassCanEditUi(classCanEditOn)

  const applyTitle = (title: string) => {
    const cleaned = title.trim() || DEFAULT_LIVE_TITLE
    liveTitle = cleaned
    if (titleInput && !titleDirty) titleInput.value = cleaned
    if (titleText) titleText.textContent = cleaned
    document.title = `${cleaned} - St. Cecilia Technology`
    if (liveTitleEl) {
      liveTitleEl.textContent = cleaned
      liveTitleEl.hidden = canRenameBoard()
    }
  }

  const maybeSeedOwnerTitle = async (currentLive: string) => {
    if (!boardId || yourRole !== 'owner' || !isPlaceholderTitle(currentLive)) {
      return
    }
    try {
      await whenAuthReady()
      if (yourRole !== 'owner') return
      const entry = await getEntryActive(boardId)
      const seed =
        entry?.title?.trim() || getScratchBoardTitle(boardId)?.trim() || ''
      if (!seed || isPlaceholderTitle(seed)) return
      const next = await patchLiveBoardTitle(boardId, seed)
      if (!titleDirty) applyTitle(next)
    } catch {
      // Recents is only a one-time Owner backfill, not the live name.
    }
  }

  const syncTitleFromLiveRoom = (helloTitle?: string) => {
    if (!boardId) return
    const gen = ++titleSyncGen
    const fromHello = typeof helloTitle === 'string' ? helloTitle.trim() : ''
    if (fromHello) {
      if (gen === titleSyncGen) applyTitle(fromHello)
      void maybeSeedOwnerTitle(fromHello)
      return
    }
    void readLiveBoardTitle(boardId).then((title) => {
      if (gen !== titleSyncGen || !title) return
      applyTitle(title)
      void maybeSeedOwnerTitle(title)
    })
  }

  syncTitleFromLiveRoom()
  onAuthChange(() => {
    renderNameFormUi()
  })

  const setHint = (message: string | null) => {
    if (!hint) return
    if (!message) {
      hint.hidden = true
      hint.textContent = ''
      return
    }
    hint.hidden = false
    hint.textContent = message
  }

  const setShareHint = (message: string | null) => {
    if (!shareHint) return
    if (!message) {
      shareHint.hidden = true
      shareHint.textContent = ''
      return
    }
    shareHint.hidden = false
    shareHint.textContent = message
  }

  const showShareToast = (message: string) => {
    if (!shareToast) return
    if (shareToastTimer != null) {
      window.clearTimeout(shareToastTimer)
      shareToastTimer = null
    }
    shareToast.hidden = false
    shareToast.textContent = message
    shareToastTimer = window.setTimeout(() => {
      shareToast.hidden = true
      shareToast.textContent = ''
      shareToastTimer = null
    }, 1000)
  }

  const setPeopleHint = (message: string | null) => {
    if (!peopleHint) return
    if (!message) {
      peopleHint.hidden = true
      peopleHint.textContent = ''
      return
    }
    peopleHint.hidden = false
    peopleHint.textContent = message
  }

  const setForceFollowHint = (message: string | null) => {
    if (!forceFollowHint) return
    if (!message) {
      forceFollowHint.hidden = true
      forceFollowHint.textContent = ''
      return
    }
    forceFollowHint.hidden = false
    forceFollowHint.textContent = message
  }

  const renderForceFollowUi = (on: boolean, targetUserId?: string) => {
    forceFollowOn = on
    if (typeof targetUserId === 'string') forceFollowTargetUserId = targetUserId
    if (forceFollowToggle) forceFollowToggle.checked = on
    if (forceFollowState) forceFollowState.textContent = on ? 'On' : 'Off'
    if (forceFollowBlock) forceFollowBlock.hidden = !canForceFollow()
    if (forceFollowTargetField) forceFollowTargetField.hidden = !on
    if (forceFollowTarget) {
      forceFollowTarget.disabled = !canForceFollow() || !on
      const self = participants.find((p) => p.sessionId === yourSessionId)
      const selfUserId = self?.userId ?? ''
      forceFollowTarget.replaceChildren()
      const meOpt = document.createElement('option')
      meOpt.value = selfUserId
      meOpt.textContent = 'Me'
      forceFollowTarget.append(meOpt)
      for (const person of participants) {
        if (!person.userId || person.userId === selfUserId) continue
        const opt = document.createElement('option')
        opt.value = person.userId
        opt.textContent = peopleListLabel(person.displayName, person.sessionId)
        forceFollowTarget.append(opt)
      }
      const wanted = forceFollowTargetUserId || selfUserId
      if (wanted && [...forceFollowTarget.options].some((o) => o.value === wanted)) {
        forceFollowTarget.value = wanted
      } else {
        forceFollowTarget.value = selfUserId
      }
    }
  }

  const renderShareUi = (state: ShareCodeState) => {
    currentShare = state
    const code = state.code
    if (shareCodeBtn) shareCodeBtn.disabled = !code
    if (shareCopyCode) shareCopyCode.disabled = !code
    if (shareCodeValue) {
      shareCodeValue.textContent = code || 'Code'
    }
  }

  const refreshShareState = async () => {
    if (!boardId || !canManageShare()) return
    try {
      let state = await fetchBoardShareCode(boardId)
      if (!state.code) {
        state = await ensureBoardShareCode(boardId)
      }
      renderShareUi(state)
      setShareHint(null)
    } catch {
      setShareHint('Could not load share code.')
    }
    const classCanEdit = await readClassCanEdit(boardId)
    if (classCanEdit !== null) renderClassCanEditUi(classCanEdit)
  }

  const copyText = async (
    text: string,
    successMessage: string,
    fallbackMessage?: string,
  ) => {
    try {
      await navigator.clipboard.writeText(text)
      showShareToast(successMessage)
    } catch {
      showShareToast(
        fallbackMessage ?? 'Copy failed — try again or copy manually.',
      )
    }
  }

  const copyCurrentCode = () => {
    const code = currentShare.code
    if (!canManageShare() || !code) return
    void copyText(
      code,
      'Code Copied',
      'Copy failed — try again or copy manually.',
    )
  }

  const renderPeople = () => {
    if (!peopleList || !peopleEmpty) return

    peopleList.replaceChildren()
    if (peopleCount) {
      peopleCount.textContent = `${participants.length} connected`
    }
    if (participants.length === 0) {
      peopleList.hidden = true
      peopleEmpty.hidden = false
      renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
      renderNameFormUi()
      renderShareAdminUi()
      return
    }

    peopleList.hidden = false
    peopleEmpty.hidden = true
    const eyesLocked = forceFollowOn

    for (const person of participants) {
      const isSelf = person.sessionId === yourSessionId
      const li = document.createElement('li')
      li.className = 'whiteboard-people-row'
      li.dataset.sessionId = person.sessionId
      if (person.userId) li.dataset.userId = person.userId

      const name = document.createElement('span')
      name.className = 'whiteboard-people-name'
      const label = peopleListLabel(person.displayName, person.sessionId)
      name.textContent = isSelf ? `${label} (you)` : label
      name.title = `${label} · ${roleLabel(person.role)}`

      const canManageRoles = yourRole === 'owner' || yourRole === 'manager'
      const assignable = canManageRoles
        ? assignableRolesFor(yourRole, person.role)
        : null
      let roleControl: HTMLElement
      if (canManageRoles && boardId && assignable) {
        const menu = document.createElement('details')
        menu.className = 'whiteboard-people-role-menu'
        const summary = document.createElement('summary')
        summary.className = 'whiteboard-people-role-trigger'
        summary.setAttribute('aria-label', `Role for ${label}: ${roleLabel(person.role)}`)
        summary.innerHTML =
          `<span class="whiteboard-people-role-current">${roleIcon(person.role)}<span>${roleLabel(person.role)}</span></span>` +
          `<span class="whiteboard-people-role-chevron">${iconChevronDown}</span>`
        menu.append(summary)

        const options = document.createElement('div')
        options.className = 'whiteboard-people-role-options'
        options.setAttribute('role', 'listbox')
        options.setAttribute('aria-label', `Role for ${label}`)
        const roles: WhiteboardRole[] = assignable
          ? Array.from(new Set<WhiteboardRole>([person.role, ...assignable]))
          : [person.role]
        for (const role of roles) {
          const option = document.createElement('button')
          option.type = 'button'
          option.className = 'whiteboard-people-role-option'
          option.setAttribute('role', 'option')
          option.setAttribute('aria-selected', role === person.role ? 'true' : 'false')
          option.innerHTML = `${roleIcon(role)}<span>${roleLabel(role)}</span>`
          option.addEventListener('click', () => {
            const next = role
            menu.open = false
            if (next === person.role) return
            if (next !== 'manager' && next !== 'editor' && next !== 'viewer') {
              return
            }
            if (roleBusy) {
              return
            }
            roleBusy = true
            setPeopleHint(null)
            void (async () => {
              try {
                const updated = await setParticipantRole(boardId, person.sessionId, next)
                const idx = participants.findIndex(
                  (p) => p.sessionId === updated.sessionId,
                )
                if (idx >= 0) {
                  participants[idx] = { ...participants[idx]!, ...updated }
                }
              } catch (err) {
                setPeopleHint(
                  err instanceof Error && err.message
                    ? err.message
                    : 'Could not update role.',
                )
              } finally {
                roleBusy = false
                renderPeople()
              }
            })()
          })
          options.append(option)
        }
        menu.append(options)
        roleControl = menu
      } else {
        const role = document.createElement('span')
        role.className = 'whiteboard-people-role-static'
        role.innerHTML = `${roleIcon(person.role)}<span>${roleLabel(person.role)}</span>`
        role.setAttribute(
          'aria-label',
          canManageRoles && person.role === 'owner'
            ? `${label} is the Owner and cannot be demoted`
            : `${label}: ${roleLabel(person.role)}`,
        )
        roleControl = role
      }

      const followBtn = document.createElement('button')
      followBtn.type = 'button'
      followBtn.className = uiClassNames.iconButton('small', 'whiteboard-people-eye')
      const canFollow = Boolean(person.userId) && !isSelf && !eyesLocked
      const isFollowing = Boolean(
        person.userId && followingUserId && followingUserId === person.userId,
      )
      followBtn.innerHTML = isFollowing ? iconEye : iconEyeOff
      followBtn.disabled = !canFollow
      followBtn.setAttribute('aria-pressed', isFollowing ? 'true' : 'false')
      followBtn.setAttribute(
        'aria-label',
        isSelf
          ? 'You cannot follow yourself'
          : eyesLocked
            ? 'Follow User is locking the room'
            : isFollowing
              ? `Stop following ${label}`
              : `Follow ${label}`,
      )
      if (eyesLocked) followBtn.classList.add('is-locked')
      if (canFollow) {
        followBtn.addEventListener('click', () => {
          window.dispatchEvent(
            new CustomEvent(FOLLOW_EVENT, {
              detail: { userId: person.userId },
            }),
          )
        })
      }

      li.append(followBtn)
      li.append(name)
      li.append(roleControl)
      peopleList.append(li)
    }
    renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
    renderNameFormUi()
    renderShareAdminUi()
  }

  window.addEventListener(PARTICIPANTS_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as {
      participants?: ParticipantRow[]
      yourSessionId?: string
      yourRole?: WhiteboardRole
    }
    participants = Array.isArray(detail.participants) ? detail.participants : []
    yourSessionId =
      typeof detail.yourSessionId === 'string' ? detail.yourSessionId : ''
    const couldManageShare = canManageShare()
    if (detail.yourRole) yourRole = detail.yourRole
    renderNameFormUi()
    renderShareAdminUi()
    if (
      !couldManageShare &&
      canManageShare() &&
      root.classList.contains('is-open')
    ) {
      void refreshShareState()
    }
    renderPeople()
  }) as EventListener)

  window.addEventListener(HELLO_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as {
      role?: WhiteboardRole
      sessionId?: string
      title?: string
    }
    if (detail.role) yourRole = detail.role
    if (typeof detail.sessionId === 'string') yourSessionId = detail.sessionId
    if (forceFollowBlock) forceFollowBlock.hidden = !canForceFollow()
    renderNameFormUi()
    renderShareAdminUi()
    if (canManageShare() && root.classList.contains('is-open')) {
      void refreshShareState()
    }
    if (typeof detail.title === 'string' && detail.title.trim()) {
      titleSyncGen += 1
      applyTitle(detail.title)
      void maybeSeedOwnerTitle(detail.title)
    } else {
      syncTitleFromLiveRoom()
    }
  }) as EventListener)

  window.addEventListener(FOLLOWING_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as { followingUserId?: string | null }
    followingUserId =
      typeof detail.followingUserId === 'string' ? detail.followingUserId : null
    renderPeople()
  }) as EventListener)

  window.addEventListener(FORCE_FOLLOW_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as {
      forceFollow?: boolean
      targetUserId?: string
    }
    renderForceFollowUi(
      Boolean(detail.forceFollow),
      typeof detail.targetUserId === 'string' ? detail.targetUserId : undefined,
    )
    renderPeople()
  }) as EventListener)

  const startTitleEdit = () => {
    if (!canRenameBoard()) return
    titleEditing = true
    titleDirty = false
    if (titleInput) titleInput.value = liveTitle
    renderNameFormUi()
    window.requestAnimationFrame(() => {
      titleInput?.focus()
      titleInput?.select()
    })
  }

  const setOpen = (open: boolean) => {
    root.classList.toggle('is-open', open)
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    panel.setAttribute('aria-hidden', open ? 'false' : 'true')
    if (open) {
      titleDirty = false
      titleEditing = false
      if (liveTitle) applyTitle(liveTitle)
      else syncTitleFromLiveRoom()
      setHint(null)
      titleInput?.setCustomValidity('')
      void refreshShareState()
      renderPeople()
    } else {
      titleEditing = false
      setShareHint(null)
      setPeopleHint(null)
      setForceFollowHint(null)
      renderNameFormUi()
    }
  }

  const close = () => setOpen(false)
  const toggleMenu = () => setOpen(!root.classList.contains('is-open'))

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    toggleMenu()
  })

  panel.addEventListener('click', (event) => {
    event.stopPropagation()
  })

  document.addEventListener('click', (event) => {
    if (!root.classList.contains('is-open')) return
    if (event.target instanceof Node && root.contains(event.target)) return
    close()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('is-open')) {
      if (titleEditing) {
        titleEditing = false
        titleDirty = false
        if (titleInput) titleInput.value = liveTitle
        renderNameFormUi()
        event.stopPropagation()
        return
      }
      close()
      toggle.focus()
    }
  })

  titleDisplay?.addEventListener('click', () => {
    startTitleEdit()
  })

  titleInput?.addEventListener('input', () => {
    titleDirty = true
    titleInput.setCustomValidity('')
    setHint(null)
  })

  titleInput?.addEventListener('blur', () => {
    if (!titleEditing) return
    if (titleDirty) {
      nameForm?.requestSubmit()
      return
    }
    titleEditing = false
    renderNameFormUi()
  })

  nameForm?.addEventListener('submit', (event) => {
    event.preventDefault()

    if (!canRenameBoard()) {
      titleEditing = false
      renderNameFormUi()
      setHint(null)
      return
    }

    if (!boardId) {
      setHint('Open a board from the library to rename it.')
      return
    }

    const nextTitle = (titleInput?.value ?? '').trim()
    if (!nextTitle) {
      if (titleInput) {
        titleInput.setCustomValidity('Enter a board name')
        titleInput.reportValidity()
        titleInput.focus()
      }
      setHint('Enter a name before saving.')
      return
    }

    titleInput?.setCustomValidity('')
    titleEditing = false
    titleDirty = false
    renderNameFormUi()
    void (async () => {
      try {
        await whenAuthReady()
        if (!canRenameBoard()) {
          renderNameFormUi()
          setHint(null)
          return
        }
        const nextTitleLive = await patchLiveBoardTitle(boardId, nextTitle)
        titleDirty = false
        titleEditing = false
        titleSyncGen += 1
        applyTitle(nextTitleLive)
        renderNameFormUi()
        let mirroredToLibrary = false
        if (yourRole === 'owner') {
          try {
            await setBoardTitleActive(boardId, nextTitleLive)
            mirroredToLibrary = isSignedIn()
          } catch {
            // Recents PUT failed; do not claim the library-saved hint.
          }
        }
        setHint(
          mirroredToLibrary
            ? 'Name saved on this board and in your library. Save does not store the drawing.'
            : isSignedIn()
              ? 'Name saved on this board. Save does not store the drawing.'
              : 'Name saved on this board. Sign in to save it to your library.',
        )
      } catch (err) {
        setHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not save the name. Check your connection and try again.',
        )
      }
    })()
  })

  classCanEditToggle?.addEventListener('change', () => {
    if (!boardId || classCanEditBusy || !canManageShare()) {
      if (classCanEditToggle) classCanEditToggle.checked = classCanEditOn
      return
    }
    classCanEditBusy = true
    setShareHint(null)
    const wantOn = classCanEditToggle.checked
    void (async () => {
      try {
        const next = await patchClassCanEdit(boardId, wantOn)
        renderClassCanEditUi(next)
      } catch (err) {
        renderClassCanEditUi(classCanEditOn)
        setShareHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not update Group Edit.',
        )
      } finally {
        classCanEditBusy = false
      }
    })()
  })

  shareCodeBtn?.addEventListener('click', () => {
    copyCurrentCode()
  })

  shareCopyCode?.addEventListener('click', () => {
    copyCurrentCode()
  })

  shareCopyLink?.addEventListener('click', () => {
    if (!boardId || !canManageShare()) return
    const url = `${window.location.origin}/board/${boardId}`
    void copyText(
      url,
      'Link Copied',
      'Copy failed — select and copy the address bar instead.',
    )
  })

  forceFollowToggle?.addEventListener('change', () => {
    if (!boardId || !canForceFollow() || forceFollowBusy) {
      if (forceFollowToggle) forceFollowToggle.checked = forceFollowOn
      return
    }
    forceFollowBusy = true
    setForceFollowHint(null)
    const wantOn = forceFollowToggle.checked
    const targetUserId = forceFollowTarget?.value || undefined
    void (async () => {
      try {
        const result = await setForceFollow(boardId, wantOn, { targetUserId })
        renderForceFollowUi(result.forceFollow, result.targetUserId)
        renderPeople()
      } catch (err) {
        renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
        setForceFollowHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not update Follow User.',
        )
      } finally {
        forceFollowBusy = false
      }
    })()
  })

  forceFollowTarget?.addEventListener('change', () => {
    if (!boardId || !canForceFollow() || forceFollowBusy || !forceFollowOn) {
      return
    }
    forceFollowBusy = true
    setForceFollowHint(null)
    const targetUserId = forceFollowTarget.value || undefined
    void (async () => {
      try {
        const result = await setForceFollow(boardId, true, { targetUserId })
        renderForceFollowUi(result.forceFollow, result.targetUserId)
      } catch (err) {
        renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
        setForceFollowHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not update Follow User.',
        )
      } finally {
        forceFollowBusy = false
      }
    })()
  })

  close()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWhiteboardMenu)
} else {
  initWhiteboardMenu()
}
