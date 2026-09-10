# Brand assets for third parties

Files here are **not** served by the app. They exist to be uploaded by
hand into somebody else's dashboard, where the size is fixed by them.

| File | Where it goes | Constraint |
|---|---|---|
| `pie-timers-oauth-120.png` | Google Cloud → OAuth consent screen → App logo | 120×120 PNG |

## Colours

| Name | Hex | What it is |
|---|---|---|
| Brand blue | `#050818` | The suite colour — near-black with a blue cast. Set as the AibhlínnAI Discord banner colour, which is the reference. Use it as a ground (the logo sits on it) and on dark surfaces. On white it collapses to near-black — use the light-backdrop variant below instead. |
| Brand blue, white backdrop | `#2E3A63` | The on-light variant: the same hue lifted until it reads as blue against white. This is the "AibhlínnAI" wordmark colour on a light surface — the sign-in email (`DEPLOY.md` §6.4), and anywhere else the mark sits on white. Mixed case always — `AibhlínnAI`, never all-caps. |
| Pie Timers purple | `#1C1024` | This *app's* colour, not the suite's — the app background, the PWA `theme-color`, and the OAuth tile below. `#4B2A5A` is the lighter tint. A second suite app picks its own app colour and keeps the blue wordmark. |

## pie-timers-oauth-120.png

Downscaled from `app/icon-512.png` with high-quality bicubic
interpolation onto a filled purple square, with 6px of padding so the
mark is not flush to the edge.

Filled rather than transparent on purpose. Google draws the logo on a
white panel, where a transparent PNG leaves the mark floating with no
brand around it -- and the pie itself is pale enough to lose its edges.
A purple tile reads as a deliberate app icon at 120px.

Background is `#1C1024` -- the app background, and the `theme-color`
already declared in index.html. Chosen over the lighter `--purple`
(`#4B2A5A`) so the consent screen matches the colour a browser paints
around the installed app: one purple in both places rather than two.

**Uploading it starts a Google brand verification review.** That is not
a formality: it can take days, occasionally weeks, and until it passes
Google may keep showing the unbranded consent screen anyway. Worth doing
before launch, not worth blocking on.

Regenerate after any change to the icon:

```powershell
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("app\icon-512.png")
$bmp = New-Object System.Drawing.Bitmap 120, 120
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.ColorTranslator]::FromHtml("#1C1024"))
$g.DrawImage($img, 6, 6, 108, 108)   # 6px inset; Google may round corners
$bmp.Save("brand\pie-timers-oauth-120.png", [System.Drawing.Imaging.ImageFormat]::Png)
```
