import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://scsfoxchase.tech',
  output: 'static',
  adapter: cloudflare(),
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
  redirects: {
    '/games.html': '/games',
    '/hub.html': '/',
    '/hub': '/',
    '/newhome': '/',
    '/offline.html': '/offline',
  },
});
