import { isSignedIn, onAuthChange, whenAuthReady } from '../lib/whiteboard-identity'
import {
  closeBoardShareCode,
  fetchBoardShareCode,
  formatShareExpiry,
  openBoardShareCode,
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
  getEntryActive,
  getHostSecret,
  readBoardIdFromPath,
  setBoardTitleActive,
} from './whiteboard-library'

const DEFAULT_LIVE_TITLE = 'Untitled board'
const MAX_BOARD_TITLE_LENGTH = 80

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

async function patchLiveBoardTitle(
  boardId: string,
  title: string,
): Promise<string> {
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
  const body: Record<string, string> = { title }
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
  let payload: { title?: unknown; error?: unknown } = {}
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    // ignore
  }
  if (!res.ok) {
    const message =
      typeof payload.error === 'string' && payload.error
        ? payload.error
        : 'Could not save the name. Check your connection and try again.'
    throw new Error(message)
  }
  const next =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : title.trim()
  return next.slice(0, MAX_BOARD_TITLE_LENGTH)
}

const PARTICIPANTS_EVENT = 'scsfoxchase:whiteboard-participants'
const FOLLOW_EVENT = 'scsfoxchase:whiteboard-follow'
const FOLLOWING_EVENT = 'scsfoxchase:whiteboard-following'
const FORCE_FOLLOW_EVENT = 'scsfoxchase:whiteboard-force-follow'
const HELLO_EVENT = 'scsfoxchase:whiteboard-hello'

function roleLabel(role: WhiteboardRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function initWhiteboardMenu() {
  const root = document.querySelector<HTMLElement>('[data-whiteboard-menu]')
  if (!root) return

  const mode = root.getAttribute('data-whiteboard-mode')
  if (mode !== 'manage') return

  const toggle = root.querySelector<HTMLButtonElement>('[data-whiteboard-toggle]')
  const panel = root.querySelector<HTMLElement>('[data-whiteboard-panel]')
  const nameForm = root.querySelector<HTMLFormElement>('[data-wb-manage-name]')
  const titleInput = root.querySelector<HTMLInputElement>('[data-wb-manage-title]')
  const liveTitleEl = root.querySelector<HTMLElement>('[data-wb-live-title]')
  const hint = root.querySelector<HTMLElement>('[data-wb-manage-hint]')

  const shareBlock = root.querySelector<HTMLElement>('[data-wb-manage-share]')
  const shareTools = root.querySelector<HTMLElement>('[data-wb-manage-share-tools]')
  const shareToggle = root.querySelector<HTMLInputElement>('[data-wb-share-toggle]')
  const shareState = root.querySelector<HTMLElement>('[data-wb-share-state]')
  const shareCodeBtn = root.querySelector<HTMLButtonElement>('[data-wb-share-code]')
  const shareCodeValue = root.querySelector<HTMLElement>('[data-wb-share-code-value]')
  const shareNew = root.querySelector<HTMLButtonElement>('[data-wb-share-new]')
  const shareCopyLink = root.querySelector<HTMLButtonElement>('[data-wb-share-copy-link]')
  const shareExpiry = root.querySelector<HTMLElement>('[data-wb-share-expiry]')
  const shareHint = root.querySelector<HTMLElement>('[data-wb-share-hint]')
  const shareToast = root.querySelector<HTMLElement>('[data-wb-share-toast]')
  const shareRight = root.querySelector<HTMLElement>('[data-wb-manage-right]')

  const peopleList = root.querySelector<HTMLUListElement>('[data-wb-people-list]')
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

  if (!toggle || !panel) return

  const boardId = readBoardIdFromPath()
  let shareBusy = false
  let expiryTimer: number | null = null
  let shareToastTimer: number | null = null
  let currentShare: ShareCodeState = { code: null, expiresAt: null, open: false }
  let titleDirty = false
  let titleSyncGen = 0
  let liveTitle = ''

  let participants: ParticipantRow[] = []
  let yourSessionId = ''
  let yourRole: WhiteboardRole | '' =
    (boardId && getBoardSessionAuth(boardId)?.role) || ''
  let followingUserId: string | null = null
  let roleBusy = false
  let forceFollowBusy = false
  let forceFollowOn = false
  let forceFollowTargetUserId = ''
  const canForceFollow = () => yourRole === 'owner' || yourRole === 'manager'
  const canRenameBoard = () => canForceFollow()
  const canManageShare = () => canForceFollow()
  const stopExpiryTimer = () => {
    if (expiryTimer != null) {
      window.clearInterval(expiryTimer)
      expiryTimer = null
    }
  }
  const nameDivider =
    nameForm?.nextElementSibling instanceof HTMLElement &&
    nameForm.nextElementSibling.classList.contains('whiteboard-menu-divider')
      ? nameForm.nextElementSibling
      : null

  const renderNameFormUi = () => {
    const allowed = canRenameBoard()
    if (nameForm) nameForm.hidden = !allowed
    if (nameDivider) nameDivider.hidden = !allowed
    if (liveTitleEl) {
      liveTitleEl.hidden = allowed || !liveTitleEl.textContent
    }
  }

  const renderShareAdminUi = () => {
    const allowed = canManageShare()
    if (shareBlock) shareBlock.hidden = !allowed
    if (shareTools) shareTools.hidden = !allowed
    if (!allowed) {
      stopExpiryTimer()
      currentShare = { code: null, expiresAt: null, open: false }
      if (shareToggle) shareToggle.checked = false
      if (shareState) shareState.textContent = 'Closed'
      if (shareCodeBtn) shareCodeBtn.disabled = true
      if (shareCodeValue) shareCodeValue.textContent = 'Code'
    }
  }

  if (forceFollowBlock) forceFollowBlock.hidden = !canForceFollow()
  renderNameFormUi()
  renderShareAdminUi()

  const applyTitle = (title: string) => {
    const cleaned = title.trim() || DEFAULT_LIVE_TITLE
    liveTitle = cleaned
    if (titleInput && !titleDirty) titleInput.value = cleaned
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
      const seed = entry?.title?.trim() || ''
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
    if (forceFollowTarget) {
      forceFollowTarget.disabled = !canForceFollow()
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

  const setSharingLayout = (open: boolean) => {
    const showRight = canManageShare() ? open : participants.length > 0
    panel.classList.toggle('is-sharing', showRight)
    if (shareRight) shareRight.hidden = !showRight
  }

  const renderShareUi = (state: ShareCodeState) => {
    currentShare = state
    const open = Boolean(state.open && state.code)

    if (shareToggle) shareToggle.checked = open
    if (shareState) shareState.textContent = open ? 'Open' : 'Closed'
    if (shareCodeBtn) shareCodeBtn.disabled = !open
    if (shareCodeValue) {
      shareCodeValue.textContent = open && state.code ? state.code : 'Code'
    }
    setSharingLayout(open)

    stopExpiryTimer()
    if (shareExpiry) {
      if (open && state.expiresAt) {
        const tick = () => {
          const time = formatShareExpiry(state.expiresAt!)
          if (!shareExpiry) return
          if (time === 'Expired') {
            shareExpiry.hidden = true
            shareExpiry.textContent = ''
            void refreshShareState()
            return
          }
          shareExpiry.hidden = false
          shareExpiry.textContent = `Codes expire in ${time}. A new code is needed to share again.`
        }
        tick()
        expiryTimer = window.setInterval(tick, 30_000)
      } else {
        shareExpiry.hidden = true
        shareExpiry.textContent = ''
      }
    }
  }

  const refreshShareState = async () => {
    if (!boardId || !canManageShare()) return
    try {
      const state = await fetchBoardShareCode(boardId)
      renderShareUi(state)
      setShareHint(null)
    } catch {
      setShareHint('Could not load share code status.')
    }
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

  const renderPeople = () => {
    if (!peopleList || !peopleEmpty) return

    peopleList.replaceChildren()
    if (participants.length === 0) {
      peopleList.hidden = true
      peopleEmpty.hidden = false
      renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
      renderNameFormUi()
      renderShareAdminUi()
      setSharingLayout(Boolean(currentShare.open && currentShare.code))
      return
    }

    peopleList.hidden = false
    peopleEmpty.hidden = true

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

      const followBtn = document.createElement('button')
      followBtn.type = 'button'
      followBtn.className = 'whiteboard-people-follow'
      const canFollow = Boolean(person.userId)
      followBtn.disabled = !canFollow
      const isFollowing = Boolean(
        person.userId && followingUserId && followingUserId === person.userId,
      )
      followBtn.textContent = isFollowing ? 'Following' : 'Follow'
      followBtn.setAttribute('aria-pressed', isFollowing ? 'true' : 'false')
      if (canFollow) {
        followBtn.addEventListener('click', () => {
          window.dispatchEvent(
            new CustomEvent(FOLLOW_EVENT, {
              detail: { userId: person.userId },
            }),
          )
        })
      }

      const assignable = yourRole
        ? assignableRolesFor(yourRole, person.role)
        : null
      let roleControl: HTMLElement
      if (assignable && boardId) {
        const select = document.createElement('select')
        select.className = 'whiteboard-people-role'
        select.setAttribute('aria-label', `Role for ${label}`)
        select.disabled = roleBusy
        for (const role of assignable) {
          const opt = document.createElement('option')
          opt.value = role
          opt.textContent = roleLabel(role)
          if (role === person.role) opt.selected = true
          select.append(opt)
        }
        if (!assignable.includes(person.role as (typeof assignable)[number])) {
          const current = document.createElement('option')
          current.value = person.role
          current.textContent = roleLabel(person.role)
          current.selected = true
          select.prepend(current)
        }
        select.addEventListener('change', () => {
          const next = select.value
          if (next !== 'manager' && next !== 'editor' && next !== 'viewer') {
            select.value = person.role
            return
          }
          if (roleBusy) {
            select.value = person.role
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
              select.value = person.role
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
        roleControl = select
      } else {
        const badge = document.createElement('span')
        badge.className = 'whiteboard-people-role-label'
        badge.textContent = roleLabel(person.role)
        roleControl = badge
      }

      li.append(name, followBtn, roleControl)
      peopleList.append(li)
    }
    renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
    renderNameFormUi()
    renderShareAdminUi()
    setSharingLayout(Boolean(currentShare.open && currentShare.code))
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
  }) as EventListener)

  const setOpen = (open: boolean) => {
    root.classList.toggle('is-open', open)
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    panel.setAttribute('aria-hidden', open ? 'false' : 'true')
    if (open) {
      titleDirty = false
      if (liveTitle) applyTitle(liveTitle)
      else syncTitleFromLiveRoom()
      setHint(null)
      titleInput?.setCustomValidity('')
      void refreshShareState()
      renderPeople()
      if (canRenameBoard()) {
        window.requestAnimationFrame(() => {
          titleInput?.focus()
          titleInput?.select()
        })
      }
    } else {
      stopExpiryTimer()
      setShareHint(null)
      setPeopleHint(null)
      setForceFollowHint(null)
    }
  }

  const close = () => setOpen(false)
  const toggleMenu = () => setOpen(!root.classList.contains('is-open'))

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    toggleMenu()
  })

  // Keep outside-click closer from seeing panel clicks. Do not preventDefault —
  // that would cancel Save / form submit button activation.
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
      close()
      toggle.focus()
    }
  })

  titleInput?.addEventListener('input', () => {
    titleDirty = true
    titleInput.setCustomValidity('')
    setHint(null)
  })

  nameForm?.addEventListener('submit', (event) => {
    event.preventDefault()

    if (!canRenameBoard()) {
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
    // Live-room PATCH is the source of truth. Owner Recents is an optional mirror.
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
        titleSyncGen += 1
        applyTitle(nextTitleLive)
        let mirroredToLibrary = false
        if (yourRole === 'owner') {
          try {
            await setBoardTitleActive(boardId, nextTitleLive)
            mirroredToLibrary = isSignedIn()
          } catch {
            // Recents is an optional Owner index; the live room already has the name.
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

  shareToggle?.addEventListener('change', () => {
    if (!boardId || shareBusy || !canManageShare()) {
      if (shareToggle) shareToggle.checked = currentShare.open
      return
    }
    shareBusy = true
    setShareHint(null)
    const wantOpen = shareToggle.checked
    void (async () => {
      try {
        const state = wantOpen
          ? await openBoardShareCode(boardId)
          : await closeBoardShareCode(boardId)
        renderShareUi(state)
      } catch (err) {
        renderShareUi(currentShare)
        setShareHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not update share code.',
        )
      } finally {
        shareBusy = false
      }
    })()
  })

  shareNew?.addEventListener('click', () => {
    if (!boardId || shareBusy || !currentShare.open || !canManageShare()) return
    shareBusy = true
    setShareHint(null)
    void (async () => {
      try {
        const state = await openBoardShareCode(boardId, { rotate: true })
        renderShareUi(state)
        showShareToast('New Code Generated\nOld Code Expired')
      } catch (err) {
        setShareHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not rotate share code.',
        )
      } finally {
        shareBusy = false
      }
    })()
  })

  // Activating the share code control copies it (no separate Copy Code button).
  shareCodeBtn?.addEventListener('click', () => {
    const code = currentShare.code
    if (!canManageShare() || !code || !currentShare.open) return
    void copyText(
      code,
      'Code Copied',
      'Copy failed — try again or copy manually.',
    )
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
      } catch (err) {
        renderForceFollowUi(forceFollowOn, forceFollowTargetUserId)
        setForceFollowHint(
          err instanceof Error && err.message
            ? err.message
            : 'Could not update force follow.',
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
            : 'Could not update force follow.',
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
