import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://scsfoxchase.tech',
  output: 'static',
  adapter: cloudflare(),
  trailingSlash: 'never',
  redirects: {
    '/games.html': '/games',
    '/newhome': '/',
    '/hub.html': '/',
    '/offline.html': '/offline',
  },
});
