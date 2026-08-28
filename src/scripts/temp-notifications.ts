function initTempNotifications() {
  const center = document.querySelector<HTMLElement>('[data-temp-notification-center]');
  if (!center || center.dataset.bound === 'true') return;
  center.dataset.bound = 'true';

  const trigger = center.querySelector<HTMLButtonElement>('[data-temp-notification-trigger]');
  const panel = center.querySelector<HTMLElement>('[data-temp-notification-panel]');
  const badge = center.querySelector<HTMLElement>('[data-temp-notification-badge]');
  const list = center.querySelector<HTMLElement>('[data-temp-notification-list]');
  const empty = center.querySelector<HTMLElement>('[data-temp-notification-empty]');
  const clearButton = center.querySelector<HTMLButtonElement>('[data-temp-notification-clear]');

  const visibleItems = () =>
    Array.from(center.querySelectorAll<HTMLElement>('[data-temp-notification-item]')).filter(
      (item) => !item.hidden,
    );

  const updateCount = () => {
    const count = visibleItems().length;
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    if (trigger) {
      trigger.setAttribute(
        'aria-label',
        count === 0 ? 'Open notifications' : `Open notifications, ${count} unread`,
      );
    }
    if (list) list.hidden = count === 0;
    if (empty) empty.hidden = count !== 0;
    if (clearButton) clearButton.disabled = count === 0;
  };

  const setOpen = (open: boolean) => {
    if (!panel || !trigger) return;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    center.classList.toggle('is-open', open);
  };

  trigger?.addEventListener('click', () => {
    setOpen(panel?.hidden ?? true);
  });

  center.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const dismiss = target.closest('[data-temp-notification-dismiss]');
    if (dismiss) {
      const item = dismiss.closest<HTMLElement>('[data-temp-notification-item]');
      if (item) item.hidden = true;
      updateCount();
      return;
    }

    if (target.closest('[data-temp-notification-clear]')) {
      visibleItems().forEach((item) => {
        item.hidden = true;
      });
      updateCount();
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Node && !center.contains(target)) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel?.hidden) return;
    setOpen(false);
    trigger?.focus();
  });

  document.querySelector('[data-temp-toast-stack]')?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const close = target.closest('[data-temp-toast-close]');
    close?.closest('[data-temp-toast]')?.remove();
  });

  updateCount();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTempNotifications, { once: true });
} else {
  initTempNotifications();
}
