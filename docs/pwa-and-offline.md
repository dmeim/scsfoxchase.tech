# PWA and offline

How the Progressive Web App registers, caches, and behaves when the network is unavailable. Implementation sources: `public/sw.js`, `public/manifest.json`, `src/layouts/BaseLayout.astro`, `src/pages/offline.astro`.

Related: [UI and design](ui-and-design.md), [architecture](architecture.md), [whiteboard overview](whiteboard/README.md), [docs index](README.md).

## Installability

### Manifest

`public/manifest.json`, linked from `BaseLayout.astro` as `<link rel="manifest" href="/manifest.json" />`.

| Field | Value |
|-------|--------|
| `name` | St. Cecilia Technology |
| `short_name` | St. Cecilia Tech |
| `description` | Educational games for grade-school students |
| `start_url` | `/` |
| `display` | `standalone` |
| `background_color` / `theme_color` | `#125F31` |
| `orientation` | `any` |
| `lang` / `dir` | `en-US` / `ltr` |
| `categories` | education, games, kids |
| Icons | `/images/icon-192.png`, `/images/icon-512.png` (`192x192`, `512x512`, `purpose`: `any maskable`) |

`BaseLayout` also sets `<meta name="theme-color" content="#125F31" />`, favicons, and `apple-touch-icon`.

### Service worker registration

On every page using `BaseLayout`, after `window` `load`:

```js
navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
```

Registration runs only when `'serviceWorker' in navigator`. `updateViaCache: 'none'` avoids caching the worker script itself through HTTP cache in a way that stalls updates.

## Caching strategy (`public/sw.js`)

Cache name: `st-cecilia-tech-astro-v17`.

### Install / activate

- **Install** — opens the cache, `fetch`es `/offline` with `redirect: 'follow'`, `cache.put`s it under `/offline`, then `skipWaiting()`.
- **Activate** — deletes every cache whose name is not the current `CACHE_NAME`, then `clients.claim()`.

Only `/offline` is precached. Other entries appear later when successful same-origin GETs are stored (see below).

### Fetch rules

Applies to **GET** requests on the **same origin** only. Other methods and cross-origin requests are left alone.

1. **`/api/*` is never intercepted**

   ```js
   if (url.pathname.startsWith('/api/')) return;
   ```

   Worker APIs and WebSocket upgrades (whiteboard sync, assets, library, share codes, participants) bypass the service worker entirely. The SW does not cache or rewrite them.

2. **Navigations (`request.mode === 'navigate'`)** — network-first; on network failure, serve the precached offline page:

   ```js
   fetch(event.request).catch(() => caches.match(OFFLINE_PAGE))
   ```

   Successful HTML is **not** written into the cache. Navigations never reuse a stale document; the offline fallback is always `/offline`.

3. **Other same-origin GETs** (including hashed `/_astro/*` assets, images, scripts) — network-first with cache fallback:

   - On `200`, clone and `cache.put` the response.
   - On network failure, `caches.match(event.request)`.

   Comment in `sw.js`: cache-first on `/_astro` was removed because poisoned immutable 404s broke CSS.

## Canonical offline page

Route: **`/offline`** (`src/pages/offline.astro`, `prerender = true`).

- Title: “You're Offline” with an inline Lucide `wifi-off` icon (`iconWifiOff` in `src/scripts/icons.ts`).
- Copy explains the connection is down and that most features may be limited or turned off.
- A self-contained canvas runner (Chrome-dino style) sits under the message; script/styles are `is:inline` so they ship inside the precached HTML.
- **Try Again** reloads the page; an `online` listener also reloads when connectivity returns.

Cached static assets from earlier visits can still satisfy non-navigation requests if the browser loads a page that references them; HTML routes themselves are not served from a page cache.

Styling uses brand tokens (`--primary-color`, `--text-color`, `--light-bg` / `--dark-bg`, `--border-color`) and `border-radius: 2px` on the runner canvas — see [UI and design](ui-and-design.md).

## Offline and the whiteboard

Evidence from client/worker paths (no SW involvement for `/api/*`):

| Concern | Offline behavior (from code) |
|---------|------------------------------|
| **Live sync** | `TldrawBoard` uses `@tldraw/sync` `useSync` with URI `/api/whiteboard/connect/{boardId}`. That path is under `/api/`, so the SW never handles it. Sync needs a live network connection to the Worker / Durable Object. |
| **Share codes** | Join/lookup uses `fetch` to `/api/whiteboard/join/...` and board code routes (`whiteboard-codes.ts`). Requires network. |
| **Cloud library / assets index** | Signed-in library APIs hit `/api/whiteboard/library/*` (`whiteboard-cloud.ts`) and need Clerk + network. |
| **R2 media** | Asset store resolves URLs under `/api/whiteboard/assets/...` and `fetch`es them (`whiteboard-assets.ts`). Upload/download needs network; SW does not cache these. |
| **Signed-out local indexes** | Device install id, local board library, and local assets index use `localStorage` (`whiteboard-library.ts`, `whiteboard-assets.ts`). Those reads/writes do not require the network. |
| **Cloud upserts while opening a board** | Hub and board code call cloud “touch” / upsert helpers and **catch** failures with comments that cloud upsert can fail offline; when signed out, local create/open paths still proceed, and the hub still navigates to `/board/{uuid}` after a failed touch. Opening the board route itself is still a **navigation**; if the network is down, the SW serves `/offline` instead of the board HTML. |

**Summary:** localStorage-backed hub metadata for signed-out users can be read and updated without the network. Anything that depends on `/api/whiteboard/*` (sync WebSocket, share codes, cloud library, R2 assets) requires connectivity and is outside the service worker’s caching model. Navigating to hub or board pages while offline yields the `/offline` page, not a cached board UI.
