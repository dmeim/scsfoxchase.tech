/**
 * Inline SVG icon strings (currentColor).
 * Theme toggle uses the `lucide` package directly (Sun / Moon).
 * Other UI icons remain as lightweight SVG strings for Astro `set:html`.
 */

const svg = (path: string, viewBox = '0 0 24 24', extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em" aria-hidden="true" ${extra}>${path}</svg>`;

export const iconExclamationCircle =
  svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>');

export const iconExclamationTriangle =
  svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>');

export const iconSearch =
  svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>');

export const iconQrCode =
  svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M17 17h3v3"/>');

export const iconPrint =
  svg('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>');

export const iconTimes =
  svg('<path d="M18 6 6 18M6 6l12 12"/>');
