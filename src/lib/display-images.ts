import images from '../data/display-images.json';
const variants: Record<string, { src: string; thumbnail?: string }> = images;
export function displayImage(src: string): string {
  return variants[src]?.src ?? src;
}
export function gameDisplayImages<T extends { image: string }>(game: T) {
  return { ...game, image: displayImage(game.image), thumbnail: variants[game.image]?.thumbnail ?? game.image };
}
