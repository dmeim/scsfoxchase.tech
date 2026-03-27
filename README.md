# St. Cecilia Technology

A static website for all technology needs at St. Cecilia School, designed to be deployed on Cloudflare Pages.

## Features

- **Responsive Design**: Works on all devices from mobile to desktop
- **Educational Game Catalog**: Browse games suitable for different grade levels
- **Grade Filtering**: Filter games by grade level to find age-appropriate content
- **Trending Games Carousel**: Highlight popular educational games
- **Dark/Light Theme Toggle**: Switch between dark and light modes
- **Progressive Web App (PWA)**: Install as an app on mobile and desktop devices
- **Offline Support**: Basic functionality works without an internet connection
- **No Build Step**: Fully static — deploys directly to Cloudflare Pages

## Project Structure

```
/
├── index.html              # Landing page with site title and navigation
├── games.html              # Game catalog page with carousel and filtering
├── 404.html                # Custom error page
├── offline.html            # Offline fallback page
├── manifest.json           # PWA manifest file
├── sw.js                   # Service Worker for offline functionality
├── robots.txt              # Search engine crawling instructions
├── sitemap.xml             # Site structure for search engines
├── _headers                # Cloudflare security headers
├── cloudflare-pages.toml   # Cloudflare Pages configuration
├── DEPLOYMENT.md           # Cloudflare Pages deployment guide
├── css/
│   ├── styles.css          # Main stylesheet
│   └── carousel.css        # Styles for the carousel component
├── js/
│   ├── carousel.js         # Carousel functionality
│   ├── games.js            # Game data fetching and rendering
│   ├── placeholder-images.js # Dynamic image placeholder generation
│   └── theme-toggle.js     # Dark/light theme switching
├── data/
│   └── games/
│       ├── _index.json     # List of all game IDs
│       ├── _trending.json  # Game IDs for the trending carousel
│       └── *.json          # Individual game data files
├── images/
│   ├── favicon-generator.html # Tool to generate favicon
│   └── games/*.png         # Game images (to be added)
└── README.md               # Project documentation
```

## Setup Instructions

1. Clone or download this repository
2. No build step is required as this is a static website
3. Open `index.html` in your browser to view the website locally

### Image Setup

The website requires images for each game in `images/games/`. Recommended size: 600x400px. During development, colored placeholders are auto-generated when images are missing.

### Favicon Setup

To generate a favicon for the site:

1. Open `images/favicon-generator.html` in your browser
2. Click "Generate Favicon" button
3. Download the generated icon and save it as `favicon.ico` in the root directory

## Deployment

This site is designed for **Cloudflare Pages**. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full step-by-step guide.

The project includes configuration files for Cloudflare Pages:

- `_headers` — security headers and caching policies
- `cloudflare-pages.toml` — build settings, redirects, and custom 404 page

## Progressive Web App (PWA) Features

This website functions as a Progressive Web App with the following features:

- **Installable**: Users can add the website to their home screen
- **Offline Support**: Basic content remains available without an internet connection
- **App-like Experience**: Full-screen mode without browser UI when installed
- **Dynamic Icons**: PWA icons are generated dynamically

## Customization

### Adding New Games

1. Create a new JSON file in `data/games/` (e.g., `my-game.json`):

```json
{
  "id": "my-game",
  "name": "My Game",
  "url": "https://example.com/game",
  "image": "/images/games/my-game.png",
  "description": "Game description text.",
  "maxGrade": 5
}
```

2. Add the game ID to `data/games/_index.json`
3. Optionally add the game ID to `data/games/_trending.json` to feature it in the carousel
4. Add a corresponding image to `images/games/`

### Modifying Styles

The website uses CSS variables for consistent styling. The current color scheme uses:
- Primary color: Green (#125F31)
- Secondary color: Yellow (#F6D724)
- Light mode: White background
- Dark mode: Black background

You can modify these colors and other styles by editing the `:root` section in `css/styles.css`.

## Browser Compatibility

The website is compatible with:
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers (iOS Safari, Android Chrome)

## Clearing the Cache

If the site isn't showing recent changes after an update, the browser may be serving a stale cached version. Follow the steps below for your browser/device to clear it.

### Chromebooks (Chrome OS)

1. Open the site in Chrome
2. Press `Ctrl + Shift + Delete` to open Clear Browsing Data
3. Set the time range to **All time**
4. Check **Cached images and files**
5. Click **Clear data**
6. Reload the page with `Ctrl + Shift + R`

Alternatively, to clear only this site:

1. Press `F12` to open DevTools (or `Ctrl + Shift + I`)
2. Go to the **Application** tab
3. Click **Storage** in the left sidebar
4. Click **Clear site data**
5. Close DevTools and reload the page

### Google Chrome (Windows / Mac)

1. Press `Ctrl + Shift + Delete` (Windows) or `Cmd + Shift + Delete` (Mac) to open Clear Browsing Data
2. Set the time range to **All time**
3. Check **Cached images and files**
4. Click **Clear data**
5. Reload the page with `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)

Alternatively, to clear only this site:

1. Press `F12` to open DevTools (or `Ctrl + Shift + I` / `Cmd + Option + I`)
2. Go to the **Application** tab
3. Click **Storage** in the left sidebar
4. Click **Clear site data**
5. Close DevTools and reload the page

### Firefox

1. Press `Ctrl + Shift + Delete` (Windows) or `Cmd + Shift + Delete` (Mac) to open Clear Recent History
2. Set the time range to **Everything**
3. Check **Cache**
4. Click **Clear Now**
5. Reload the page with `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)

Alternatively, to clear only this site:

1. Click the lock icon in the address bar
2. Click **Clear cookies and site data**
3. Click **Remove** to confirm
4. Reload the page

### Safari (Mac / iPad)

1. Go to **Safari > Settings** (or **Preferences**) in the menu bar
2. Go to the **Privacy** tab
3. Click **Manage Website Data**
4. Search for **scsfoxchase**
5. Select it and click **Remove**
6. Close Settings and reload the page with `Cmd + Shift + R`

On iPad:

1. Open the **Settings** app
2. Scroll down and tap **Safari**
3. Tap **Clear History and Website Data**
4. Confirm by tapping **Clear**
5. Reopen the site in Safari

## Performance Optimizations

- **Caching Strategy**: Different caching policies for static assets vs. dynamic content
- **Lazy Loading**: Images load only when needed
- **Minimal Dependencies**: No heavy frameworks, just vanilla JavaScript
- **Responsive Images**: Optimized for different screen sizes

## Security Features

- **Content Security Policy**: Restricts resource loading to prevent XSS attacks
- **HTTPS Enforcement**: Strict Transport Security header
- **X-Frame-Options**: Prevents clickjacking
- **Referrer Policy**: Controls information sent in HTTP referrer

## License

This project is available for free use in educational settings.

## Credits

Created for grade-school tech teachers and IT managers to provide a curated collection of educational games for students.
