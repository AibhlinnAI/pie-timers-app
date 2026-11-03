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

## The one contract with the website

The app adds ` PieTimersAndroid/<version code>` to its user agent. The site
reads it (`WEBVIEW_UA` in `app/app.js`) to hide prices, checkout and Google
sign-in, and to stop offering system notifications. Change the spelling and
prices come back inside the Play app.

## Building (Windows)

Needs Java 17 and the Android SDK (platform 36, build-tools 36.1), with
`ANDROID_HOME` set to the SDK folder. The Gradle wrapper fetches Gradle
9.8.2 and checks its checksum.

Google Drive puts a hidden `desktop.ini` in every folder, and the Android
resource compiler refuses it, so build from a copy on local disk:

```powershell
$src = "$env:LOCALAPPDATA\pie-timers-android-src"
robocopy "<this folder>" $src /MIR /XF desktop.ini /XD .gradle build .kotlin
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
