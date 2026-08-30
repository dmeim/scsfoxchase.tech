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

### Service worker registration and updates

On every page using `BaseLayout`, `src/scripts/service-worker-updates.ts` registers after `window` `load`:

```js
navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
```

Registration runs only when `'serviceWorker' in navigator`. `updateViaCache: 'none'` avoids caching the worker script itself through HTTP cache in a way that stalls updates.

When a new worker reaches `installed`, the production toast system shows a persistent **Update ready** notice with a **Reload** action. Reload sends `SKIP_WAITING` to the waiting worker; the resulting `controllerchange` reloads the page once so the new HTML and hashed assets arrive together. The worker is not forced active before the user accepts the update.

## Caching strategy (`public/sw.js`)

Cache name: `st-cecilia-tech-astro-{buildSha}`.

`npm run build` runs `scripts/stamp-service-worker.mjs` after Astro finishes. It replaces the placeholder in the emitted `dist/client/sw.js` with the same build SHA used by `/api/whiteboard/version`. A missing or duplicate placeholder fails the build instead of silently reusing an old cache name.

### Install / activate

- **Install** — opens the build-specific cache, `fetch`es `/offline` with `redirect: 'follow'`, and `cache.put`s it under `/offline`. Updates remain waiting until the reload toast is accepted or all older clients close.
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
| **Live sync** | `WhiteboardCanvas` opens a native WebSocket to `/api/whiteboard/connect/{boardId}`. That path is under `/api/`, so the SW never handles it. Sync needs a live network connection to the Worker / Durable Object. |
| **Share codes** | Join/lookup uses `fetch` to `/api/whiteboard/join/...` and board code routes (`whiteboard-codes.ts`). Requires network. |
| **Cloud library / assets index** | Signed-in library APIs hit `/api/whiteboard/library/*` (`whiteboard-cloud.ts`) and need Clerk + network. Recents/Library/Assets are not stored in localStorage. |
| **R2 media** | Canvas files resolve URLs under `/api/whiteboard/assets/...` (`whiteboard-excalidraw-files.ts`). Upload/download needs network; SW does not cache these. |
| **Scratch identity** | Device install id, guest display name, and creating-browser host secret use `localStorage`. Those reads/writes do not require the network, but they are not a board library. |
| **Cloud upserts while opening a board** | Hub and board code call cloud “touch” / claim helpers and **catch** failures. Signed-out create still navigates to `/board/{uuid}`. Opening the board route itself is still a **navigation**; if the network is down, the SW serves `/offline` instead of the board HTML. |

**Summary:** scratch-board identity (host secret, guest name) can be read without the network. Anything that depends on `/api/whiteboard/*` (sync WebSocket, share codes, cloud library, R2 assets) requires connectivity and is outside the service worker’s caching model. Navigating to hub or board pages while offline yields the `/offline` page, not a cached board UI. Fonts for the canvas are same-origin `/excalidraw/fonts` and may be served from the SW asset cache if they were fetched earlier.
