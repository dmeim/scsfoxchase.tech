# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

St. Cecilia Technology — a static PWA serving as a dashboard and educational games catalog for a grade school. Used daily by students and teachers on both full-size desktop monitors and small Dell Chromebooks.

## Development

No build step, no package manager, no dependencies. This is a pure HTML/CSS/vanilla JS static site.

- **Dev server**: Any static server works (e.g., `python3 -m http.server 8000`)
- **Deployment**: Push to `main` branch auto-deploys to Cloudflare Pages (no build command)
- **Domain**: scsfoxchase.tech

## Architecture

- **Static PWA** with service worker (`sw.js`) for offline support. Uses network-first strategy — no cache versioning needed. Only the offline fallback page is pre-cached; all other assets are cached on fetch for offline use only.
- **Game data** lives in `data/games/` as individual JSON files. `_index.json` lists all game IDs; `_trending.json` lists carousel games. To add a game: create its JSON file and add the ID to `_index.json`.
- **Theming** uses CSS variables on `:root` with dark mode via `[data-theme="dark"]` selectors. Theme state persists in localStorage.
- **`js/placeholder-images.js`** dynamically generates PWA icons and fallback images when assets fail to load.

## Key Pages

| Route | File | Purpose |
|-------|------|---------|
| `/` | `index.html` | Homepage — search bars + app launcher grid |
| `/games.html` | `games.html` | Game catalog with filtering/carousel |
| `/hub.html` | `hub.html` | Archived old homepage (kept for potential reuse) |

## Device Compatibility (Important)

The site runs on three device types:
- **Desktop monitors**: Large screens, the layout fits perfectly — do not change
- **Student Chromebooks**: 11.6" screens (1366x768), limited vertical space
- **iPads**: ~1024px wide in landscape, limited horizontal space

Responsive queries in `css/styles.css`:
- `@media (max-width: 1100px)` — iPad scaling (narrower app tiles, smaller icons/gaps)
- `@media (max-width: 768px)` — Mobile/phone layout (stacked elements)
- `@media (max-height: 800px)` — Chromebook vertical compression

**When adding new sections or elements, ensure they fit on all three device types without scrolling.** The desktop layout is considered final.

## Deployment Config

- `cloudflare-pages.toml` — Cloudflare Pages settings (no build command, publish dir is `/`)
- `_headers` — Security headers (CSP, HSTS, X-Frame-Options, cache rules)
- `sw.js` — Service worker with network-first strategy for HTML, cache fallback for assets

## Style Conventions

- Colors: primary `#125F31` (green), secondary `#F6D724` (yellow)
- Border radius: `2px` for cards/buttons, `999px` for pills/search bars
- No CSS framework — all custom styles in `css/styles.css` and `css/carousel.css`
