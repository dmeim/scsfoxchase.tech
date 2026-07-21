import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

import react from '@astrojs/react';

export default defineConfig({
  site: 'https://scsfoxchase.tech',
  // Server output so the custom Worker entry (Durable Objects + /api) is bundled.
  // All pages set `export const prerender = true` — still shipped as static HTML.
  output: 'server',

  adapter: cloudflare({
    // Static pages: no Cloudflare Images binding needed (avoids IMAGES warning).
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

  integrations: [react()],

  vite: {
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
  },
});
