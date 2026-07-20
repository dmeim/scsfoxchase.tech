import { isSignedIn, onAuthChange, whenAuthReady } from '../lib/whiteboard-identity';
import {
  getEntryActive,
  readBoardIdFromPath,
  setBoardTitleActive,
} from './whiteboard-library';

function initWhiteboardMenu() {
  const root = document.querySelector<HTMLElement>('[data-whiteboard-menu]');
  if (!root) return;

  const mode = root.getAttribute('data-whiteboard-mode');
  if (mode !== 'manage') return;

  const toggle = root.querySelector<HTMLButtonElement>('[data-whiteboard-toggle]');
  const panel = root.querySelector<HTMLElement>('[data-whiteboard-panel]');
  const nameForm = root.querySelector<HTMLFormElement>('[data-wb-manage-name]');
  const titleInput = root.querySelector<HTMLInputElement>('[data-wb-manage-title]');
  const hint = root.querySelector<HTMLElement>('[data-wb-manage-hint]');

  if (!toggle || !panel) return;

  const boardId = readBoardIdFromPath();

  const syncTitleFromLibrary = () => {
    if (!boardId || !titleInput) return;
    // Wait for Clerk so signed-in users read cloud library, not localStorage.
    void whenAuthReady().then(() => getEntryActive(boardId)).then((entry) => {
      if (entry && titleInput) {
        titleInput.value = entry.title;
        document.title = `${entry.title} - St. Cecilia Technology`;
      }
    });
  };

  syncTitleFromLibrary();
  onAuthChange(() => {
    syncTitleFromLibrary();
  });

  const setHint = (message: string | null) => {
    if (!hint) return;
    if (!message) {
      hint.hidden = true;
      hint.textContent = '';
      return;
    }
    hint.hidden = false;
    hint.textContent = message;
  };

  const setOpen = (open: boolean) => {
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      syncTitleFromLibrary();
      setHint(null);
      titleInput?.setCustomValidity('');
      window.requestAnimationFrame(() => {
        titleInput?.focus();
        titleInput?.select();
      });
    }
  };

  const close = () => setOpen(false);
  const toggleMenu = () => setOpen(!root.classList.contains('is-open'));

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu();
  });

  // Keep outside-click closer from seeing panel clicks. Do not preventDefault —
  // that would cancel Save / form submit button activation.
  panel.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  document.addEventListener('click', (event) => {
    if (!root.classList.contains('is-open')) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('is-open')) {
      close();
      toggle.focus();
    }
  });

  titleInput?.addEventListener('input', () => {
    titleInput.setCustomValidity('');
    setHint(null);
  });

  nameForm?.addEventListener('submit', (event) => {
    event.preventDefault();

    if (!boardId) {
      setHint('Open a board from the library to rename it.');
      return;
    }

    const nextTitle = (titleInput?.value ?? '').trim();
    if (!nextTitle) {
      if (titleInput) {
        titleInput.setCustomValidity('Enter a board name');
        titleInput.reportValidity();
        titleInput.focus();
      }
      setHint('Enter a name before saving.');
      return;
    }

    titleInput?.setCustomValidity('');
    // Gate on auth-ready so a pre-AuthBridge Save does not write localStorage.
    void (async () => {
      try {
        await whenAuthReady();
        const next = await setBoardTitleActive(boardId, nextTitle);
        if (titleInput) titleInput.value = next.title;
        document.title = `${next.title} - St. Cecilia Technology`;
        setHint(
          isSignedIn()
            ? 'Saved to your Google library.'
            : 'Saved on this device.',
        );
      } catch {
        setHint('Could not save the name. Check your connection and try again.');
      }
    })();
  });

  close();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWhiteboardMenu);
} else {
  initWhiteboardMenu();
}
