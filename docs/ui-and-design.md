# UI and design

Visual system, layout patterns, and responsive behavior for scsfoxchase.tech. Styles live under `src/styles/`; theme behavior is in `src/scripts/theme-toggle.ts` and an inline boot script in `src/layouts/BaseLayout.astro`.

Related: [PWA and offline](pwa-and-offline.md), [conventions](conventions.md), [docs index](README.md), [AGENTS.md](../AGENTS.md).

## Brand

| Token | Value | CSS variable |
|-------|--------|----------------|
| Primary (green) | `#125F31` | `--primary-color` |
| Secondary (yellow) | `#F6D724` | `--secondary-color` |
| Accent | `#e74c3c` | `--accent-color` |

**Radii conventions** (as used in CSS):

- **`2px`** — buttons (`.btn`), cards/tiles (`.game-card`, `.app-item`, forms/whiteboard panels), theme toggle chrome, most bordered surfaces
- **`999px`** — search pills (`.search-bar input`, `.google-search-bar`), filter chips, small pill badges (`.chip`), inventory/search controls
- **Exceptions** — app icon wrappers use `12px` (home) / `8px` when compressed; some inventory/temp surfaces use other radii

`--shadow` is `none` in both themes. Hover motion uses `--transition: all 0.3s ease`.

## CSS variables and themes

Defined on `:root` in `src/styles/global.css`:

```css
:root {
    --primary-color: #125F31;
    --secondary-color: #F6D724;
    --accent-color: #e74c3c;
    --text-color: #333;
    --light-text: #fff;
    --light-bg: #f9f9f9;
    --dark-bg: #000;
    --border-color: #ddd;
    --shadow: none;
    --transition: all 0.3s ease;
}
```

Dark mode remaps surface/text tokens under `[data-theme="dark"]`:

```css
[data-theme="dark"] {
    --text-color: #e0e0e0;
    --light-bg: #1a1a1a;
    --dark-bg: #2d2d2d;
    --border-color: #444;
    --shadow: none;
}
```

Primary and secondary brand colors stay the same in dark mode; UI that needs contrast adjusts with those remapped surfaces (and some component-specific rules).

### Theme persistence

1. **Boot (no FOUC)** — `BaseLayout.astro` reads `localStorage` key `theme` (`light` | `dark` | `system`, default `system`), resolves system via `prefers-color-scheme`, then sets:
   - `document.documentElement` → `data-theme-pref` (stored preference)
   - `document.documentElement` → `data-theme` (`light` or `dark` resolved appearance)
2. **Control** — `theme-toggle.ts` mounts a three-option radiogroup (Light / System / Dark) into `#theme-toggle-host` or `.header-right`, writes the same `localStorage` key, and keeps `data-theme` / `data-theme-pref` in sync. When preference is `system`, OS scheme changes update the resolved theme.
3. **Icons** — images with `.theme-icon` and `data-light` / `data-dark` swap `src` when the resolved theme changes.

## Typography

Body font: `'Segoe UI', Tahoma, Geneva, Verdana, sans-serif` (`global.css`). Brand and section titles use `--primary-color`. Interactive hover often shifts text/border to `--secondary-color` in light mode (dark mode header/nav hover uses primary instead).

## Global layout patterns

### Shell

- **`BaseLayout.astro`** — sticky transparent header, `<main>` slot, optional footer; imports `global.css` + `forms.css`.
- **Header** — CSS grid `1fr auto 1fr` (brand | center | theme/auth/nav). Transparent so page backgrounds show through. Brand height ~36px desktop.
- **Container** — `.container` max-width `1600px`, horizontal padding `20px`. Some hubs (forms, inventory, whiteboard) tighten content width (~1120px) in their own stylesheets.
- **Footer** — transparent, `margin-top: auto` so it sits at the bottom of the flex column body.

### Homepage (`body.home-page`)

- Blurred fixed background via `body.home-page::before` (`/images/background.png`).
- **Smart search** — pill `.google-search-bar` rows (`SmartSearch`).
- **App launcher** — `.app-gallery` / `.app-item` tiles (`AppLauncher`): bordered tiles with frosted backgrounds on home, icon in `.app-icon-wrapper`, label below.
- Desktop home uses viewport clamps (`--home-tile`, `--home-icon`, `--home-gap`, …) under `@media (min-width: 901px)` so the dashboard scales without a Chromebook-only width breakpoint.

### Cards vs non-cards

| Pattern | Where | Role |
|---------|--------|------|
| **Interactive tiles/cards** | `.app-item`, `.mockup-link` / `.mockup-card`, `.game-card`, forms tiles, whiteboard list rows | Bordered surfaces for launch/browse actions; hover raises border to primary and often text to secondary |
| **Search pills** | `.google-search-bar`, `.search-bar input` | Full-round inputs, not card chrome |
| **Buttons** | `.btn` | Primary fill, `2px` radius |
| **Chips** | `.filter-chip`, `.chip` | Pill filters/badges |
| **Header chrome** | brand, nav links, theme toggle | Frosted translucent backgrounds, not solid bar fills |

Games catalog uses a card grid (`.games-grid` / `.game-card`) with 16:9 image area and badge columns. Forms and whiteboard hubs use bordered panels/tiles with the same `2px` radius language.

## Shared UI patterns

### Search pills

`.google-search-bar`: flex row, `border-radius: 999px`, thick border, max-width ~420px (home clamps width further). Hover border → secondary; focus-within → primary. Submit side uses `.google-search-btn` with matching pill end radius (`0 999px 999px 0`).

Games filters use `.search-bar input` (also `999px`) plus `.filter-chip` pills.

### App tiles

`.app-item`: column flex, `2px` border, clamped width/padding. Home adds semi-transparent background + `backdrop-filter`. Hover: primary border, secondary text, slight `translateY(-2px)`.

### Buttons

`.btn`: primary background, light text, `2px` radius; hover flips to secondary background and dark text.

## Image fallbacks

`src/scripts/placeholder-images.ts` (wired from `games-catalog.ts`):

- **`<img src*="/images/">`** — on `error`, paints a canvas solid color from a hash of the game id and draws a title-cased name from the filename.
- **Background images** on `.carousel-slide-bg`, `.carousel-slide-image`, `.game-card-image` — probes the URL; on failure sets a solid background and a `.placeholder-text` label.

PWA icons are real files under `public/` (not generated by this script).

## Responsive breakpoints

Device targets (from project rules): large desktop monitors (primary fit), ~1024px iPads landscape, 11.6" Chromebooks (~1366×768), phones.

### Canonical trio (home / games / forms / whiteboard)

Quoted from stylesheets:

**iPad / narrower desktop — `max-width: 1100px`** (`home.css`, `newgames.css`):

```css
@media (max-width: 1100px) {
  .mockup-search-grid { grid-template-columns: repeat(2, 1fr); }
  .home1-board, .home3-lanes, .home4-dashboard { grid-template-columns: 1fr 1fr; }
  .home2-launchpad { grid-template-columns: repeat(4, 1fr); }
}
```

```css
@media (max-width: 1100px) {
    .newgames-split {
        grid-template-columns: minmax(200px, 28%) minmax(0, 1fr);
        gap: 20px;
    }
    /* …hero sizing… */
}
```

**Phone — `max-width: 768px`** (`home.css`, `newgames.css`, `forms.css`, `whiteboard.css`, `carousel.css`):

```css
@media (max-width: 768px) {
  .mockup-search-grid, .home1-board, .home3-lanes, .home4-dashboard, .home4-hero, .home4-side { grid-template-columns: 1fr; }
  .home2-launchpad { grid-template-columns: repeat(2, 1fr); }
  .home2-wide { grid-column: span 1; }
}
```

```css
@media (max-width: 768px) {
    .newgames-split {
        grid-template-columns: 1fr;
        gap: 20px;
    }
    .newgames-sidebar {
        position: static;
        max-height: none;
        overflow: visible;
    }
    /* … */
}
```

```css
@media (max-width: 768px) {
  .forms-grid {
    grid-template-columns: 1fr;
  }
  .forms-tile {
    min-height: 88px;
  }
}
```

```css
@media (max-width: 768px) {
  .wb-actions {
    flex-direction: column;
  }
  .wb-create-btn,
  .wb-join {
    width: 100%;
  }
}
```

**Chromebook vertical compression — `max-height: 800px`** (often combined with `min-width: 901px` so phone layouts are not double-compressed):

```css
@media (max-height: 800px) and (min-width: 901px) {
  .mockup-shell { padding-top: 10px; padding-bottom: 8px; }
  .mockup-title { margin-bottom: 4px; font-size: 1.35rem; }
  .mockup-kicker { display:none; }
  /* …smaller tiles/icons… */
}
```

```css
/* Chromebook vertical compression */
@media (max-height: 800px) {
    .newgames-sidebar {
        top: 10px;
        max-height: calc(100dvh - 20px);
        padding: 12px;
    }
    /* … */
}
```

```css
@media (max-height: 800px) and (min-width: 901px) {
  .form-page {
    padding: 8px 0;
  }
  /* …tighter form panel padding… */
}
```

```css
@media (max-height: 800px) {
  .wb-hub {
    padding-top: 8px;
  }
  /* …tighter hub spacing… */
}
```

### Other layout breakpoints in `global.css`

These coexist with the trio above:

| Query | Role |
|-------|------|
| `@media (max-width: 900px)` | Stack header; shrink chrome; stack search bars; wrap app rows (phone/narrow tablet) |
| `@media (min-width: 740px) and (max-width: 900px)` | Restore horizontal header/search for tablet portrait width |
| `@media (min-width: 901px)` | Home dashboard viewport clamps |
| `@media (max-width: 480px)` | Single-column games grid; tighter offline title sizes |
| `@media (min-width: 1280px)` | Games grid forced to 4 columns |

## Desktop as primary fit target

Per project rules: the **desktop layout is the primary fit target** and is treated as final. New sections must still fit Chromebook height and iPad width without relying on scroll where the desktop composition already fits. Prefer compressing spacing/tile size under `max-height: 800px` and narrowing grids under `1100px` / `768px` rather than redesigning the large-screen composition.
