import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://scsfoxchase.tech',
  output: 'static',
  adapter: cloudflare({
    // Static site: no Cloudflare Images binding needed (avoids IMAGES warning).
    imageService: 'passthrough',
    // Honor public/_headers + public/_redirects in `astro dev` (fixes /newhome/ etc.).
    experimental: {
      headersAndRedirectsDevModeSupport: true,
    },
  }),
  // Avoid auto SESSION KV binding — this app does not use Astro sessions.
  session: {
    driver: sessionDrivers.lruCache(),
  },
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
  redirects: {
    '/games.html': '/games',
    '/newgames': '/games',
    '/hub.html': '/',
    '/hub': '/',
    '/newhome': '/',
    '/offline.html': '/offline',
  },
});
