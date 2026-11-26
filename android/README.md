# Pie Timers for Android (WebView)

The Android app on Google Play from release 4 (version code 4, 1.0.3). It is
the website, `https://pietimers.aibhlinn.ai/index.html`, in a WebView.
Releases 1 to 3 were a Trusted Web Activity made on PWABuilder's website, so
the PWABuilder routine in `DEPLOY.md` section 9 does not build this app.
Its Play Console steps, bundle checks and phone check still apply.

## What the app adds to the website

- A splash screen until the first page has drawn (at most 4 seconds).
- An offline screen with **Try again**, for when the very first page cannot
  load. After one successful load the site's service worker opens it offline.
- **Back** walks the page's history, then leaves the app.
- The system bars and the keyboard are kept off the page (Android 15 and
  later draw apps edge to edge).
- **Import settings** opens Android's file picker; **Export settings** opens
  its save dialog.
- Links to `https://pietimers.aibhlinn.ai` open in the app; every other link
  opens outside it.
- From release 7: milestone alerts as phone notifications, including while
  the app is closed (see "Phone notifications" below).

## The two contracts with the website

**The user agent.** The app adds ` PieTimersAndroid/<version code>` to its
user agent. The site reads it (`WEBVIEW_UA` in `app/app.js`) to hide prices,
checkout and Google sign-in. Change the spelling and prices come back inside
the Play app.

**The notification bridge**, from release 7. The app gives the page an object
called `PieTimersAndroidPush`, and `app/notify.js` uses it in place of the
Notification and Push APIs a WebView lacks. The site decides by whether the
object is there, not by the version code: releases 4 to 6 have none, and the
site tells them to update. Its four methods:

| Method | What it does |
| --- | --- |
| `permission()` | Returns `"granted"` or `"denied"` straight away |
| `request()` | Shows Android's notification prompt if it still can, then answers |
| `token()` | Answers without a prompt |
| `show(title, body, tag)` | Shows a phone notification now |

`request()` and `token()` answer by calling `window.PieTimersPushResult` in
the page with `{ permission, token }`, where `token` is the phone's Firebase
device token or `null`. Rename the object, a method or that function on one
side only and notifications stop with no error.

**The widget bridge**, not yet in a release. The app gives the page an
object called `PieTimersAndroidWidget` with one method, `set(json)`, and the
page gives the app a function, `window.PieTimersWidgetRefresh`. See "The
home screen widget" below. Rename either on one side only and the widget
stops updating with no error.

## The home screen widget (not yet in a release)

Up to three pies on the phone's home screen, the same three as the
Dashboard: the next break or lunch, the end of the day and the next
appointment. Each has its name above and the time left below. The corner
says "Pie Timers | AibhlínnAI".

- **Sizes.** It starts four cells wide and two tall, which shows all three
  pies. It can be dragged down to two by two, or made larger. A narrower
  widget shows fewer pies: those still counting down first, soonest first.
- **Tap a pie** to open the app. **Tap the name in the corner** to turn the
  widget over to a QR code for the app's Google Play page, and tap again to
  turn it back. A swipe was asked for and cannot be built: a home screen
  keeps sideways swipes for moving between its own pages, so a widget never
  sees one.
- **The QR code** is the plain Play address with nothing added: no tag and
  no referrer. It is a picture made once by `tools/make-widget-qr.js`, drawn
  as it is on the back of the conference shirt: plum squares on a cream
  tile. Under it is the shirt's line, "sometimes you eat the pie…".
- **Colours** (the owner, 26 Nov 2026: "B but on the shirt purple"). The
  ground is the shirt's purple and the numbers its cream. Each pie sits on
  the icon's green plate with a rim. The pies keep the app's meaning for
  colour (purple for a break, green for the end of the day, orange for an
  appointment), each lightened until it stands out on the green plate. They
  are in `res/values/colors.xml`. These colours compile and have not yet
  been seen on a phone.
- **The app holds no timer maths.** A widget is drawn by Android while the
  app is closed, so it cannot ask the page anything. The page works out the
  next seven days (`widgetSnapshot` in `app/app.js`) and hands them to
  `PieTimersAndroidWidget.set`; `PieWidget.java` only draws how far along
  each pie is. `tools/widget-sim.js` checks the page's half against the
  Dashboard's own functions.
- **When it is handed over:** as the app leaves the screen, and once an
  hour while it stays open. So the widget is seven days ahead of the last
  time the app was on screen. After seven days without opening the app it
  says "Open Pie Timers", and opening the app once brings it back. A
  calendar event that arrives while the app is closed is not on the widget
  until the app is next opened.
- **Once a minute.** `PieWidget` keeps an alarm that never wakes a sleeping
  phone and needs no permission. Android may run it a little late.
- **Nothing leaves the phone.** The week is kept in the app's own private
  storage, which is left out of backups like everything else here.
- **Free.** It works on one device with no account, so it is not a Premium
  feature.
- **Seen on one phone** (26 Nov 2026: a Pixel 6 on Android 17, whose home
  screen is five cells wide, test build). At four cells by two and at three
  by two it showed all three pies; at two by two it showed the two soonest.
  The corner tap to the QR code and back, a tap on a pie opening the app,
  and the minute by minute update all worked. The week was handed to the
  app through the debugging port, because the live site did not have
  `widgetSnapshot` yet. Still to check: the QR code read by another phone's
  camera, taller sizes, and the app handing the week over by itself once
  the site has the new code.

## Phone notifications (release 7 on)

- **While the app is running**, the page raises each alert and the app shows
  it (`show`). Silent while the app is on screen, where the page has its own
  toast and chime.
- **While it is closed**, the site's `notify-milestones` function sends the
  alert through Firebase Cloud Messaging and `PushService` shows it. That
  needs an account, Premium, and both Milestone alerts and Background alerts
  switched on, as it does in a browser.
- **Once each.** Both carry the same tag, and `Notifier` remembers the tags it
  has shown, so a milestone is never shown twice.
- **Nothing is registered until it is asked for.** Firebase auto-init is off
  in the manifest. The phone gets a device token only when someone switches
  Background alerts on, and the page saves it against their account.
- **No Analytics.** The only Firebase library is `firebase-messaging`.
- A replaced token is picked up the next time the app opens. Until then
  closed-app alerts to that phone stop.

## Firebase (the owner only)

The build needs `app/google-services.json` from the Firebase project, and it
is **not in this repo**: it holds an API key, and this repo is public. Keep
it in the private packages folder beside the upload key, and copy it into
the build copy after the `robocopy` step:

```powershell
Copy-Item "<private packages folder>\google-services.json" "$src\app\"
```

The file must list both package names, `ai.aibhlinn.pietimers` and
`ai.aibhlinn.pietimers.debug`, or the test build stops with "No matching
client found". Without the file every build stops with "File
google-services.json is missing". The server's half is `DEPLOY.md` §7.1.

## Building (Windows)

Needs Java 17 and the Android SDK (platform 36, build-tools 36.1), with
`ANDROID_HOME` set to the SDK folder. The Gradle wrapper fetches Gradle
9.8.2 and checks its checksum.

Google Drive puts a hidden `desktop.ini` in every folder, and the Android
resource compiler refuses it, so build from a copy on local disk:

```powershell
$src = "$env:LOCALAPPDATA\pie-timers-android-src"
robocopy "<this folder>" $src /MIR /XF desktop.ini google-services.json /XD .gradle build .kotlin
Copy-Item "<private packages folder>\google-services.json" "$src\app\"
cd $src
.\gradlew.bat assembleDebug bundleRelease
```

A shell started from inside a packaged (MSIX) Windows app, such as the
Claude desktop app, sees a private copy of `%LOCALAPPDATA%`: anything it
installs or builds there is invisible to an ordinary terminal, and the
other way round. Use one kind of shell for the SDK, the build and the
signing, or give the SDK a folder outside AppData.

Output lands under `%LOCALAPPDATA%\pie-timers-android-build\app\outputs\`:

- `apk\debug\app-debug.apk`: a test build. Its package ends in `.debug`
  and it is called "Pie Timers test", so it installs beside the Play app.
- `bundle\release\app-release.aab`: unsigned. It must be signed before Play
  will take it.

## Signing (the owner only)

The upload key and its passwords never come near this folder, a chat or a
screenshot. Copy `app-release.aab` into a new numbered folder in the private
packages folder, then from that folder:

```powershell
jarsigner -keystore "<previous package folder>\signing.keystore" app-release.aab my-key-alias
```

`jarsigner` asks for the two passwords itself. Before uploading, check the
signed bundle against the last one Play accepted (Git Bash, no password;
work on copies of the two `.aab` files in an empty folder, never on the
package folders, which hold the key):

```bash
AAB=new.aab; PREV=previous.aab
# Signed: expect META-INF/MANIFEST.MF, one .SF and one .RSA
unzip -Z1 "$AAB" | grep '^META-INF/'
# Same upload key as before: expect "same key"
fp() { unzip -p "$1" 'META-INF/*.RSA' | openssl pkcs7 -inform DER -print_certs | openssl x509 -noout -fingerprint -sha256; }
[ -n "$(fp "$AAB")" ] && [ "$(fp "$AAB")" = "$(fp "$PREV")" ] && echo "same key" || echo "NOT the same key: do not upload"
# Right app and version: package, versionCode, versionName, min and target SDK
unzip -p "$AAB" base/manifest/AndroidManifest.xml | LC_ALL=C tr -cs '[:print:]' '\n' \
  | grep -A1 -E '^(package|versionCode|versionName|minSdkVersion|targetSdkVersion)$' | grep -v '^--$' | paste - -
```

Each value printed by the last check ends in a stray character or two; it
reads the file's text, not the compiled numbers.

## Three things the app tells the site

- **First opens.** On Google's pre-launch test devices, and on a tester's
  first launch after updating from the TWA, the app opens the site with
  `#count=off`, so `app/visits.js` does not count a first open that is not a
  person's. A new install still counts.
- **Moved from the old app.** That first launch after the update also
  carries `moved=1` (`#count=off&moved=1`). The TWA kept the week in
  Chrome's storage, which this app cannot read, so the site shows a panel
  with the steps to bring it across: Export settings in Chrome, Import
  settings here.
- **Backups.** There are none: `allowBackup` is off and
  `data_extraction_rules.xml` excludes everything from cloud backup and
  device transfer, because the WebView's storage holds the schedule and
  the sign-in session.
