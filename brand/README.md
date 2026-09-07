# Brand assets for third parties

Files here are **not** served by the app. They exist to be uploaded by
hand into somebody else's dashboard, where the size is fixed by them.

| File | Where it goes | Constraint |
|---|---|---|
| `pie-timers-oauth-120.png` | Google Cloud → OAuth consent screen → App logo | 120×120 PNG |

## pie-timers-oauth-120.png

Downscaled from `app/icon-512.png` with high-quality bicubic
interpolation, alpha preserved (colour type 6). 4,990 bytes.

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
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($img, 0, 0, 120, 120)
$bmp.Save("brand\pie-timers-oauth-120.png", [System.Drawing.Imaging.ImageFormat]::Png)
```
