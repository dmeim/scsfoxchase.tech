import { execSync } from 'node:child_process';
import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

import react from '@astrojs/react';

function resolveBuildSha() {
  const fromEnv =
    process.env.CF_VERSION_METADATA_ID ||
    process.env.WORKERS_CI_COMMIT_SHA ||
    process.env.GITHUB_SHA;
  if (fromEnv) {
    return fromEnv.trim().slice(0, 12);
  }
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' })
      .trim()
      .slice(0, 12);
  } catch {
    return 'unknown';
  }
}

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
    define: {
      // Excalidraw checks process.env.IS_PREACT; Vite strips process by default.
      'process.env.IS_PREACT': JSON.stringify('false'),
      __BUILD_SHA__: JSON.stringify(resolveBuildSha()),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      holdUntilCrawlEnd: true,
      include: [
        '@excalidraw/excalidraw',
        'lucide',
        'astro/assets/services/noop',
      ],
    },
    ssr: {
      optimizeDeps: {
        include: ['astro/assets/services/noop'],
      },
    },
  },
});
