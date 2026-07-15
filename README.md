# St. Cecilia Technology

A PWA dashboard and educational games catalog for St. Cecilia School. Used daily by students and teachers on desktops, Dell Chromebooks, and iPads.

**Live site:** [scsfoxchase.tech](https://scsfoxchase.tech)

**Stack:** Astro 7 + `@astrojs/cloudflare`, deployed as a Cloudflare Worker with static assets.

## Features

- **App Launcher Dashboard** — Homepage with search bars and a quick-launch grid for school tools
- **Educational Game Catalog** — Browse, search, and filter games by grade level and category
- **Trending Carousel** — Highlight featured games on a rotating carousel
- **Dark / Light Theme** — Toggle persisted in localStorage
- **Progressive Web App** — Installable, offline-capable, full-screen experience
- **Staff Inventory** — Device lookup + QR at `/inventory`

## Getting Started

```bash
npm install
npm run dev
```

Open the URL Astro prints (usually `http://localhost:4321`).

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local Astro dev server |
| `npm run build` | Production build → `dist/client/` |
| `npm run preview` | Preview the production build locally |
| `npm run deploy` | Build + `wrangler deploy` to Worker `scsfoxchase-tech` |

Node.js **22+** is required (see `.nvmrc` / `package.json` `engines`).

## Deployment

The site deploys to **Cloudflare Workers** (Worker name `scsfoxchase-tech`). Assets come from `dist/client/` after `npm run build`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Workers Builds settings and deploy details. Agent-oriented project notes live in [AGENTS.md](AGENTS.md).

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Worker name + assets directory |
| `astro.config.mjs` | Astro + Cloudflare adapter + legacy redirects |
| `public/_headers` | Security headers and caching |
| `public/_redirects` | A few path redirects (`/newhome/`, `/inventory/`) |
| `public/sw.js` | Service worker for offline support |

## Project Structure

```
/
├── src/
│   ├── pages/              # Routes (index, games, offline, inventory, 404)
│   ├── components/         # Shared Astro/UI components
│   ├── content/games/      # Game JSON (Astro content collection)
│   ├── data/               # Trending IDs, inventory data
│   ├── layouts/            # Page layouts
│   ├── scripts/            # Client scripts (theme, placeholders, etc.)
│   └── styles/             # global.css, home.css, carousel.css, inventory.css
├── public/
│   ├── images/             # Game and app images
│   ├── _headers            # Cloudflare security headers
│   ├── _redirects          # Legacy path redirects
│   ├── sw.js               # Service worker
│   ├── manifest.json       # PWA manifest
│   └── …                   # Favicons, robots.txt, sitemap.xml
├── astro.config.mjs
├── wrangler.jsonc
├── package.json
├── AGENTS.md
└── DEPLOYMENT.md
```

## Target Devices

The site is designed to work without scrolling on three device types:

| Device | Screen | Breakpoint |
|--------|--------|------------|
| Desktop monitors | Large screens | Default layout |
| Student Chromebooks | 11.6", 1366×768 | `@media (max-height: 800px)` |
| iPads (landscape) | ~1024px wide | `@media (max-width: 1100px)` |
| Mobile / phone | < 768px | `@media (max-width: 768px)` |

The desktop layout is considered final. All new elements must fit on all three device types without introducing scroll.

## Adding and Managing Games

Games live in `src/content/games/` as individual JSON files. The Astro content collection picks them up at build time. Trending carousel IDs live in `src/data/trending.json`.

1. Add a JSON file under `src/content/games/` (e.g. `my-game.json`)
2. Optionally add the game ID to `src/data/trending.json`
3. Add a corresponding image under `public/images/` (recommended: 600×400px)

<details>
<summary><strong>Game JSON schema</strong></summary>

```json
{
  "id": "my-game",
  "name": "My Game",
  "url": "https://example.com/game",
  "image": "/images/my-game.png",
  "description": "A short description of the game.",
  "minGrade": 1,
  "maxGrade": 5,
  "primaryCategories": [
    "Single Player",
    "Online",
    "Free to Play"
  ],
  "secondaryCategories": [
    "Puzzle",
    "Educational",
    "Casual"
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier, matches the filename |
| `name` | string | Yes | Display name shown in the catalog |
| `url` | string | Yes | Link to the game |
| `image` | string | Yes | Path to the game image (under `public/`) |
| `description` | string | Yes | Short description shown on the game card |
| `minGrade` | number | Yes | Lowest grade level (1–8) |
| `maxGrade` | number | Yes | Highest grade level (1–8) |
| `primaryCategories` | string[] | Yes | Play-style tags |
| `secondaryCategories` | string[] | Yes | Genre tags |

</details>

## Theming and Styles

Colors and spacing use CSS custom properties on `:root` in `src/styles/global.css`.

| Token | Value | Usage |
|-------|-------|-------|
| Primary | `#125F31` (green) | Headers, buttons, accents |
| Secondary | `#F6D724` (yellow) | Highlights, hover states |
| Border radius | `2px` | Cards, buttons |
| Border radius (pill) | `999px` | Search bars, chips |

Dark mode is activated via `[data-theme="dark"]`. Theme state is stored in `localStorage` (`src/scripts/theme-toggle.ts`).

## Progressive Web App

- **Installable** — Add to home screen or dock
- **Offline support** — Network-first navigations; `/offline` is the canonical offline page; `/_astro/*` is cache-first
- **Image fallbacks** — `src/scripts/placeholder-images.ts` when assets fail to load

## Security

Configured in `public/_headers` and enforced by Cloudflare:

- Content Security Policy (CSP)
- Strict-Transport-Security (HSTS)
- X-Frame-Options
- Referrer-Policy
- X-Content-Type-Options

## Clearing the Cache

If the site isn't showing recent changes, clear cached images/files for the site (Chrome: `Ctrl/Cmd + Shift + Delete`, or DevTools → Application → Clear site data), then hard-reload.

## Browser Compatibility

- Chrome, Firefox, Safari, Edge (latest)
- Mobile browsers (iOS Safari, Android Chrome)

## License

This project is available for free use in educational settings.

## Credits

Created for grade-school tech teachers and IT managers to provide a curated dashboard and collection of educational games for students.
