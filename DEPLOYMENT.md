# Deploying to Cloudflare Pages

## Prerequisites

- Cloudflare account with your domain already added
- GitHub repo with the project code pushed

## Step 1: Create the Pages Project

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **Workers & Pages** in the sidebar
3. Click **Create** > **Pages** > **Connect to Git**
4. Authorize Cloudflare to access your GitHub account (if not already connected)
5. Select the repository

## Step 2: Configure Build Settings

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | *(leave empty)* |
| Build output directory | `/` |

Click **Save and Deploy**. Cloudflare will deploy the site and assign a `*.pages.dev` URL.

## Step 3: Connect Your Custom Domain

1. Go to your Pages project in the Cloudflare dashboard
2. Click **Custom domains** > **Set up a custom domain**
3. Enter your domain (e.g., `example.com` or `www.example.com`)
4. Cloudflare will automatically create the DNS record since the domain is already in your account
5. Wait for the SSL certificate to provision (usually under 2 minutes)

## Step 4: Verify

- [ ] Site loads at your `*.pages.dev` URL
- [ ] Site loads at your custom domain with HTTPS
- [ ] Security headers are present (check with browser DevTools > Network tab > click any request > Headers)
- [ ] 404 page works (visit a non-existent path like `/doesnotexist`)
- [ ] Games page loads and filters work
- [ ] Service worker registers (DevTools > Application > Service Workers)
- [ ] Offline mode works (toggle offline in DevTools > Network, then reload)

## Automatic Deployments

Every push to `main` will trigger a new deployment automatically. Preview deployments are created for pull requests on other branches.

## Useful Commands (Optional)

If you prefer deploying via CLI instead of the dashboard:

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name your-project-name
```
