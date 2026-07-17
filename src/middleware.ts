import { defineMiddleware } from 'astro:middleware';

/**
 * In `astro dev`, rewrite /board/{uuid} → /board so the static board shell
 * loads while the browser URL (and client JS) keep the UUID.
 * Production uses public/_redirects for the same rewrite on Workers Assets.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const match = context.url.pathname.match(/^\/board\/([^/]+)\/?$/i);
  if (match?.[1] && match[1].toLowerCase() !== 'index') {
    return context.rewrite(new URL('/board', context.url));
  }
  return next();
});
