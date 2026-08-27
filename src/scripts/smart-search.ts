function initSmartSearch() {
  document.querySelectorAll<HTMLFormElement>('[data-smart-search]').forEach((form) => {
    const toggle = form.querySelector<HTMLButtonElement>('.smart-search-toggle');
    const menu = form.querySelector<HTMLElement>('.smart-search-menu');
    const label = form.querySelector<HTMLElement>('.smart-search-label');
    const icon = form.querySelector<HTMLImageElement>('.smart-search-icon');
    const input = form.querySelector<HTMLInputElement>('.smart-search-input');
    const clear = form.querySelector<HTMLButtonElement>('[data-smart-search-clear]');
    const options = Array.from(form.querySelectorAll<HTMLButtonElement>('.smart-search-option'));
    if (!toggle || !menu || !label || !icon || !input) return;

    let currentUrl =
      form.querySelector<HTMLButtonElement>('.smart-search-option.active')?.dataset.url || '';

    const closeMenu = () => {
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    };

    const positionMenu = () => {
      const rect = toggle.getBoundingClientRect();
      const menuWidth = Math.min(720, window.innerWidth - 32);
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 16));
      menu.style.top = `${rect.bottom + 10}px`;
      menu.style.left = `${left}px`;
    };

    const setMenuOpen = (open: boolean, focusFirst = false) => {
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (!open) return;
      positionMenu();
      if (focusFirst) options[0]?.focus();
    };

    toggle.addEventListener('click', () => setMenuOpen(!menu.classList.contains('open')));

    toggle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      setMenuOpen(true, true);
    });

    window.addEventListener('resize', () => {
      if (menu.classList.contains('open')) positionMenu();
    });

    window.addEventListener(
      'scroll',
      () => {
        if (menu.classList.contains('open')) positionMenu();
      },
      true,
    );

    menu.addEventListener('keydown', (event) => {
      const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        toggle.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : Math.max(0, Math.min(options.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      options[nextIndex]?.focus();
    });

    options.forEach((option) => {
      option.addEventListener('click', () => {
        options.forEach((item) => {
          item.classList.remove('active');
          item.setAttribute('aria-selected', 'false');
        });
        option.classList.add('active');
        option.setAttribute('aria-selected', 'true');
        currentUrl = option.dataset.url || '';
        label.textContent = option.dataset.label || '';
        icon.src = option.dataset.icon || '';
        input.placeholder = option.dataset.placeholder || '';
        closeMenu();
        input.focus();
      });
    });

    clear?.addEventListener('click', () => {
      input.value = '';
      input.focus();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query || !currentUrl) {
        input.focus();
        return;
      }
      window.open(
        currentUrl.replace('{query}', encodeURIComponent(query)),
        '_blank',
        'noopener,noreferrer',
      );
    });

    document.addEventListener('click', (event) => {
      if (!form.contains(event.target as Node)) closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('open')) closeMenu();
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSmartSearch);
} else {
  initSmartSearch();
}
