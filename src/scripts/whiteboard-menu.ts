function extractRoomId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Full or relative URL: /tldraw?room=… or /tldraw/r/{id}
  try {
    const url = new URL(trimmed, window.location.origin);
    const fromQuery = url.searchParams.get('room');
    if (fromQuery) {
      return sanitizeRoomId(fromQuery);
    }
    const match = url.pathname.match(/\/tldraw\/r\/([^/]+)\/?$/i);
    if (match?.[1]) {
      return sanitizeRoomId(decodeURIComponent(match[1]));
    }
  } catch {
    // Not a URL — treat as a bare code below
  }

  // Path-like paste without origin: /tldraw/r/abc
  const pathMatch = trimmed.match(/\/tldraw\/r\/([^/?#]+)\/?/i);
  if (pathMatch?.[1]) {
    return sanitizeRoomId(decodeURIComponent(pathMatch[1]));
  }

  return sanitizeRoomId(trimmed);
}

function sanitizeRoomId(value: string): string | null {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

function initWhiteboardMenu() {
  const root = document.querySelector<HTMLElement>('[data-whiteboard-menu]');
  if (!root) return;

  const toggle = root.querySelector<HTMLButtonElement>('[data-whiteboard-toggle]');
  const panel = root.querySelector<HTMLElement>('[data-whiteboard-panel]');
  const joinForm = root.querySelector<HTMLFormElement>('[data-whiteboard-join]');
  const joinInput = root.querySelector<HTMLInputElement>('[data-whiteboard-join-input]');
  const joinHint = root.querySelector<HTMLElement>('[data-whiteboard-join-hint]');

  if (!toggle || !panel) return;

  const setOpen = (open: boolean) => {
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      // Defer focus until after open transition starts
      window.requestAnimationFrame(() => joinInput?.focus());
    }
  };

  const close = () => setOpen(false);
  const toggleMenu = () => setOpen(!root.classList.contains('is-open'));

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu();
  });

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

  joinForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = extractRoomId(joinInput?.value ?? '');
    if (!roomId) {
      if (joinHint) {
        joinHint.hidden = false;
        joinHint.textContent = 'Enter a room code or board URL to join.';
      }
      joinInput?.focus();
      return;
    }

    if (joinHint) {
      joinHint.hidden = false;
      joinHint.textContent = 'Opening board… sync coming soon.';
    }

    window.location.href = `/tldraw?room=${encodeURIComponent(roomId)}`;
  });

  close();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWhiteboardMenu);
} else {
  initWhiteboardMenu();
}
