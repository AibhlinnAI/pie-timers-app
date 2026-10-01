# aibhlinn.ai, the AibhlínnAI front door

A one-page static site for the bare domain `aibhlinn.ai`: who AibhlínnAI is,
a card for each app (Pie Timers so far), the no-ads promise, a brand kit for
event organisers and media, and a contact address. Plus a `404.html` that
points lost visitors at Pie Timers.

**It is not live yet, and nothing in this repo publishes it.**
`.github/workflows/deploy.yml` serves only `app/` and `identity/` at
`pietimers.aibhlinn.ai`. A GitHub Pages site has one custom domain, so the
apex needs a deploy of its own. See *Putting it live* below.

## Rules this page keeps

Same principles as the app (`ARCHITECTURE.md` §3 and §4), applied to a page
with far less reason to break them:

- **No JavaScript.** The only `<script>` is JSON-LD, which is data for search
  engines and never runs. Nothing on the page needs code.
- **No third-party requests.** The font is self-hosted (copied from
  `app/fonts/`), images are local, and there is no CDN. The guard steps in
  `deploy.yml` scan `www/` for secrets and tracker domains on every push to
  `main`, the same as `app/`.
- **No cookies, no analytics.** The footer says so, which makes it a promise.
- **No prices and no dates.** Both already live in several places that must
  move together (`CLAUDE.md`, "The launch dates live in several places").
  This page links to `pricing.html` instead of quoting it, so it never goes
  stale on 1 November. If you add a price or a date here, add `www/` to that
  list in `CLAUDE.md` in the same commit.
- **No Play steering risk.** The Google Play app never links here, and this
  page shows no prices. Keep both true.

## Colours

From `brand/README.md`, never invented here. The hero and footer are always
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
| `aibhlinn-logo.png`, `aibhlinn-mark-512.png`, `aibhlinn-mark-80.png` | Copies of the files in `app/`. The two large ones are the brand-kit downloads |
| `logo.webp`, `logo.jpg` | The logo re-encoded for the hero: 9 KB and 33 KB instead of 361 KB |
| `og-image.jpg` | 1200 × 630 link-preview image (WhatsApp, LinkedIn, Teams, Discord) |
| `favicon.ico`, `apple-touch-icon.png` | Tab and home-screen icons from the mark |
| `fonts/` | Instrument Sans, copied from `app/fonts/`, with its licence |

If the logo artwork ever changes, update `app/` and here together, then
regenerate the derived images (ImageMagick):

```bash
cd www
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

## Putting it live

Two realistic routes. Both are free.

| | A. Its own repo on GitHub Pages | B. Cloudflare Pages from this folder |
| --- | --- | --- |
| Setup | New repo, copy `www/` in, Pages on, DNS | Connect this repo in Cloudflare, output folder `www` |
| Matches what already works | Yes, the same path as `DEPLOY.md` §2 and §3 | No, a second hosting dashboard to learn |
| Guard steps run before publishing | Yes, copied into that repo's workflow | No, Cloudflare publishes on push without waiting for GitHub Actions |
| Repos to keep | Two | One |

**Recommended: A.** It reuses a process that is already proven for this
domain, keeps the guard in front of every publish, and keeps the suite's
public face separate from one app's release history. The cost is a second
repo and a copied logo and font. Once moved, delete `www/` from this repo
and take it out of the `SCAN_DIRS` lists in `deploy.yml`, so there is one
copy, not two drifting apart.

DNS for route A, when the time comes, follows the same two lessons as
`DEPLOY.md` §3: target the user domain `aibhlinnai.github.io`, and leave
the records **DNS only (grey cloud)** until GitHub has issued the
certificate. For the apex that means GitHub's four `A` records
(`185.199.108.153` to `185.199.111.153`) rather than a `CNAME`, plus a
`www` `CNAME` to `aibhlinnai.github.io` so `www.aibhlinn.ai` redirects to
the apex. Check first whether an `A`, `AAAA` or `CNAME` record already
exists for `aibhlinn.ai` itself. The `MX` records that Cloudflare Email
Routing uses for `support@aibhlinn.ai` also sit on the apex, and must be
left alone.
