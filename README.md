# St. Cecilia Technology

A static PWA serving as a dashboard and educational games catalog for St. Cecilia School. Used daily by students and teachers on desktops, Dell Chromebooks, and iPads.

**Live site:** [scsfoxchase.tech](https://scsfoxchase.tech)

## Features

- **App Launcher Dashboard** — Homepage with search bars and a quick-launch grid for school tools
- **Educational Game Catalog** — Browse, search, and filter games by grade level and category
- **Trending Carousel** — Highlight featured games on a rotating carousel
- **Dark / Light Theme** — Toggle persisted in localStorage
- **Progressive Web App** — Installable, offline-capable, full-screen experience
- **Zero Dependencies** — No build step, no package manager, no frameworks — pure HTML/CSS/vanilla JS

## Getting Started

1. Clone the repository
2. Start any static server in the project root:
   ```bash
   python3 -m http.server 8000
   ```
3. Open `http://localhost:8000` in your browser

No build step, no `npm install` — it just works.

## Deployment

This site auto-deploys to **Cloudflare Pages** on push to `main`. There is no build command; the publish directory is `/`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full step-by-step setup guide.

<details>
<summary><strong>Deployment configuration files</strong></summary>

| File | Purpose |
|------|---------|
| `cloudflare-pages.toml` | Build settings, redirects, custom 404 |
| `_headers` | Security headers and caching policies |
| `sw.js` | Service worker for offline support |

</details>

## Project Structure

```
/
├── index.html              # Homepage — search bars + app launcher grid
├── games.html              # Game catalog with filtering and carousel
├── hub.html                # Archived old homepage (kept for potential reuse)
├── 404.html                # Custom error page
├── offline.html            # Offline fallback page
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (network-first strategy)
├── robots.txt              # Search engine crawling rules
├── sitemap.xml             # Site structure for search engines
├── apple-touch-icon.png    # iOS home screen icon
├── favicon-16.png          # 16×16 favicon
├── favicon-32.png          # 32×32 favicon
├── _headers                # Cloudflare security headers
├── cloudflare-pages.toml   # Cloudflare Pages config
├── css/
│   ├── styles.css          # Main stylesheet
│   └── carousel.css        # Carousel component styles
├── js/
│   ├── carousel.js         # Carousel functionality
│   ├── games.js            # Game data fetching and rendering
│   ├── placeholder-images.js # Dynamic PWA icons + image fallbacks
│   └── theme-toggle.js     # Dark/light theme switching
├── data/
│   └── games/
│       ├── _index.json     # List of all game IDs
│       ├── _trending.json  # Game IDs for the trending carousel
│       └── *.json          # Individual game data files
├── images/
│   ├── favicon-generator.html # Tool to generate favicons
│   └── *.png / *.jpg       # Game and app images
└── old-site/               # Previous version of the site (archived)
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

Games live in `data/games/` as individual JSON files. To add a new game:

1. Create a JSON file in `data/games/` (e.g., `my-game.json`)
2. Add the game ID to `data/games/_index.json`
3. Optionally add the ID to `data/games/_trending.json` to feature it in the carousel
4. Add a corresponding image to `images/` (recommended: 600×400px)

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
| `image` | string | Yes | Path to the game image (relative to root) |
| `description` | string | Yes | Short description shown on the game card |
| `minGrade` | number | Yes | Lowest grade level (1–8) |
| `maxGrade` | number | Yes | Highest grade level (1–8) |
| `primaryCategories` | string[] | Yes | Play-style tags (e.g., Single Player, Multiplayer, Offline, PvP) |
| `secondaryCategories` | string[] | Yes | Genre tags (e.g., Puzzle, Educational, Trivia, Competitive) |

</details>

## Theming and Styles

Colors and spacing are controlled by CSS custom properties on `:root` in `css/styles.css`.

| Token | Value | Usage |
|-------|-------|-------|
| Primary | `#125F31` (green) | Headers, buttons, accents |
| Secondary | `#F6D724` (yellow) | Highlights, hover states |
| Border radius | `2px` | Cards, buttons |
| Border radius (pill) | `999px` | Search bars, chips |

Dark mode is activated via `[data-theme="dark"]` selectors. Theme state is stored in `localStorage`.

<details>
<summary><strong>Modifying the color scheme</strong></summary>

Edit the `:root` variables at the top of `css/styles.css`:

```css
:root {
  --primary-color: #125F31;
  --secondary-color: #F6D724;
  /* ... other tokens */
}
```

Dark mode overrides live under `[data-theme="dark"]` selectors in the same file.

</details>

## Progressive Web App

<details>
<summary><strong>PWA capabilities</strong></summary>

- **Installable** — Users can add the site to their home screen or dock
- **Offline support** — The service worker uses a **network-first** strategy: it always tries the network, then falls back to the cache. Only the offline fallback page (`offline.html`) is pre-cached during install; all other assets are cached on fetch for offline use only.
- **App-like experience** — Runs full-screen without browser UI when installed
- **Dynamic icons** — PWA icons and fallback images are generated dynamically by `js/placeholder-images.js` when assets fail to load

Because the strategy is network-first, there is no cache versioning — users always get the latest content when online.

</details>

## Security

<details>
<summary><strong>Security headers and policies</strong></summary>

Configured in `_headers` and enforced by Cloudflare Pages:

- **Content Security Policy (CSP)** — Restricts resource loading to prevent XSS
- **Strict-Transport-Security (HSTS)** — Enforces HTTPS
- **X-Frame-Options** — Prevents clickjacking
- **Referrer-Policy** — Controls information sent in the HTTP referer header
- **X-Content-Type-Options** — Prevents MIME-type sniffing

</details>

## Performance

- **Network-first caching** — Fresh content on every visit; cached assets for offline fallback only
- **Lazy loading** — Images load only when scrolled into view
- **Zero dependencies** — No heavy frameworks, no bundler overhead
- **Responsive images** — Sized for each device class

<details>
<summary><strong>Known limitations</strong></summary>

- No build step means no minification or tree-shaking — file sizes are as-authored
- No TypeScript — all JavaScript is vanilla ES6+
- No CSS preprocessor — all styles are plain CSS
- Image assets are not automatically optimized; add appropriately-sized files manually

</details>

## Clearing the Cache

If the site isn't showing recent changes, the browser may be serving a stale cached version.

<details>
<summary><strong>Chromebooks (Chrome OS)</strong></summary>

1. Open the site in Chrome
2. Press `Ctrl + Shift + Delete` to open Clear Browsing Data
3. Set the time range to **All time**
4. Check **Cached images and files**
5. Click **Clear data**
6. Reload the page with `Ctrl + Shift + R`

**Single-site alternative:**

1. Press `F12` to open DevTools (or `Ctrl + Shift + I`)
2. Go to the **Application** tab
3. Click **Storage** in the left sidebar
4. Click **Clear site data**
5. Close DevTools and reload the page

</details>

<details>
<summary><strong>Google Chrome (Windows / Mac)</strong></summary>

1. Press `Ctrl + Shift + Delete` (Windows) or `Cmd + Shift + Delete` (Mac)
2. Set the time range to **All time**
3. Check **Cached images and files**
4. Click **Clear data**
5. Reload with `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)

**Single-site alternative:**

1. Press `F12` (or `Ctrl + Shift + I` / `Cmd + Option + I`)
2. Go to the **Application** tab
3. Click **Storage** > **Clear site data**
4. Close DevTools and reload

</details>

<details>
<summary><strong>Firefox</strong></summary>

1. Press `Ctrl + Shift + Delete` (Windows) or `Cmd + Shift + Delete` (Mac)
2. Set the time range to **Everything**
3. Check **Cache**
4. Click **Clear Now**
5. Reload with `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)

**Single-site alternative:**

1. Click the lock icon in the address bar
2. Click **Clear cookies and site data**
3. Click **Remove** to confirm
4. Reload the page

</details>

<details>
<summary><strong>Safari (Mac / iPad)</strong></summary>

**Mac:**

1. Go to **Safari > Settings** (or **Preferences**)
2. Go to the **Privacy** tab
3. Click **Manage Website Data**
4. Search for **scsfoxchase**, select it, and click **Remove**
5. Reload with `Cmd + Shift + R`

**iPad:**

1. Open the **Settings** app
2. Scroll down and tap **Safari**
3. Tap **Clear History and Website Data**
4. Confirm and reopen the site

</details>

## Browser Compatibility

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers (iOS Safari, Android Chrome)

## License

This project is available for free use in educational settings.

## Credits

Created for grade-school tech teachers and IT managers to provide a curated dashboard and collection of educational games for students.
