#!/usr/bin/env node
/* ============================================================
   Makes the QR code the Android home screen widget shows:
   android/app/src/main/res/drawable/widget_qr.xml

   The code is the app's Google Play page and nothing else: no tag, no
   referrer, nothing that says who scanned it or whose phone showed it.
   It never changes, so it is drawn once here, with the same vendored
   generator the Settings tab uses (app/qrcode.js), and shipped as a
   picture. The Android app then needs no QR library.

   Run:  node tools/make-widget-qr.js
   Run it again only if the address below changes.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const qrcode = require('../app/qrcode.js');

const URL = 'https://play.google.com/store/apps/details?id=ai.aibhlinn.pietimers';
const QUIET = 4;   // the blank margin the QR standard asks for, in modules

const qr = qrcode(0, 'M');
qr.addData(URL);
qr.make();
const n = qr.getModuleCount();
const size = n + QUIET * 2;

// One rectangle per run of dark modules in a row.
let d = '';
for (let r = 0; r < n; r++) {
  for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    let run = 1;
    while (c + run < n && qr.isDark(r, c + run)) run++;
    d += 'M' + (c + QUIET) + ',' + (r + QUIET) + 'h' + run + 'v1h-' + run + 'z';
    c += run;
  }
}

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by tools/make-widget-qr.js. Do not edit by hand.
     ${URL} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${size}dp"
    android:height="${size}dp"
    android:viewportWidth="${size}"
    android:viewportHeight="${size}">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M0,0h${size}v${size}h-${size}z" />
    <path
        android:fillColor="#000000"
        android:pathData="${d}" />
</vector>
`;

const out = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'widget_qr.xml');
fs.writeFileSync(out, xml);
console.log('Wrote ' + path.relative(process.cwd(), out) + ': ' + n + ' modules a side, ' + xml.length + ' characters.');
