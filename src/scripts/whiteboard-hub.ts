import {
  assetResolveUrl,
  listAssetsActive,
  removeAssetActive,
  setAssetTitleActive,
  type WhiteboardAssetEntry,
} from '../lib/whiteboard-assets';
import { lookupShareCode } from '../lib/whiteboard-codes';
import {
  isClerkConfigured,
  isSignedIn,
  onAuthChange,
  whenAuthReady,
} from '../lib/whiteboard-identity';
import {
  createBoardActive,
  formatAccessedDate,
  getDeviceInstallId,
  getRecentsActive,
  listBoardsActive,
  parseJoinInput,
  removeBoardActive,
  setBoardTitleActive,
  touchBoardActive,
  type WhiteboardLibraryEntry,
} from './whiteboard-library';

function cardHtml(entry: WhiteboardLibraryEntry): string {
  const title = escapeHtml(entry.title || 'Untitled board');
  const titleAttr = escapeAttr(entry.title || 'Untitled board');
  const date = escapeHtml(formatAccessedDate(entry.lastAccessedAt));
  const idAttr = escapeAttr(entry.id);
  const href = `/board/${encodeURIComponent(entry.id)}`;
  const preview = entry.previewDataUrl
    ? `<img src="${escapeAttr(entry.previewDataUrl)}" alt="" class="wb-card-preview-img" loading="lazy" />`
    : `<div class="wb-card-preview-placeholder" aria-hidden="true"></div>`;

  return `
    <article class="wb-card" data-wb-card data-wb-id="${idAttr}">
      <a class="wb-card-link" href="${href}">
        <div class="wb-card-preview">${preview}</div>
        <div class="wb-card-meta">
          <div class="wb-card-title" data-wb-card-title>${title}</div>
          <div class="wb-card-date">${date}</div>
        </div>
      </a>
      <div class="wb-card-menu" data-wb-card-menu>
        <button
          type="button"
          class="wb-card-menu-toggle"
          data-wb-card-menu-toggle
          aria-label="Board options"
          aria-expanded="false"
          aria-haspopup="true"
        >
          <span class="wb-card-menu-dots" aria-hidden="true"></span>
        </button>
        <div class="wb-card-menu-panel" data-wb-card-menu-panel hidden>
          <div class="wb-card-menu-actions" data-wb-card-menu-actions>
            <button type="button" class="wb-card-menu-item" data-wb-card-rename>
              Rename
            </button>
            <button type="button" class="wb-card-menu-item wb-card-menu-item--danger" data-wb-card-delete>
              Delete
            </button>
          </div>
          <form class="wb-card-rename" data-wb-card-rename-ui hidden>
            <input
              class="wb-card-rename-input"
              type="text"
              name="title"
              data-wb-card-rename-input
              value="${titleAttr}"
              maxlength="120"
              autocomplete="off"
              spellcheck="false"
              aria-label="Board name"
            />
            <button type="submit" class="wb-card-rename-save" data-wb-card-rename-save>
              Save
            </button>
          </form>
          <div class="wb-card-confirm" data-wb-card-delete-ui hidden>
            <p class="wb-card-confirm-text">Are you sure?</p>
            <div class="wb-card-confirm-actions">
              <button type="button" class="wb-card-confirm-yes" data-wb-card-delete-yes>Yes</button>
              <button type="button" class="wb-card-confirm-no" data-wb-card-delete-no>No</button>
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

function assetCardHtml(entry: WhiteboardAssetEntry): string {
  const title = escapeHtml(entry.title || 'Untitled asset');
  const titleAttr = escapeAttr(entry.title || 'Untitled asset');
  const date = escapeHtml(formatAccessedDate(entry.lastAccessedAt));
  const idAttr = escapeAttr(entry.id);
  const previewUrl = assetResolveUrl(entry.ownerKey, entry.id);
  const preview = isImageMime(entry.mimeType)
    ? `<img src="${escapeAttr(previewUrl)}" alt="" class="wb-card-preview-img" loading="lazy" />`
    : `<div class="wb-card-preview-placeholder wb-card-preview-placeholder--asset" aria-hidden="true">
         <span class="wb-asset-mime">${escapeHtml(entry.mimeType.split('/')[0] || 'file')}</span>
       </div>`;

  return `
    <article class="wb-card wb-card--asset" data-wb-asset-card data-wb-asset-id="${idAttr}">
      <div class="wb-card-link wb-card-link--static">
        <div class="wb-card-preview">${preview}</div>
        <div class="wb-card-meta">
          <div class="wb-card-title" data-wb-card-title>${title}</div>
          <div class="wb-card-date">${date}</div>
        </div>
      </div>
      <div class="wb-card-menu" data-wb-card-menu>
        <button
          type="button"
          class="wb-card-menu-toggle"
          data-wb-card-menu-toggle
          aria-label="Asset options"
          aria-expanded="false"
          aria-haspopup="true"
        >
          <span class="wb-card-menu-dots" aria-hidden="true"></span>
        </button>
        <div class="wb-card-menu-panel" data-wb-card-menu-panel hidden>
          <div class="wb-card-menu-actions" data-wb-card-menu-actions>
            <button type="button" class="wb-card-menu-item" data-wb-card-rename>
              Rename
            </button>
            <button type="button" class="wb-card-menu-item wb-card-menu-item--danger" data-wb-card-delete>
              Delete
            </button>
          </div>
          <form class="wb-card-rename" data-wb-card-rename-ui hidden>
            <input
              class="wb-card-rename-input"
              type="text"
              name="title"
              data-wb-card-rename-input
              value="${titleAttr}"
              maxlength="120"
              autocomplete="off"
              spellcheck="false"
              aria-label="Asset name"
            />
            <button type="submit" class="wb-card-rename-save" data-wb-card-rename-save>
              Save
            </button>
          </form>
          <div class="wb-card-confirm" data-wb-card-delete-ui hidden>
            <p class="wb-card-confirm-text">Are you sure?</p>
            <div class="wb-card-confirm-actions">
              <button type="button" class="wb-card-confirm-yes" data-wb-card-delete-yes>Yes</button>
              <button type="button" class="wb-card-confirm-no" data-wb-card-delete-no>No</button>
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function renderSection(
  grid: HTMLElement | null,
  empty: HTMLElement | null,
  entries: WhiteboardLibraryEntry[],
) {
  if (!grid || !empty) return;
  if (entries.length === 0) {
    grid.innerHTML = '';
    grid.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.hidden = false;
  grid.innerHTML = entries.map(cardHtml).join('');
}

async function renderAssets() {
  const row = document.querySelector<HTMLElement>('[data-wb-assets-row]');
  const empty = document.querySelector<HTMLElement>('[data-wb-assets-empty]');
  if (!row || !empty) return;
  let entries: WhiteboardAssetEntry[] = [];
  try {
    entries = await listAssetsActive();
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    row.innerHTML = '';
    row.hidden = true;
    empty.hidden = false;
    empty.textContent = isSignedIn()
      ? 'Images and videos you place on a board while signed in show up here.'
      : 'Images and videos you place on a board show up here automatically.';
    return;
  }
  empty.hidden = true;
  row.hidden = false;
  row.innerHTML = entries.map(assetCardHtml).join('');
}

async function renderLibrary() {
  let recents: WhiteboardLibraryEntry[] = [];
  let library: WhiteboardLibraryEntry[] = [];
  try {
    recents = await getRecentsActive(8);
    library = await listBoardsActive();
  } catch {
    recents = [];
    library = [];
  }

  const recentsEmpty = document.querySelector<HTMLElement>('[data-wb-recents-empty]');
  const libraryEmpty = document.querySelector<HTMLElement>('[data-wb-library-empty]');
  if (recentsEmpty) {
    recentsEmpty.textContent = isSignedIn()
      ? 'No recent boards in your Google library yet. Create one to get started.'
      : 'No recent boards on this device yet. Create one to get started.';
  }
  if (libraryEmpty) {
    libraryEmpty.textContent = isSignedIn()
      ? 'Boards you open while signed in are saved to your Google library.'
      : 'Boards you open are saved in this browser’s library.';
  }

  renderSection(
    document.querySelector('[data-wb-recents-grid]'),
    recentsEmpty,
    recents,
  );
  await renderAssets();
  renderSection(
    document.querySelector('[data-wb-library-grid]'),
    libraryEmpty,
    library,
  );

  const note = document.querySelector<HTMLElement>('[data-wb-hub-note]');
  if (note) {
    note.textContent = isSignedIn()
      ? 'Signed in: Recents, Library, and Assets are tied to your Google account. Sign out to return to this device’s local lists (they are kept separately).'
      : 'Library, recents, and assets stay on this device while signed out. Sign in with Google to use your cloud library on any Chromebook. Pasted media is stored so classmates on the same board can see it.';
  }
}

type CardKind = 'board' | 'asset';

function getCardKind(card: HTMLElement): CardKind {
  return card.hasAttribute('data-wb-asset-card') ? 'asset' : 'board';
}

function closeCardMenus(except?: HTMLElement | null) {
  document
    .querySelectorAll<HTMLElement>('[data-wb-card], [data-wb-asset-card]')
    .forEach((card) => {
      if (except && card === except) return;
      const menu = card.querySelector<HTMLElement>('[data-wb-card-menu]');
      const toggle = card.querySelector<HTMLButtonElement>('[data-wb-card-menu-toggle]');
      const panel = card.querySelector<HTMLElement>('[data-wb-card-menu-panel]');
      const actions = card.querySelector<HTMLElement>('[data-wb-card-menu-actions]');
      const renameUi = card.querySelector<HTMLElement>('[data-wb-card-rename-ui]');
      const deleteUi = card.querySelector<HTMLElement>('[data-wb-card-delete-ui]');
      menu?.classList.remove('is-open');
      toggle?.setAttribute('aria-expanded', 'false');
      if (panel) panel.hidden = true;
      if (actions) actions.hidden = false;
      if (renameUi) renameUi.hidden = true;
      if (deleteUi) deleteUi.hidden = true;
    });
}

function openCardMenu(card: HTMLElement) {
  closeCardMenus(card);
  const menu = card.querySelector<HTMLElement>('[data-wb-card-menu]');
  const toggle = card.querySelector<HTMLButtonElement>('[data-wb-card-menu-toggle]');
  const panel = card.querySelector<HTMLElement>('[data-wb-card-menu-panel]');
  const actions = card.querySelector<HTMLElement>('[data-wb-card-menu-actions]');
  const renameUi = card.querySelector<HTMLElement>('[data-wb-card-rename-ui]');
  const deleteUi = card.querySelector<HTMLElement>('[data-wb-card-delete-ui]');
  menu?.classList.add('is-open');
  toggle?.setAttribute('aria-expanded', 'true');
  if (panel) panel.hidden = false;
  if (actions) actions.hidden = false;
  if (renameUi) renameUi.hidden = true;
  if (deleteUi) deleteUi.hidden = true;
}

function showRenameUi(card: HTMLElement) {
  const actions = card.querySelector<HTMLElement>('[data-wb-card-menu-actions]');
  const renameUi = card.querySelector<HTMLElement>('[data-wb-card-rename-ui]');
  const deleteUi = card.querySelector<HTMLElement>('[data-wb-card-delete-ui]');
  const input = card.querySelector<HTMLInputElement>('[data-wb-card-rename-input]');
  const titleEl = card.querySelector<HTMLElement>('[data-wb-card-title]');
  if (actions) actions.hidden = true;
  if (deleteUi) deleteUi.hidden = true;
  if (renameUi) renameUi.hidden = false;
  if (input) {
    input.setCustomValidity('');
    input.value = titleEl?.textContent?.trim() || input.value;
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

function showDeleteConfirm(card: HTMLElement) {
  const actions = card.querySelector<HTMLElement>('[data-wb-card-menu-actions]');
  const renameUi = card.querySelector<HTMLElement>('[data-wb-card-rename-ui]');
  const deleteUi = card.querySelector<HTMLElement>('[data-wb-card-delete-ui]');
  if (actions) actions.hidden = true;
  if (renameUi) renameUi.hidden = true;
  if (deleteUi) deleteUi.hidden = false;
}

function bindCardMenus(root: Element) {
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const card = target.closest<HTMLElement>('[data-wb-card], [data-wb-asset-card]');
    const menu = target.closest<HTMLElement>('[data-wb-card-menu]');

    if (menu) {
      // stopPropagation keeps the document "click outside" closer from firing.
      // Do NOT preventDefault on the rename form — that cancels submit-button
      // activation and makes Save a no-op.
      if (!target.closest('[data-wb-card-rename-ui]')) {
        event.preventDefault();
      }
      event.stopPropagation();
    }

    if (!card) return;

    const kind = getCardKind(card);
    const id =
      kind === 'asset'
        ? card.getAttribute('data-wb-asset-id')
        : card.getAttribute('data-wb-id');
    if (!id) return;

    if (target.closest('[data-wb-card-menu-toggle]')) {
      const isOpen = card.querySelector('[data-wb-card-menu]')?.classList.contains('is-open');
      if (isOpen) closeCardMenus();
      else openCardMenu(card);
      return;
    }

    if (target.closest('[data-wb-card-rename]')) {
      openCardMenu(card);
      showRenameUi(card);
      return;
    }

    if (target.closest('[data-wb-card-delete]')) {
      openCardMenu(card);
      showDeleteConfirm(card);
      return;
    }

    if (target.closest('[data-wb-card-delete-no]')) {
      openCardMenu(card);
      return;
    }

    if (target.closest('[data-wb-card-delete-yes]')) {
      if (kind === 'asset') {
        void removeAssetActive(id).then(() => {
          closeCardMenus();
          void renderLibrary();
        });
      } else {
        void removeBoardActive(id).then(() => {
          closeCardMenus();
          void renderLibrary();
        });
      }
      return;
    }
  });

  root.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-wb-card-rename-ui]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const card = form.closest<HTMLElement>('[data-wb-card], [data-wb-asset-card]');
    if (!card) return;

    const kind = getCardKind(card);
    const id =
      kind === 'asset'
        ? card.getAttribute('data-wb-asset-id')
        : card.getAttribute('data-wb-id');
    if (!id) return;

    const input = form.querySelector<HTMLInputElement>('[data-wb-card-rename-input]');
    const nextTitle = (input?.value ?? '').trim();
    if (!nextTitle) {
      if (input) {
        input.setCustomValidity(
          kind === 'asset' ? 'Enter an asset name' : 'Enter a board name',
        );
        input.reportValidity();
        input.focus();
      }
      return;
    }
    input?.setCustomValidity('');

    // Gate on auth-ready so a pre-AuthBridge rename does not write localStorage.
    void (async () => {
      await whenAuthReady();
      if (kind === 'asset') {
        await setAssetTitleActive(id, nextTitle);
      } else {
        await setBoardTitleActive(id, nextTitle);
      }
      closeCardMenus();
      void renderLibrary();
    })();
  });
}

let cardMenusBound = false;

function bindCardMenusOnce(root: Element) {
  if (cardMenusBound) return;
  cardMenusBound = true;
  bindCardMenus(root);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-wb-card-menu]')) return;
    closeCardMenus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCardMenus();
  });
}

function initWhiteboardHub() {
  const root = document.querySelector('[data-wb-hub]');
  if (!root) return;

  // Mint device install id on first hub visit (signed-out owner key).
  getDeviceInstallId();

  const createBtn = root.querySelector<HTMLButtonElement>('[data-wb-create]');
  const joinForm = root.querySelector<HTMLFormElement>('[data-wb-join]');
  const joinInput = root.querySelector<HTMLInputElement>('[data-wb-join-input]');
  const joinHint = root.querySelector<HTMLElement>('[data-wb-join-hint]');

  const showActionHint = (message: string) => {
    if (!joinHint) return;
    joinHint.hidden = false;
    joinHint.textContent = message;
  };

  const showAuthPendingUi = () => {
    for (const sel of [
      '[data-wb-recents-empty]',
      '[data-wb-assets-empty]',
      '[data-wb-library-empty]',
    ] as const) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) continue;
      el.hidden = false;
      el.textContent = 'Loading…';
    }
    for (const sel of [
      '[data-wb-recents-grid]',
      '[data-wb-assets-row]',
      '[data-wb-library-grid]',
    ] as const) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) continue;
      el.innerHTML = '';
      el.hidden = true;
    }
  };

  createBtn?.addEventListener('click', () => {
    if (createBtn.disabled) return;
    createBtn.disabled = true;
    void (async () => {
      try {
        await whenAuthReady();
        const { id } = await createBoardActive();
        window.location.href = `/board/${encodeURIComponent(id)}`;
      } catch (err) {
        createBtn.disabled = false;
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Could not create board. Check your connection and try again.';
        showActionHint(message);
      }
    })();
  });

  joinForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = parseJoinInput(joinInput?.value ?? '');

    if (!parsed) {
      showActionHint(
        'Enter a share code (like A1B2), paste a board link (/board/…), or a UUID.',
      );
      joinInput?.focus();
      return;
    }

    void (async () => {
      try {
        await whenAuthReady();
        let boardId: string;
        if (parsed.kind === 'code') {
          showActionHint('Looking up code…');
          boardId = await lookupShareCode(parsed.code);
        } else {
          boardId = parsed.id;
        }
        try {
          await touchBoardActive(boardId);
        } catch {
          // Cloud upsert can fail offline; still open the board.
        }
        showActionHint('Opening board…');
        window.location.href = `/board/${encodeURIComponent(boardId)}`;
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Could not open board. Check your connection and try again.';
        showActionHint(message);
      }
    })();
  });

  // Wait for Clerk to settle so signed-in users don't briefly see local lists
  // or create under local:{deviceInstallId}.
  if (isClerkConfigured()) {
    showAuthPendingUi();
  }
  void whenAuthReady().then(() => {
    void renderLibrary();
  });
  bindCardMenusOnce(root);
  onAuthChange(() => {
    void renderLibrary();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWhiteboardHub);
} else {
  initWhiteboardHub();
}
