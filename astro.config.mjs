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
      // tldraw + @tldraw/sync share singletons; keep one copy of each package.
      dedupe: [
        'react',
        'react-dom',
        'tldraw',
        '@tldraw/editor',
        '@tldraw/state',
        '@tldraw/state-react',
        '@tldraw/store',
        '@tldraw/sync',
        '@tldraw/sync-core',
        '@tldraw/tlschema',
        '@tldraw/utils',
        '@tldraw/validate',
      ],
    },
    optimizeDeps: {
      // Prebundle on cold start so Vite does not rediscover these mid-session,
      // reload the page, and re-register tldraw versions on a live globalThis
      // (which surfaces as the false "multiple instances" warning).
      include: [
        'tldraw',
        '@tldraw/sync',
        '@tldraw/sync-core',
        '@tldraw/editor',
        '@tldraw/state',
        '@tldraw/state-react',
        '@tldraw/store',
        '@tldraw/tlschema',
        '@tldraw/utils',
        '@tldraw/validate',
        'lucide',
      ],
    },
  },
});
