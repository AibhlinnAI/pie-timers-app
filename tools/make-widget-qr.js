#!/usr/bin/env node
/* ============================================================
   Makes the two QR codes the Android home screen widget shows, in
   android/app/src/main/res/drawable/:
     widget_qr_pie.xml   the app's Google Play page
     widget_qr_ai.xml    aibhlinn.ai

   Each is its address and nothing else: no tag, no referrer, nothing
   that says who scanned it or whose phone showed it. They never change,
   so they are drawn once here, with the same vendored generator the
   Settings tab uses (app/qrcode.js), and shipped as pictures. The
   Android app then needs no QR library.

   Run:  node tools/make-widget-qr.js
   Run it again only if an address below changes.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const qrcode = require('../app/qrcode.js');

const CODES = [
  ['widget_qr_pie.xml', 'https://play.google.com/store/apps/details?id=ai.aibhlinn.pietimers'],
  ['widget_qr_ai.xml', 'https://aibhlinn.ai'],
];
const QUIET = 4;   // the blank margin the QR standard asks for, in modules

for (const [FILE, URL] of CODES) {
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

// Drawn the way the conference shirt's QR is: plum squares on a cream
// tile with rounded corners (the shirt's tile is 280 across with corners
// of 14, so a twentieth of its width). Dark on light, never the other way
// round, because some phone scanners cannot read an inverted code.
const CREAM = '#F6D7B0';
const PLUM = '#2E1838';
const r = size / 20;
const tile = 'M' + r + ',0h' + (size - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
  'v' + (size - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 -' + r + ',' + r +
  'h-' + (size - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 -' + r + ',-' + r +
  'v-' + (size - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',-' + r + 'z';

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by tools/make-widget-qr.js. Do not edit by hand.
     ${URL} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${size}dp"
    android:height="${size}dp"
    android:viewportWidth="${size}"
    android:viewportHeight="${size}">
    <path
        android:fillColor="${CREAM}"
        android:pathData="${tile}" />
    <path
        android:fillColor="${PLUM}"
        android:pathData="${d}" />
</vector>
`;

const out = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', FILE);
fs.writeFileSync(out, xml);
console.log('Wrote ' + path.relative(process.cwd(), out) + ': ' + n + ' modules a side, ' + xml.length + ' characters.');
}
