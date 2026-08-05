# Conventions

Rules for humans and coding agents working on scsfoxchase.tech. Aligns with root [`AGENTS.md`](../AGENTS.md). Prefer this page for detail; keep `AGENTS.md` as the short briefing.

## Brand and visual tokens

Defined on `:root` in `src/styles/global.css`. Dark mode overrides live under `[data-theme="dark"]`.

| Token | Value | Usage |
|-------|--------|--------|
| `--primary-color` | `#125F31` (green) | Headers, buttons, accents, links |
| `--secondary-color` | `#F6D724` (yellow) | Highlights, hover accents |
| `--accent-color` | `#e74c3c` | Accent / alert emphasis |
| Border radius (cards/buttons) | `2px` | Cards, buttons, panels |
| Border radius (pills) | `999px` | Search bars, chips, pill controls |

Other shared variables include `--text-color`, `--light-bg`, `--dark-bg`, `--border-color`, `--shadow`, `--transition`.

**Do not** introduce a CSS framework. Styles are plain CSS under `src/styles/`:

| File | Typical use |
|------|-------------|
| `global.css` | Tokens, header, shared chrome, game cards, search bars |
| `home.css` | Homepage dashboard / launcher layout |
| `carousel.css` | Trending carousel |
| `newgames.css` | Games catalog layout |
| `forms.css` | Forms hub and form fields |
| `inventory.css` | Staff inventory lookup |
| `whiteboard.css` | Whiteboard hub and board shell |
| `temp.css` | Temporary / experiment page styles |

Import page CSS from the page or `BaseLayout.astro` so bundles stay consistent between `astro dev` and production.

## Theming

- Appearance is applied with `data-theme="dark"` or light (default variables on `:root`).
- Preference cycles **light / dark / system** via `src/scripts/theme-toggle.ts`.
- Stored in `localStorage` under key `theme`.
- System preference uses `prefers-color-scheme` when preference is `system`.
- Preference attribute `data-theme-pref` drives the toggle thumb position in CSS.

When adding UI, use CSS variables (especially `--primary-color` / `--secondary-color`) and provide `[data-theme="dark"]` overrides where contrast would break.

## Device targets

The site must fit **without scrolling** on the three daily devices. The **desktop layout is final** — do not redesign it for novelty; compress or scale for smaller viewports instead.

| Device | Approx. screen | Design note |
|--------|----------------|-------------|
| Desktop monitors | Large | Default layout — preserve as-is |
| Student Chromebooks | 11.6", 1366×768 | Limited vertical space |
| iPads (landscape) | ~1024px wide | Limited horizontal space |

### Primary responsive breakpoints

Used across `home.css`, `newgames.css`, `forms.css`, `whiteboard.css`, and related sheets (as documented in `AGENTS.md`):

| Query | Intent |
|-------|--------|
| `@media (max-width: 1100px)` | iPad scaling — narrower tiles, smaller icons/gaps |
| `@media (max-width: 768px)` | Phone / narrow — stacked columns |
| `@media (max-height: 800px)` | Chromebook vertical compression (often combined with `min-width: 901px` on home/forms) |

Additional page-specific breakpoints (e.g. `900px`, `520px`, `480px`) appear in inventory and games CSS; prefer matching the nearest existing pattern rather than inventing a new scale.

**When adding sections or controls:** verify desktop, Chromebook height, and iPad width. Avoid introducing page scroll on those three targets.

## Content: games collection

Games are an Astro content collection.

- **Files:** `src/content/games/*.json` (one game per file)
- **Schema:** `src/content.config.ts` (zod)
- **Trending IDs:** `src/data/trending.json` (array of game `id` strings)
- **Images:** under `public/images/` (paths referenced from JSON, e.g. `/images/chess-com.png`)

### How to add a game

1. Add `src/content/games/<id>.json` matching the schema below (`id` should match the filename stem).
2. Add the image under `public/images/` (recommended ~600×400).
3. Optionally append the `id` to `src/data/trending.json` for the carousel.
4. Rebuild — the collection loads at build time via the glob loader.

### Game JSON schema

```json
{
  "id": "chess",
  "name": "Chess",
  "url": "https://www.chess.com/play",
  "image": "/images/chess-com.png",
  "description": "Play chess online against friends or the computer.",
  "minGrade": 3,
  "maxGrade": 8,
  "primaryCategories": ["Single Player", "Multiplayer", "Online"],
  "secondaryCategories": ["Board Games", "Classics", "Strategy", "Competitive"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique id (matches filename) |
| `name` | string | Yes | Display name |
| `url` | string | Yes | External game URL |
| `image` | string | Yes | Path under `public/` |
| `description` | string | Yes | Card/blurb text |
| `minGrade` | number | Yes | Lowest grade (1–8) |
| `maxGrade` | number | Yes | Highest grade (1–8) |
| `primaryCategories` | string[] | Yes | Play-style tags (Type; ≤3) |
| `secondaryCategories` | string[] | Yes | Genre tags (≤5) |

Image load failures fall back via `src/scripts/placeholder-images.ts`.

## Forms / Help content pattern

Help hub, form catalogs, and guide articles: see [features/forms.md](./features/forms.md) and root `FORMS.md`. Forms metadata: `src/data/forms.ts`. Guides: `src/content/guides/*.md`. Styles: `forms.css`. Icons: Lucide SVG strings in `src/scripts/icons.ts`.

Help/catalog pages use `bodyClass="help-page"`; individual forms use `forms-page`. Shell width matches inventory: `.container.form-shell` at **1120px**.

## Code and stack conventions

| Topic | Convention |
|-------|------------|
| Framework | Astro 7 file-based routing; React only where islands are required (Clerk, tldraw) |
| Prerender | Every page: `export const prerender = true` |
| Worker APIs | Only under `/api/whiteboard/*` in `src/worker.ts` / `src/worker/` |
| Service worker | Never intercept `/api/*` |
| Deploy target | Cloudflare Worker + assets — not Pages |
| Assets output | `dist/client/` — Wrangler `assets.directory` must match |
| Node | `>=22` |
| Trailing slash | Never (`trailingSlash: 'never'`) |

### Whiteboard naming (storage)

| Concept | Form |
|---------|------|
| Owner (signed out) | `local:{deviceInstallId}` |
| Owner (signed in) | `google:{accountId}` |
| Media key | `assets/{ownerKey}/{assetId}` |
| Cloud indexes | `library/{ownerKey}/boards.json`, `library/{ownerKey}/assets.json` |
| Share code KV | `code:{A1B2}` (TTL 12h) |

Do not invent alternate owner prefixes or put board sync state in R2 when the Durable Object owns the room.

### Agent-oriented rules

- **Desktop layout is final.** Fit Chromebook and iPad by scaling/compressing; do not overhaul the large-screen composition.
- **New UI must fit** desktop, Chromebook (`max-height: 800px`), and iPad (`max-width: 1100px`) without scroll on those targets.
- **Add games** only via the content collection JSON pattern above — the build picks them up automatically.
- **Whiteboard changes** belong in `src/worker/`, `src/lib/whiteboard-*.ts`, hub/board scripts, and whiteboard CSS — keep static catalog pages free of DO/R2 logic.
- **Secrets** stay in Wrangler secrets / `.dev.vars` — never commit `CLERK_SECRET_KEY` or webhook URLs into client code or git.
- **Do not** reintroduce Cloudflare Pages config (`cloudflare-pages.toml`) or publish `/` as the asset root.
- Prefer extending existing CSS files and class patterns over new design systems or utility libraries.

## Related docs

- [architecture.md](./architecture.md) — system shape and module map
- [ui-and-design.md](./ui-and-design.md) — UI patterns in depth
- [features/games.md](./features/games.md) — catalog behavior
- [whiteboard/README.md](./whiteboard/README.md) — whiteboard subsystem
