# yt-proxy

A reverse proxy for YouTube, built as a Cloudflare Worker and auto-deployed from GitHub Actions.

## What this actually does

Requests go to *your* Worker's domain (`*.workers.dev`, or a custom domain you attach),
which fetches the real YouTube content server-side and streams it back to you. A
network that blocks `youtube.com` by hostname/DNS typically won't block your Worker's
domain, since it's just another Cloudflare-hosted site.

**Read the limitations comment at the top of `src/index.js`** — video/thumbnail CDN
domains change behavior over time, so expect some maintenance.

## One-time setup

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up — Workers
   has a generous free tier (100k requests/day).

2. **Push this folder to a new GitHub repo.**

3. **Get your Cloudflare credentials:**
   - Account ID: Cloudflare dashboard → Workers & Pages → right sidebar.
   - API Token: dashboard → My Profile → API Tokens → Create Token → use the
     "Edit Cloudflare Workers" template.

4. **Add them as GitHub Actions secrets** (repo → Settings → Secrets and variables →
   Actions → New repository secret):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

5. **Push to `main`.** The included workflow (`.github/workflows/deploy.yml`) runs
   `wrangler deploy` automatically and publishes your Worker.

Your proxy will be live at `https://yt-proxy.<your-subdomain>.workers.dev`.

## Local testing (optional)

```bash
npm install -g wrangler
wrangler login
wrangler dev
```

## A note on legitimate use

Only run this against networks or accounts you're actually authorized to bypass
restrictions on (e.g. your own home network, or a workplace/school that explicitly
permits it). Bypassing network policy at a workplace or school can violate that
organization's acceptable-use rules even though the code itself isn't doing anything
illegal — that's on you to check locally.
