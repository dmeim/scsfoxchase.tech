/** Inline SVG icons (currentColor) — replaces Font Awesome CDN. */

const svg = (path: string, viewBox = '0 0 24 24', extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em" aria-hidden="true" ${extra}>${path}</svg>`;

export const iconSun = (id = '') =>
  svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    '0 0 24 24',
    id ? `id="${id}"` : '',
  );

export const iconMoon = (id = '') =>
  svg(
    '<path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"/>',
    '0 0 24 24',
    id ? `id="${id}"` : '',
  );

export const iconExclamationCircle =
  svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>');

export const iconExclamationTriangle =
  svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>');
