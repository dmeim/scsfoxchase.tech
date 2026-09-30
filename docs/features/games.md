# Games catalog (`/games`)

Educational games browser: sidebar filters, trending hero carousel, a first-party Mini Games launcher, and a grid of external-game cards. External-game data is an Astro content collection of JSON files, embedded in the page at build time (no client fetch for the catalog).

## Routes

| Route | Source | Behavior |
|-------|--------|----------|
| `/games` | `src/pages/games.astro` | Current catalog (`NewGamesCatalog`) |
| `/minigame/dino-run` | `src/pages/minigame/dino-run.astro` | First-party Dino Run with windowed/native-fullscreen play |
| `/games.html` | `astro.config.mjs` `redirects` | Redirects to `/games` |
| `/newgames` | `astro.config.mjs` `redirects` | Redirects to `/games` |
| `/oldgames` | `src/pages/oldgames.astro` | Alternate catalog UI (`GamesCatalog`) with a top trending carousel and denser cards; same games collection and trending IDs |

Page title on `/games`: “Games - St. Cecilia Technology”; `bodyClass="games-page"`. Styles: `src/styles/newgames.css`. `/oldgames` uses `src/styles/carousel.css` and title “Games (Legacy) - St. Cecilia Technology”.

## User-visible behavior (`/games`)

Component: `src/components/NewGamesCatalog.astro`. Client init: `src/scripts/games-catalog.ts` (`initGamesCatalog`) plus inline hero autoplay in the component. Background: `src/scripts/dot-waves.ts`.

### Sidebar filters

- **Search** — `#game-search`; matches game `name` or `description` (case-insensitive substring).
- **Grade** — chips 1–8; a game matches if any selected grade falls in `[minGrade, maxGrade]` (OR across selected grades).
- **Type** — chips built from all `primaryCategories` in the collection (sorted).
- **Genre** — chips built from all `secondaryCategories` (sorted).

Selecting a chip toggles it. Multiple chips in a group use OR within that group; search, grade, type, and genre combine with AND across groups.

### Trending hero

IDs from `src/data/trending.json` are resolved to games in order. The first resolved game is the initial hero; prev/next and progress segments cycle every 5s. Hero link opens the game `url` in a new tab.

Current trending IDs (order matters):

```json
["bloxd", "eaglercraft", "little-alchemy", "neal-fun", "lol-beans", "stumble-guys"]
```

### First-party Mini Games

A separate launcher group sits between the trending carousel and the external-game grid. It is rendered by `src/components/MiniGamesLauncher.astro` from `src/data/minigames.ts`. These links open in the same tab and are not included in the external catalog's search/filter counts. The first entry is **Dino Run** at **`/minigame/dino-run`**.

Launcher artwork is optional: set an `image` path on the mini-game record when artwork is available; otherwise its `glyph` is displayed. Mini games have their own prerendered pages under `src/pages/minigame/` rather than external-game JSON records.

#### Game frame and Dino Run

- `src/components/MinigameFrame.astro`, `src/scripts/minigame-frame.ts`, and `src/styles/minigames.css` provide the reusable **16:9** player. The fullscreen button requests native browser fullscreen for the player itself, including its controls—not the whole site. Other screen ratios are letterboxed, never stretched. The button is hidden when native fullscreen is unsupported; request failures display a helpful message.
- Dino Run uses a fixed **800×450** game world and a **60 Hz** simulation. Resizing/fullscreen only changes rendering resolution. The canvas backing buffer follows the displayed size and device pixel ratio (capped at 2).
- **Space / Up Arrow:** jump; release early for a short hop, hold for a high jump. **Shift:** slam down. **P:** pause/resume. **R:** restart. **Escape:** pause and, when fullscreen, allow the browser to exit fullscreen.
- Touch/mouse players can tap/hold the canvas or Jump button and use the Slam button. Gameplay keys apply only while the game has focus, not to navigation, form fields, or buttons.
- The runner retains three hearts, post-hit grace time, increasing speed, and the existing pixel dinosaur/cacti. The personal best uses the same `offline-dino-best` localStorage key as the offline runner. No account or server-side game state is required.
- Losing focus or hiding the tab pauses the run. Resume is explicit; a paused/finished game does not keep a rendering loop running.
- The original `src/pages/offline.astro` runner and service-worker policy are unchanged. The new mini-game route is **not precached**; navigating to it offline still serves `/offline`.

Verification: `npm run typecheck:minigames`, `npm test`, and `npm run build`. Gameplay regression tests are in `tests/dino-run.test.ts`.

### Grid

`#games-grid` uses `data-card-style="max"`: image + one-line title.

- **Image click** — opens `game.url` in a new tab (`noopener,noreferrer`).
- **Title click** (or Enter/Space) — opens a detail modal with art, grade/type/genre chips, description, and Play.
- Modal: single shared `#game-detail-modal` node; close via X, backdrop, or Escape; body scroll locked while open.
- Failed images use `src/scripts/placeholder-images.ts`. Empty filter result shows “No Games Found”.

Catalog payload is embedded as JSON in `#games-catalog-data` (`{ games, trendingIds }`); hero slides in `#ng-hero-data`.

## Content collection

Defined in `src/content.config.ts` (`games` collection). Loader: glob `**/*.json` under `src/content/games/`.

### Schema

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Stable id (must match filename stem for trending lookups) |
| `name` | string | Display title |
| `url` | string | External play URL |
| `image` | string | Image path (usually under `/images/…`) |
| `description` | string | Short blurb |
| `minGrade` | number | Inclusive lower grade |
| `maxGrade` | number | Inclusive upper grade |
| `primaryCategories` | string[] | “Type” filters / badges (≤3) |
| `secondaryCategories` | string[] | “Genre” filters / badges (≤5) |

Example (`src/content/games/bloxd.json`):

```json
{
  "id": "bloxd",
  "name": "Bloxd.io",
  "url": "https://bloxd.io/",
  "image": "/images/bloxdio.png",
  "description": "Multiplayer voxel game with various game modes.",
  "minGrade": 4,
  "maxGrade": 8,
  "primaryCategories": ["Multiplayer", "Online", "PvP"],
  "secondaryCategories": ["Sandbox", "Battle Royale", "Action"]
}
```

There are ~124 JSON entries under `src/content/games/`.

### How to add a game

1. Add `src/content/games/<id>.json` with all schema fields. Keep `id` equal to the filename stem.
2. Put the image under `public/images/` (or another path referenced by `image`).
3. Optionally add the `id` to `src/data/trending.json` to include it in the hero (and on `/oldgames` carousel).
4. Rebuild / refresh dev — the collection is picked up at build time; no code change required beyond the JSON (and trending list if desired).

Category chip colors for known labels live in `src/scripts/games-catalog.ts` (`PRIMARY_CATEGORY_COLORS`, `SECONDARY_CATEGORY_COLORS`).

## `/oldgames`

Same data pipeline (`getCollection('games')` + `trending.json`) via `src/components/GamesCatalog.astro`. Differences:

- Top `#trending-carousel` ( `src/scripts/carousel.ts` ) instead of the `/games` hero.
- Filter UI above a fuller card layout (image, title, description, Type/Genre badge columns) — default card style (no `data-card-style="max"`).

## Key files

| File | Role |
|------|------|
| `src/pages/games.astro` | `/games` entry |
| `src/pages/oldgames.astro` | `/oldgames` entry |
| `src/components/NewGamesCatalog.astro` | Current catalog UI |
| `src/components/MiniGamesLauncher.astro` | First-party mini-game launcher group |
| `src/data/minigames.ts` | Mini-game names, routes (by id), glyphs, and optional artwork |
| `src/components/MinigameFrame.astro` | Reusable 16:9/native-fullscreen game frame |
| `src/components/minigames/DinoRunGame.astro` | Dino Run canvas, HUD, overlays, and controls |
| `src/lib/minigames/dino-run.ts` | Fixed-step Dino Run simulation |
| `src/lib/minigames/dino-renderer.ts` | Canvas rendering and resize/theme handling |
| `src/scripts/dino-run.ts` | Game input, pause/resume, scores, and lifecycle |
| `src/components/GamesCatalog.astro` | `/oldgames` UI |
| `src/content.config.ts` | Collection schema |
| `src/content/games/*.json` | Game records |
| `src/data/trending.json` | Trending id list |
| `src/scripts/games-catalog.ts` | Filter + grid |
| `src/scripts/carousel.ts` | `/oldgames` trending carousel |
| `src/styles/newgames.css` | `/games` layout |
| `src/styles/carousel.css` | `/oldgames` layout |
| `astro.config.mjs` | `/games.html`, `/newgames` → `/games` |
