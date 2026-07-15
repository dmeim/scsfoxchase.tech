/**
 * Placeholder images for broken game thumbnails — ported from js/placeholder-images.js.
 * Image fallbacks only (PWA icon generation dropped; real icons live in public/).
 */

function getColorForGameId(gameId: string): string {
  let hash = 0;
  for (let i = 0; i < gameId.length; i++) {
    hash = gameId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function getGameIdFromImagePath(path: string): string | null {
  const filename = path.split('/').pop();
  if (!filename) return null;
  const gameId = filename.split('.')[0];
  return gameId || null;
}

function handleImageError(event: Event) {
  const img = event.target as HTMLImageElement;
  const gameId = getGameIdFromImagePath(img.src);
  if (!gameId) return;

  const color = getColorForGameId(gameId);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = img.width || 300;
  canvas.height = img.height || 200;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 24px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const gameName = gameId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  ctx.fillText(gameName, canvas.width / 2, canvas.height / 2);
  img.src = canvas.toDataURL('image/png');
}

function applyBackgroundPlaceholder(element: HTMLElement, url: string) {
  const gameId = getGameIdFromImagePath(url);
  if (!gameId) return;

  const color = getColorForGameId(gameId);
  element.style.backgroundColor = color;
  element.style.backgroundImage = 'none';

  const gameName = gameId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  if (!element.querySelector('.placeholder-text')) {
    const textElement = document.createElement('div');
    textElement.classList.add('placeholder-text');
    textElement.textContent = gameName;
    textElement.style.color = 'white';
    textElement.style.fontWeight = 'bold';
    textElement.style.fontSize = '24px';
    textElement.style.display = 'flex';
    textElement.style.alignItems = 'center';
    textElement.style.justifyContent = 'center';
    textElement.style.height = '100%';
    textElement.style.padding = '20px';
    textElement.style.textAlign = 'center';
    element.appendChild(textElement);
  }
}

export function initPlaceholderImages() {
  document.querySelectorAll<HTMLImageElement>('img[src*="/images/"]').forEach((img) => {
    img.addEventListener('error', handleImageError);
  });

  document
    .querySelectorAll<HTMLElement>('.carousel-slide-bg, .carousel-slide-image, .game-card-image')
    .forEach((element) => {
      const style = element.style.backgroundImage;
      if (!style || !style.includes('/images/')) return;

      const url = style.replace(/^url\(['"]?(.+?)['"]?\)$/, '$1');
      const testImg = new Image();
      testImg.onload = () => {};
      testImg.onerror = () => applyBackgroundPlaceholder(element, url);
      testImg.src = url;
    });
}
