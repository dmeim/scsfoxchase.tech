# St. Cecilia Technology

A static website for grade-school tech teachers and IT managers, designed to be deployed on Cloudflare Pages. This website showcases educational games suitable for students in grades 1-8.

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
