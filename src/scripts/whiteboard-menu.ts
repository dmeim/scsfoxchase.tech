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
  readBoardIdFromPath,
  setBoardTitleActive,
} from './whiteboard-library'

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
  const hint = root.querySelector<HTMLElement>('[data-wb-manage-hint]')

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

  if (forceFollowBlock) forceFollowBlock.hidden = !canForceFollow()

  const applyTitle = (title: string) => {
    if (!titleInput) return
    titleInput.value = title
    document.title = `${title} - St. Cecilia Technology`
  }

  const syncTitleFromLibrary = () => {
    if (!boardId || !titleInput) return
    const gen = ++titleSyncGen
    // Wait for Clerk so signed-in users read cloud library, not localStorage.
    void whenAuthReady()
      .then(() => getEntryActive(boardId))
      .then((entry) => {
        if (gen !== titleSyncGen || titleDirty) return
        if (entry) applyTitle(entry.title)
      })
  }

  syncTitleFromLibrary()
  onAuthChange(() => {
    syncTitleFromLibrary()
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

  const stopExpiryTimer = () => {
    if (expiryTimer != null) {
      window.clearInterval(expiryTimer)
      expiryTimer = null
    }
  }

  const setSharingLayout = (open: boolean) => {
    panel.classList.toggle('is-sharing', open)
    if (shareRight) shareRight.hidden = !open
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
    if (!boardId) return
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
    if (detail.yourRole) yourRole = detail.yourRole
    renderPeople()
  }) as EventListener)

  window.addEventListener(HELLO_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as { role?: WhiteboardRole; sessionId?: string }
    if (detail.role) yourRole = detail.role
    if (typeof detail.sessionId === 'string') yourSessionId = detail.sessionId
    if (forceFollowBlock) forceFollowBlock.hidden = !canForceFollow()
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
      syncTitleFromLibrary()
      setHint(null)
      titleInput?.setCustomValidity('')
      void refreshShareState()
      renderPeople()
      window.requestAnimationFrame(() => {
        titleInput?.focus()
        titleInput?.select()
      })
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
    // Wait for Clerk so signed-in Save writes the cloud library.
    void (async () => {
      try {
        await whenAuthReady()
        const next = await setBoardTitleActive(boardId, nextTitle)
        titleDirty = false
        titleSyncGen += 1
        applyTitle(next.title)
        setHint(
          isSignedIn()
            ? 'Saved to your Google library.'
            : 'Name kept on this scratch board. Sign in to save it to your library.',
        )
      } catch {
        setHint('Could not save the name. Check your connection and try again.')
      }
    })()
  })

  shareToggle?.addEventListener('change', () => {
    if (!boardId || shareBusy) {
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
    if (!boardId || shareBusy || !currentShare.open) return
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
    if (!code || !currentShare.open) return
    void copyText(
      code,
      'Code Copied',
      'Copy failed — try again or copy manually.',
    )
  })

  shareCopyLink?.addEventListener('click', () => {
    if (!boardId) return
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
