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
        '@tldraw/driver',
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
      // Hold the first dep graph until the crawl finishes so Vite does not
      // rediscover deps mid-session, full-reload, and re-register tldraw on a
      // sticky globalThis (false "multiple instances" warning).
      holdUntilCrawlEnd: true,
      // Prebundle on cold start — include the Cloudflare passthrough image
      // service that was still being discovered after first paint.
      include: [
        'tldraw',
        '@tldraw/driver',
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
        'astro/assets/services/noop',
      ],
    },
    ssr: {
      optimizeDeps: {
        include: [
          'tldraw',
          '@tldraw/driver',
          '@tldraw/sync',
          '@tldraw/sync-core',
          '@tldraw/editor',
          '@tldraw/state',
          '@tldraw/state-react',
          '@tldraw/store',
          '@tldraw/tlschema',
          '@tldraw/utils',
          '@tldraw/validate',
          'astro/assets/services/noop',
        ],
      },
    },
  },
});
