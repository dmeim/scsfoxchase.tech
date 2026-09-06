import type { Game } from './carousel';

export function initTrendingHero() {
  const payload = document.getElementById('ng-hero-data');
  const games: Game[] = payload?.textContent ? JSON.parse(payload.textContent) : [];
  const root = document.querySelector<HTMLElement>('[data-ng-hero]');
  if (!root || games.length === 0) return;
  const image = root.querySelector<HTMLImageElement>('[data-ng-hero-bg]');
  const title = root.querySelector('[data-ng-hero-title]');
  const description = root.querySelector('[data-ng-hero-desc]');
  const link = root.querySelector<HTMLAnchorElement>('[data-ng-hero-link]');
  const progress = root.querySelector<HTMLElement>('[data-ng-hero-progress]');
  const pause = root.querySelector<HTMLButtonElement>('[data-ng-hero-pause]');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motion.matches;
  let hovered = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const autoMs = 5000;
  progress?.style.setProperty('--ng-hero-autoplay', `${autoMs}ms`);
  if (games.length < 2) {
    if (progress) progress.hidden = true;
    if (pause) pause.hidden = true;
    root.querySelectorAll<HTMLButtonElement>('[data-ng-hero-prev], [data-ng-hero-next]').forEach(button => { button.hidden = true; });
  }
  const restart = () => {
    clearTimeout(timer);
    timer = undefined;
    const active = progress?.querySelector<HTMLElement>('.is-active .ng-hero-progress-fill');
    progress?.querySelectorAll('.ng-hero-progress-fill').forEach(fill => fill.classList.remove('is-animating'));
    if (pause) {
      pause.textContent = paused ? 'Resume' : 'Pause';
      pause.setAttribute('aria-label', `${paused ? 'Resume' : 'Pause'} trending rotation`);
      pause.setAttribute('aria-pressed', String(paused));
    }
    if (games.length < 2 || paused || hovered || root.contains(document.activeElement) || document.hidden) return;
    if (active) {
      void active.offsetWidth;
      active.classList.add('is-animating');
    }
    timer = setTimeout(() => go(index + 1), autoMs);
  };
  const go = (next: number) => {
    index = (next + games.length) % games.length;
    const game = games[index];
    if (image) {
      delete image.dataset.fallback;
      image.src = game.image;
    }
    if (title) title.textContent = game.name;
    if (description) description.textContent = game.description;
    if (link) {
      link.href = game.url;
      link.setAttribute('aria-label', `Play ${game.name}`);
    }
    progress?.querySelectorAll<HTMLButtonElement>('[data-ui-progress-tab]').forEach((tab, i) => {
      const active = i === index;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    restart();
  };
  // ProgressTabs emits this event for both pointer and keyboard selection.
  progress?.addEventListener('ui:change', event => {
    const id = (event as CustomEvent<{ value: string }>).detail.value;
    const next = games.findIndex(game => game.id === id);
    if (next >= 0) go(next);
  });
  root.querySelector('[data-ng-hero-prev]')?.addEventListener('click', () => go(index - 1));
  root.querySelector('[data-ng-hero-next]')?.addEventListener('click', () => go(index + 1));
  pause?.addEventListener('click', () => { paused = !paused; restart(); });
  root.addEventListener('pointerenter', () => { hovered = true; restart(); });
  root.addEventListener('pointerleave', () => { hovered = false; restart(); });
  root.addEventListener('focusin', restart);
  root.addEventListener('focusout', () => queueMicrotask(restart));
  document.addEventListener('visibilitychange', restart);
  motion.addEventListener('change', () => { paused = motion.matches; restart(); });
  go(0);
}
