#!/usr/bin/env node
/* ============================================================
   Does identity/email-typos.js catch the slips, and leave real
   addresses alone?

   Two lists. The first is what should be offered a fix: the
   "…@gmail.comj" that stranded a tester on 24 September 2026, and
   the slips around it. The second is what must NOT be: real
   providers a letter away from a common one, country endings, and
   work and school domains. The second list matters as much as the
   first -- a prompt that fires on real addresses teaches people to
   tap past it.

   Every address here is made up. Never paste a tester's real
   address into this file; the repo is public.

   Run: node tools/check-email-typos.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'identity', 'email-typos.js');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'identity/email-typos.js' });
const suggest = sandbox.window.Aibhlinn.emailTypos.suggest;

/* [typed, expected suggestion] */
const FIXES = [
  // The ending, on the right name
  ['sam@gmail.comj', 'sam@gmail.com'],
  ['sam@gmail.co', 'sam@gmail.com'],
  ['sam@gmail.cm', 'sam@gmail.com'],
  ['sam@gmail.om', 'sam@gmail.com'],
  ['sam@gmail.con', 'sam@gmail.com'],
  ['sam@gmail.cmo', 'sam@gmail.com'],
  ['sam@gmail.comm', 'sam@gmail.com'],
  ['sam@gmail.com.', 'sam@gmail.com'],
  ['sam@gmail..com', 'sam@gmail.com'],
  ['sam@gmail,com', 'sam@gmail.com'],
  ['sam@gmail. com', 'sam@gmail.com'],
  ['sam@gmail.com.au', 'sam@gmail.com'],
  ['sam@gmail.co.au', 'sam@gmail.com'],
  ['sam@gmail.org', 'sam@gmail.com'],
  ['sam@gmailcom', 'sam@gmail.com'],
  ['sam@gmail', 'sam@gmail.com'],
  ['sam@googlemail.co', 'sam@googlemail.com'],
  ['sam@hotmail.comj', 'sam@hotmail.com'],
  ['sam@hotmail.co', 'sam@hotmail.com'],
  ['sam@hotmail.cmo', 'sam@hotmail.com'],
  ['sam@hotmail.com.a', 'sam@hotmail.com.au'],
  ['sam@hotmailcom', 'sam@hotmail.com'],
  ['sam@hotmailcomau', 'sam@hotmail.com.au'],
  ['sam@outlook.comau', 'sam@outlook.com.au'],
  ['sam@outlook.com.a', 'sam@outlook.com.au'],
  ['sam@outlook.con.au', 'sam@outlook.com.au'],
  ['sam@outlook.comm.au', 'sam@outlook.com.au'],
  ['sam@outlook.co', 'sam@outlook.com'],
  ['sam@live.comj', 'sam@live.com'],
  ['sam@live.co', 'sam@live.com'],
  ['sam@live.com.a', 'sam@live.com.au'],
  ['sam@icloud.co', 'sam@icloud.com'],
  ['sam@icloud.com.au', 'sam@icloud.com'],
  ['sam@yahoo.co', 'sam@yahoo.com'],
  ['sam@yahoo.cm', 'sam@yahoo.com'],
  ['sam@bigpond.con', 'sam@bigpond.com'],
  ['sam@bigpond.net', 'sam@bigpond.net.au'],
  ['sam@bigpond.net.a', 'sam@bigpond.net.au'],
  ['sam@optusnet.com', 'sam@optusnet.com.au'],
  ['sam@iinet.net', 'sam@iinet.net.au'],
  ['sam@me.comj', 'sam@me.com'],

  // The name
  ['sam@gmial.com', 'sam@gmail.com'],
  ['sam@gamil.com', 'sam@gmail.com'],
  ['sam@gmal.com', 'sam@gmail.com'],
  ['sam@gmai.com', 'sam@gmail.com'],
  ['sam@gmaill.com', 'sam@gmail.com'],
  ['sam@gnail.com', 'sam@gmail.com'],
  ['sam@gmial.co', 'sam@gmail.com'],
  ['sam@gmial', 'sam@gmail.com'],
  ['sam@googlemial.com', 'sam@googlemail.com'],
  ['sam@hotmial.com', 'sam@hotmail.com'],
  ['sam@hotmal.com', 'sam@hotmail.com'],
  ['sam@hotamil.com', 'sam@hotmail.com'],
  ['sam@homtail.com', 'sam@hotmail.com'],
  ['sam@hotmial.com.au', 'sam@hotmail.com.au'],
  ['sam@hotmial.co', 'sam@hotmail.com'],
  ['sam@outlok.com', 'sam@outlook.com'],
  ['sam@outllok.com', 'sam@outlook.com'],
  ['sam@oulook.com', 'sam@outlook.com'],
  ['sam@otlok.com', 'sam@outlook.com'],
  ['sam@outlok.com.au', 'sam@outlook.com.au'],
  ['sam@iclod.com', 'sam@icloud.com'],
  ['sam@icoud.com', 'sam@icloud.com'],
  ['sam@icluod.com', 'sam@icloud.com'],
  ['sam@yaho.com', 'sam@yahoo.com'],
  ['sam@yhaoo.com', 'sam@yahoo.com'],
  ['sam@yahooo.com.au', 'sam@yahoo.com.au'],
  ['sam@bigpnd.com', 'sam@bigpond.com'],
  ['sam@bigpong.com', 'sam@bigpond.com'],
  ['sam@optusnet.com.a', 'sam@optusnet.com.au'],

  // Only the domain changes; the rest comes back as typed
  ['Sam.Lee+pie@GMAIL.COMJ', 'Sam.Lee+pie@gmail.com'],
  ['  sam@gmail.comj  ', 'sam@gmail.com'],
];

const LEAVE = [
  // Right already, in any case
  'sam@gmail.com', 'sam@GMAIL.COM', 'sam@googlemail.com',
  'sam@hotmail.com', 'sam@hotmail.com.au', 'sam@hotmail.co.uk',
  'sam@outlook.com', 'sam@outlook.com.au', 'sam@live.com', 'sam@live.com.au',
  'sam@icloud.com', 'sam@me.com', 'sam@mac.com',
  'sam@yahoo.com', 'sam@yahoo.com.au', 'sam@bigpond.com',
  'sam@bigpond.com.au', 'sam@bigpond.net.au', 'sam@telstra.com',
  'sam@optusnet.com.au', 'sam@iinet.net.au', 'sam@internode.on.net',
  'sam@westnet.com.au', 'sam@ozemail.com.au', 'sam@tpg.com.au',

  // Real providers a letter or two from a common one
  'sam@mail.com', 'sam@email.com', 'sam@ymail.com', 'sam@rocketmail.com',
  'sam@gmx.com', 'sam@gmx.net', 'sam@gmx.de', 'sam@aol.com', 'sam@aol.co.uk',
  'sam@msn.com',

  // Country endings a provider really uses, listed here or not
  'sam@yahoo.ca', 'sam@live.ca', 'sam@hotmail.fr', 'sam@hotmail.gr',
  'sam@hotmail.de', 'sam@hotmail.it', 'sam@hotmail.co.jp', 'sam@yahoo.co.in',
  'sam@yahoo.com.sg', 'sam@outlook.fr', 'sam@live.com.mx', 'sam@icloud.com.cn',

  // Work, school and government, including near neighbours of a provider name
  'sam@example.com', 'sam@aibhlinn.ai', 'sam@sa.gov.au',
  'sam@student.adelaide.edu.au', 'sam@education.nsw.gov.au',
  'sam@live.unisa.edu.au', 'sam@mymail.unisa.edu.au', 'sam@tpg.com',
  'sam@telstra.com.au', 'sam@love.com.au', 'sam@aon.com', 'sam@outlook.net.au',

  // Not an address; nothing to offer, and nothing may throw
  '', '   ', 'sam', 'sam@', '@gmail.com', 'sam@@', null, undefined,
];

let failures = 0;

let caught = 0;
for (const [typed, want] of FIXES) {
  const got = suggest(typed);
  if (got !== want) {
    console.error(`FAIL  ${JSON.stringify(typed)} → ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    failures++;
    continue;
  }
  /* Taking the suggestion must end the conversation. A fix that
     itself draws a fix would ask the same person twice. */
  const again = suggest(got);
  if (again !== null) {
    console.error(`FAIL  ${JSON.stringify(got)} (itself a suggestion) → ${JSON.stringify(again)}, wanted null`);
    failures++;
    continue;
  }
  caught++;
}
console.log(`ok    ${caught} of ${FIXES.length} slips offered the right fix`);

let quiet = 0;
for (const typed of LEAVE) {
  let got;
  try {
    got = suggest(typed);
  } catch (err) {
    console.error(`FAIL  ${JSON.stringify(typed)} threw: ${err.message}`);
    failures++;
    continue;
  }
  if (got !== null) {
    console.error(`FAIL  ${JSON.stringify(typed)} → ${JSON.stringify(got)}, wanted null`);
    failures++;
    continue;
  }
  quiet++;
}
console.log(`ok    ${quiet} of ${LEAVE.length} real or invalid addresses left alone`);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nEvery slip is caught and every real address is left alone.');
