/** Native image errors only: never preload offscreen catalog images. */
let bound = false;
export function initPlaceholderImages() {
  if (bound) return;
  bound = true;
  const fallback = (img: HTMLImageElement) => {
    if (!img.closest('.game-card-image, .game-detail-image-btn, .ng-hero, .carousel-slide')) return;
    if (img.dataset.fallback) return;
    img.dataset.fallback = 'true';
    img.removeAttribute('srcset');
    img.src = '/images/game-placeholder.svg';
  };
  document.addEventListener('error', (event) => {
    if (event.target instanceof HTMLImageElement) fallback(event.target);
  }, true);
  // Catch errors that occurred before this module initialized, without fetching.
  document.querySelectorAll<HTMLImageElement>('.game-card-image img, .ng-hero img').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) fallback(img);
  });
}
