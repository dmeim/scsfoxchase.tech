import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

// Originals are never written. Lossless encoding adds no compression artifacts.
// 960px thumbnails cover the largest catalog card at 2x density; full-size
// variants retain the original dimensions for the hero and detail dialog.
const output = 'public/images/optimized';
await mkdir(output, { recursive: true });
const games = await Promise.all((await readdir('src/content/games')).filter(p => p.endsWith('.json')).map(async p => JSON.parse(await readFile(`src/content/games/${p}`, 'utf8'))));
const iconsSource = await readFile('src/components/AppLauncher.astro', 'utf8');
const icons = new Set([...iconsSource.matchAll(/(?:src="|displayImage\(")(\/images\/[^" ]+\.(?:png|jpe?g))"/g)].map(m => m[1]));
icons.add('/images/scs-logo.png');
const manifest = {};
let originalBytes = 0, thumbnailBytes = 0;
for (const src of [...new Set([...games.map(g => g.image), ...icons])].sort()) {
  if (!/\.(png|jpe?g)$/i.test(src)) continue;
  const original = await readFile(`public${src}`);
  const meta = await sharp(original).metadata();
  const hash = createHash('sha256').update(original).update('lossless-v1').digest('hex').slice(0, 12);
  const stem = path.basename(src, path.extname(src));
  const generate = async (width, label) => {
    const dest = `${output}/${stem}-${hash}-${label}.webp`;
    try { await stat(dest); } catch {
      await sharp(original).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 6 }).toFile(dest);
    }
    return { src: dest.slice('public'.length), bytes: (await stat(dest)).size };
  };
  if (icons.has(src)) {
    const icon = await generate(src.includes('scs-logo.') ? 96 : 192, 'icon');
    manifest[src] = { src: icon.src };
  } else {
    const thumb = await generate(960, 'thumb');
    const full = meta.width <= 960 ? thumb : await generate(meta.width, 'full');
    // Some photographic JPEGs are already smaller than lossless WebP.
    manifest[src] = { src: full.bytes < original.length ? full.src : src, thumbnail: thumb.bytes < original.length ? thumb.src : src };
    originalBytes += original.length;
    thumbnailBytes += Math.min(thumb.bytes, original.length);
  }
}
const used = new Set(Object.values(manifest).flatMap(entry => Object.values(entry)));
for (const file of await readdir(output)) {
  if (!used.has(`/images/optimized/${file}`)) await unlink(`${output}/${file}`);
}
await writeFile('src/data/display-images.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Catalog image bytes: ${originalBytes} original → ${thumbnailBytes} thumbnails (${Math.round((1-thumbnailBytes/originalBytes)*100)}% smaller). All originals preserved.`);
