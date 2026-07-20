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
  setForceFollow,
  setParticipantCanEdit,
  type ParticipantRow,
} from '../lib/whiteboard-participants'
import {
  getEntryActive,
  getHostSecret,
  readBoardIdFromPath,
  setBoardTitleActive,
} from './whiteboard-library'

const PARTICIPANTS_EVENT = 'scsfoxchase:whiteboard-participants'
const FOLLOW_EVENT = 'scsfoxchase:whiteboard-follow'
const FOLLOWING_EVENT = 'scsfoxchase:whiteboard-following'
const FORCE_FOLLOW_EVENT = 'scsfoxchase:whiteboard-force-follow'

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
  const shareCodeInput = root.querySelector<HTMLInputElement>('[data-wb-share-code]')
  const shareCopy = root.querySelector<HTMLButtonElement>('[data-wb-share-copy]')
  const shareNew = root.querySelector<HTMLButtonElement>('[data-wb-share-new]')
  const shareExpiry = root.querySelector<HTMLElement>('[data-wb-share-expiry]')
  const shareHint = root.querySelector<HTMLElement>('[data-wb-share-hint]')

  const peopleList = root.querySelector<HTMLUListElement>('[data-wb-people-list]')
  const peopleEmpty = root.querySelector<HTMLElement>('[data-wb-people-empty]')
  const peopleHint = root.querySelector<HTMLElement>('[data-wb-people-hint]')

  const forceFollowBlock = root.querySelector<HTMLElement>(
    '[data-wb-manage-force-follow]',
  )
  const forceFollowDivider = root.querySelector<HTMLElement>(
    '[data-wb-force-follow-divider]',
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

  if (!toggle || !panel) return

  const boardId = readBoardIdFromPath()
  let shareBusy = false
  let expiryTimer: number | null = null
  let currentShare: ShareCodeState = { code: null, expiresAt: null, open: false }

  let participants: ParticipantRow[] = []
  let yourSessionId = ''
  let followingUserId: string | null = null
  let editBusy = false
  let forceFollowBusy = false
  let forceFollowOn = false
  const isHost = Boolean(boardId && getHostSecret(boardId))

  if (forceFollowBlock) forceFollowBlock.hidden = !isHost
  if (forceFollowDivider) forceFollowDivider.hidden = !isHost

  const syncTitleFromLibrary = () => {
    if (!boardId || !titleInput) return
    // Wait for Clerk so signed-in users read cloud library, not localStorage.
    void whenAuthReady()
      .then(() => getEntryActive(boardId))
      .then((entry) => {
        if (entry && titleInput) {
          titleInput.value = entry.title
          document.title = `${entry.title} - St. Cecilia Technology`
        }
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

  const renderForceFollowUi = (on: boolean) => {
    forceFollowOn = on
    if (forceFollowToggle) forceFollowToggle.checked = on
    if (forceFollowState) forceFollowState.textContent = on ? 'On' : 'Off'
  }

  const stopExpiryTimer = () => {
    if (expiryTimer != null) {
      window.clearInterval(expiryTimer)
      expiryTimer = null
    }
  }

  const renderShareUi = (state: ShareCodeState) => {
    currentShare = state
    const open = Boolean(state.open && state.code)

    if (shareToggle) shareToggle.checked = open
    if (shareState) shareState.textContent = open ? 'Open' : 'Closed'
    if (shareCodeInput) {
      shareCodeInput.value = open && state.code ? state.code : ''
      shareCodeInput.placeholder = open ? '' : 'Closed'
    }
    if (shareCopy) shareCopy.disabled = !open
    if (shareNew) shareNew.hidden = !open

    stopExpiryTimer()
    if (shareExpiry) {
      if (open && state.expiresAt) {
        const tick = () => {
          const label = formatShareExpiry(state.expiresAt!)
          if (!shareExpiry) return
          if (label === 'Expired') {
            shareExpiry.hidden = true
            shareExpiry.textContent = ''
            void refreshShareState()
            return
          }
          shareExpiry.hidden = false
          shareExpiry.textContent = label
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

  const renderPeople = () => {
    if (!peopleList || !peopleEmpty) return

    peopleList.replaceChildren()
    if (participants.length === 0) {
      peopleList.hidden = true
      peopleEmpty.hidden = false
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
      name.title = label

      const followBtn = document.createElement('button')
      followBtn.type = 'button'
      followBtn.className = 'whiteboard-people-follow'
      const canFollow = Boolean(person.userId) && !isSelf
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

      const editLabel = document.createElement('label')
      editLabel.className = 'whiteboard-switch whiteboard-people-edit'
      const editText = document.createElement('span')
      editText.className = 'visually-hidden'
      editText.textContent = `Edit for ${label}`
      const editInput = document.createElement('input')
      editInput.type = 'checkbox'
      // Host self always on; demoted guests (including self) show real canEdit.
      editInput.checked = person.isHost ? true : person.canEdit
      editInput.setAttribute('aria-label', `Allow ${label} to edit`)
      // Host/self cannot toggle themselves; only host toggles other guests.
      if (person.isHost || isSelf) {
        editInput.disabled = true
      } else {
        editInput.disabled = !isHost || editBusy
      }
      const track = document.createElement('span')
      track.className = 'whiteboard-switch-track'
      track.setAttribute('aria-hidden', 'true')
      editLabel.append(editText, editInput, track)

      if (isHost && !person.isHost && !isSelf && boardId) {
        editInput.addEventListener('change', () => {
          if (editBusy) {
            editInput.checked = person.canEdit
            return
          }
          editBusy = true
          setPeopleHint(null)
          const wantEdit = editInput.checked
          void (async () => {
            try {
              const updated = await setParticipantCanEdit(
                boardId,
                person.sessionId,
                wantEdit,
              )
              const idx = participants.findIndex(
                (p) => p.sessionId === updated.sessionId,
              )
              if (idx >= 0) {
                participants[idx] = { ...participants[idx]!, ...updated }
              }
            } catch (err) {
              editInput.checked = person.canEdit
              setPeopleHint(
                err instanceof Error && err.message
                  ? err.message
                  : 'Could not update edit permission.',
              )
            } finally {
              editBusy = false
              renderPeople()
            }
          })()
        })
      }

      li.append(name, followBtn, editLabel)
      peopleList.append(li)
    }
  }

  window.addEventListener(PARTICIPANTS_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as {
      participants?: ParticipantRow[]
      yourSessionId?: string
    }
    participants = Array.isArray(detail.participants) ? detail.participants : []
    yourSessionId =
      typeof detail.yourSessionId === 'string' ? detail.yourSessionId : ''
    renderPeople()
  }) as EventListener)

  window.addEventListener(FOLLOWING_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as { followingUserId?: string | null }
    followingUserId =
      typeof detail.followingUserId === 'string' ? detail.followingUserId : null
    renderPeople()
  }) as EventListener)

  window.addEventListener(FORCE_FOLLOW_EVENT, ((event: CustomEvent) => {
    const detail = event.detail as { forceFollow?: boolean }
    renderForceFollowUi(Boolean(detail.forceFollow))
  }) as EventListener)

  const setOpen = (open: boolean) => {
    root.classList.toggle('is-open', open)
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    panel.setAttribute('aria-hidden', open ? 'false' : 'true')
    if (open) {
      syncTitleFromLibrary()
      setHint(null)
      titleInput?.setCustomValidity('')
      void refreshShareState()
      renderPeople()
      renderForceFollowUi(forceFollowOn)
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
    // Gate on auth-ready so a pre-AuthBridge Save does not write localStorage.
    void (async () => {
      try {
        await whenAuthReady()
        const next = await setBoardTitleActive(boardId, nextTitle)
        if (titleInput) titleInput.value = next.title
        document.title = `${next.title} - St. Cecilia Technology`
        setHint(
          isSignedIn()
            ? 'Saved to your Google library.'
            : 'Saved on this device.',
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
        setShareHint('New code ready — old code no longer works.')
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

  shareCopy?.addEventListener('click', () => {
    const code = currentShare.code
    if (!code) return
    void (async () => {
      try {
        await navigator.clipboard.writeText(code)
        setShareHint('Code copied.')
      } catch {
        // Fallback: select the input so Chromebooks without clipboard grant still work.
        shareCodeInput?.select()
        setShareHint('Select the code and copy it (Ctrl+C / ⌘C).')
      }
    })()
  })

  forceFollowToggle?.addEventListener('change', () => {
    if (!boardId || !isHost || forceFollowBusy) {
      if (forceFollowToggle) forceFollowToggle.checked = forceFollowOn
      return
    }
    forceFollowBusy = true
    setForceFollowHint(null)
    const wantOn = forceFollowToggle.checked
    void (async () => {
      try {
        const result = await setForceFollow(boardId, wantOn)
        renderForceFollowUi(result.forceFollow)
      } catch (err) {
        renderForceFollowUi(forceFollowOn)
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
