# aibhlinn.ai, the AibhlínnAI front door

A one-page static site for the bare domain `aibhlinn.ai`: who AibhlínnAI is,
a card for each app (Pie Timers so far), the no-ads promise, a brand kit for
event organisers and media, and a contact address. Plus a `404.html` that
points lost visitors at Pie Timers.

**Home: the `AibhlinnAI/aibhlinn.ai` repo**, published by GitHub Pages
from `.github/workflows/deploy.yml`. It was drafted in `www/` of
`pie-timers-app` and moved here on 1 Oct 2026, because a Pages site has
one custom domain and `pie-timers-app` already uses its one for
`pietimers.aibhlinn.ai`.

## Rules this page keeps

Same principles as the app (`ARCHITECTURE.md` §3 and §4), applied to a page
with far less reason to break them:

- **No JavaScript.** The only `<script>` is JSON-LD, which is data for search
  engines and never runs. Nothing on the page needs code.
- **No third-party requests.** The font is self-hosted (copied from
  `pie-timers-app/app/fonts/`), images are local, and there is no CDN. The
  guard job in `.github/workflows/deploy.yml` scans for secrets and tracker
  domains before every publish, and a hit stops the deploy.
- **No cookies, no analytics.** The footer says so, which makes it a promise.
- **No prices and no dates.** Both already live in several places that must
  move together (`CLAUDE.md`, "The launch dates live in several places").
  This page links to `pricing.html` instead of quoting it, so it never goes
  stale on 1 November. If you add a price or a date here, add this repo to
  that list in `pie-timers-app/CLAUDE.md` in the same commit.
- **No Play steering risk.** The Google Play app never links here, and this
  page shows no prices. Keep both true.

## Colours

From `pie-timers-app/brand/README.md`, never invented here. The hero and footer are always
brand blue `#050818`, because the logo artwork has that navy baked in. The
sections between follow the visitor's light or dark setting: blue on white
`#2E3A63` on light, titanium `#CED1D8` (and its gradient) on dark. Pie Timers'
own purple, green and orange appear only inside its card. Every text colour
pair clears 6.9:1 contrast.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `404.html` | Served by GitHub Pages for any missing path. Root-absolute links, because it can be served at any depth |
| `site.css` | All styles for both pages |
| `aibhlinn-logo.png`, `aibhlinn-mark-512.png`, `aibhlinn-mark-80.png` | Copies of the files in `pie-timers-app/app/`. The two large ones are the brand-kit downloads |
| `logo.webp`, `logo.jpg` | The logo re-encoded for the hero: 9 KB and 33 KB instead of 361 KB |
| `og-image.jpg` | 1200 × 630 link-preview image (WhatsApp, LinkedIn, Teams, Discord) |
| `favicon.ico`, `apple-touch-icon.png` | Tab and home-screen icons from the mark |
| `CNAME`, `.nojekyll` | The custom domain, and no Jekyll processing |
| `fonts/` | Instrument Sans, copied from `pie-timers-app/app/fonts/`, with its licence |

If the logo artwork ever changes, update `pie-timers-app/app/` and here together, then
regenerate the derived images (ImageMagick):

```bash
convert aibhlinn-logo.png -strip -quality 86 -sampling-factor 4:4:4 logo.jpg
convert aibhlinn-logo.png -strip -quality 84 logo.webp
convert aibhlinn-logo.png -resize 1120x630 -set option:distort:viewport 1200x630-40+0 \
        -virtual-pixel Edge -distort SRT 0 +repage -strip -quality 88 og-image.jpg
convert aibhlinn-mark-512.png -resize 180x180 -strip apple-touch-icon.png
convert aibhlinn-mark-512.png -strip \( -clone 0 -resize 16x16 \) \
        \( -clone 0 -resize 32x32 \) \( -clone 0 -resize 48x48 \) -delete 0 favicon.ico
```

## Previewing

Double-click `index.html`. Everything works from `file://` except the 404
page, whose root-absolute links need a server. The link-preview tags use
absolute `https://aibhlinn.ai/` URLs, so previews only work once it is live.

## Going live, once

1. Repo → **Settings → Pages → Source: GitHub Actions**. The first push to
   `main` then deploys.
2. Cloudflare DNS for `aibhlinn.ai`, all **DNS only (grey cloud)** until
   GitHub has issued the certificate (the lesson from
   `pie-timers-app/DEPLOY.md` §3):
   - four `A` records on the apex `@`: `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - a `CNAME` `www` → `aibhlinnai.github.io`, so `www.aibhlinn.ai`
     redirects to the apex
   - leave the apex `MX` and `TXT` records alone: Cloudflare Email Routing
     and Resend depend on them
3. **Settings → Pages → Custom domain** → `aibhlinn.ai` → Save. When the DNS
   check goes green, tick **Enforce HTTPS**.
