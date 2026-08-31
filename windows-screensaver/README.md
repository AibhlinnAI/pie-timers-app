# Pie Timers — Windows screen saver

Shows the live [focus view](../app/app.js) (`?focus=1`) full screen: whichever
timer is next — lunch, end of day, or the next appointment — the same pie,
the same colours, the same live countdown as the app itself. It's a thin
native wrapper, not a second copy of the timer logic: it embeds the real
site via WebView2, so it can never drift out of sync with the web app.

A native Windows app, in C#/.NET — a genuinely different codebase from the
rest of this repo, which is why it lives in its own top-level folder rather
than inside `app/`. See the root `ARCHITECTURE.md` for how this fits
alongside the web app and identity layer.

## Requirements

- Windows 10/11
- [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) —
  already built into Windows 11, and into most up-to-date Windows 10
  machines via Edge auto-update. `install.ps1` doesn't check for this
  separately; if it's genuinely missing, the saver shows a plain "waiting
  for a connection" message instead of the pie rather than crashing.
- .NET 8 SDK, only to build it — `install.ps1` tells you how to get it
  (no admin rights needed) if it isn't already present.

## Install

```powershell
.\install.ps1
```

Builds it, and sets it as your active screen saver (`HKCU:\Control
Panel\Desktop`, per-user, no admin rights). Re-run it any time you pull a
newer version of this folder — it rebuilds and re-points the registry value
in one step.

## Manual build (without installing it as your active saver)

```powershell
dotnet publish -c Release -r win-x64 --self-contained true
copy "bin\Release\net8.0-windows\win-x64\publish\PieTimersScreensaver.exe" "bin\Release\net8.0-windows\win-x64\publish\PieTimersScreensaver.scr"
```

Double-click the `.scr`, or right-click → **Install**, or point **Settings →
Personalisation → Lock screen → Screen saver settings** at it via Browse.

## How Windows talks to it

A `.scr` is a plain `.exe` Windows recognises by extension. It's launched
with one of three arguments:

| Argument | When | What this app does |
| --- | --- | --- |
| `/s` (or nothing) | Idle timeout, or Preview | Full screen, one window per monitor |
| `/c` or `/c:HWND` | "Settings..." button | A small info dialog — nothing to configure |
| `/p HWND` | The thumbnail inside Settings | Overlays that box with a live (small) copy |

Dismissing on input (moving the mouse, a key press, a click) is done with a
low-level system-wide input hook (`SetWindowsHookEx`/`WH_MOUSE_LL`), the
same mechanism every real screen saver uses — a plain WinForms `MouseMove`
handler on the window itself is not enough, because WebView2 hosts a full
Chromium instance that handles input internally and doesn't reliably bubble
those events up to the host window.

## What's verified, and what's worth checking yourself

Built and tested on this machine before being handed over — not just
written and assumed to work:

- **Builds clean.** Zero warnings, zero errors.
- **Full-screen mode** launches correctly across monitors, stays responsive.
- **The Settings dialog** (`/c`) opens and closes correctly.
- **The Settings-dialog preview thumbnail** (`/p`) — this one had a real bug,
  caught and fixed during testing, not just written and hoped for: the
  obvious approach (`SetParent` to truly embed as a child window) does not
  work across process boundaries on Windows, which is exactly what the real
  Settings dialog's preview box is. Confirmed the failure directly, then
  switched to overlaying a normal top-level window positioned over the
  target rectangle instead — confirmed that stays correctly alive while the
  target window exists and closes within half a second of it closing.

Two things I could not get a clean answer on, from *this* environment
specifically, and want you to check the first time you run it for real:

1. **The pie actually loading.** In an earlier session this build environment
   blocked *any* spawned process's network access outright — proved it by
   spawning plain `curl.exe` the same way and watching DNS resolution itself
   time out. In a later session that was no longer true — a clean run got all
   the way through gate.html loading `identity.js`/`entitlements.js` and
   posting `ready`. Inconsistent enough between sessions that it's worth
   confirming on your own machine rather than trusting either result.
2. **Dismissing on mouse movement/keypress.** The input hook installs
   successfully (confirmed non-error handles both times), but synthesized
   input in this same sandboxed environment never reached the callback —
   consistent with the same kind of environment isolation as the network
   block above, not evidence of a code bug, but I can't rule out a subtler
   issue I didn't catch. Move the mouse after the first `/s` launch and
   confirm it closes.

Both are one-second checks. If either doesn't behave as described, that's
worth telling me — it would mean there's a real bug the sandbox hid from me,
not that you did anything wrong.

The screen saver is now Premium-gated (`gate.html`, wired up in
`SaverForm.cs`) — sign in with Google, then the entitlement check against
`can_use_screensaver` decides whether the real pie ever loads. One more
thing to verify live, and this one the sandbox genuinely cannot answer at
all, not even partially:

3. **Google sign-in actually completing inside WebView2.** `gate.html` uses
   `signInWithGoogle()` deliberately, not a magic link, because a magic
   link opens in the system's default browser — a separate process this
   embedded WebView2 instance would never see the redirect from. What's
   untested is the other side of that: whether Google's own anti-phishing
   heuristics treat WebView2's default user agent as an "embedded browser"
   and refuse to complete OAuth there at all (Google has done this to other
   embedded webviews before). If sign-in itself fails or gets blocked
   inside the gate, that's this, not a bug in the entitlement check — the
   fix would be a custom user agent string on the WebView2 instance, or
   moving the OAuth leg out to the system browser with a redirect back in.

## If it crashes instead of showing the fallback

Chased a real crash to ground during testing, worth knowing about if you ever
see the same shape of failure: `EnsureCoreWebView2Async()` threw
`COMException 0x80004004 (E_ABORT)` from deep inside WebView2's own SDK
(`CreateCoreWebView2ControllerAsync`), and — because that path had never been
exercised before — the fallback it fell back to *also* threw
(`Win32Exception: Error creating window handle`), taking the whole process
down instead of showing the black "waiting for a connection" screen it was
supposed to.

Root cause: **26 orphaned `msedgewebview2.exe` processes**, some three days
old, left behind by repeatedly force-killing this app during testing.
`Stop-Process` on the `.exe`/`.scr` only kills that process — WebView2's own
Chromium subprocesses are children that a hard kill never signals to clean up
after themselves, and enough of them piling up over days genuinely exhausts a
Windows session's window-handle quota. If you ever see this: check Task
Manager for `Microsoft Edge WebView2` processes with no obvious parent, end
them, and retry — or just reboot, which clears them all at once.

Hardened `SaverForm.cs`'s fallback path regardless (it now tears down the
broken WebView2 control before trying to show the fallback label, so a
broken sibling control can never drag the fallback down with it) — but that
fix alone did **not** resolve the underlying handle exhaustion once it had
already happened; only clearing the orphaned processes did. Something to
watch for if this ever gets tested in another long-running, heavily-reused
environment.
