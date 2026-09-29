/* ============================================================
   First-open count
   ------------------------------------------------------------
   The one number this app reports about its visitors: that a browser
   opened Pie Timers for the first time, on which day, from which tagged
   link, in the Play app or on the web. privacy.html section 9 says so,
   supabase/schema-visit-counts.sql is where the totals are kept, and
   tools/check-visits.js fails the build if this file sends anything
   more.

   What goes: one POST, once per browser, ever, carrying exactly
   { p_source, p_platform } in its body. Nothing else: no id, no time,
   no user agent (beyond what the browser itself puts in headers), no
   referrer, no credentials. The day is stamped by the database.

   "Already counted" lives only in this browser, under FLAG_KEY, and is
   never sent. Its value is '1' once counted (or never to be counted),
   or 'pending:<source>' while a first open is waiting to be sent.

   LOAD ORDER IS LOAD-BEARING. index.html loads this straight after
   config.js and before sync.js, because sync.js writes
   countdown-timers/device/v1 on EVERY load, first visits included.
   That key, looked at before sync.js runs, is how a browser that used
   the app before this counter existed is recognised and never counted.
   Moved after sync.js, every browser would look new.

   Never counted: Global Privacy Control or Do Not Track; any host but
   pietimers.aibhlinn.ai (localhost, previews, the file:// expo copy);
   automated browsers; storage that cannot be written; config.js with
   countFirstOpens off. #count=off (or ?count=off) marks a browser as
   counted without sending anything: for Mal's own and stall devices.

   Nothing here runs before the page has loaded, nothing is awaited,
   and every failure is silent. It must never be why the app did not
   start. Name no analytics vendor in this file: the deploy guard
   greps app/ for them, and its pattern also matches some ordinary
   identifiers (see the note in deploy.yml before naming a function).
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};
  var cfg = CT.config || {};

  var FLAG_KEY = 'countdown-timers/first-open/v1';
  var PENDING = 'pending:';
  /* Any one of these means this browser has opened the app before. */
  var HISTORY_KEYS = [
    'countdown-timers/device/v1',          // sync.js, written on every load
    'countdown-timers/v1',                 // app.js STORE_KEY
    'countdown-timers/breaks/v1',          // app.js BREAKS_KEY
    'countdown-timers/synced-account/v1',  // sync.js
    'aibhlinn/session/v1'                  // identity.js
  ];
  var HOST = 'pietimers.aibhlinn.ai';
  /* Same shape as the check in schema-visit-counts.sql. */
  var SOURCE_SHAPE = /^[a-z0-9][a-z0-9-]{0,23}$/;
  var AUTOMATED = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|prerender/i;
  var DELAY_MS = 2000;

  /* off | elsewhere | declined | no-storage | counted | pending | sent.
     Read by nothing in the app; there for diagnostics and the tests. */
  var visits = CT.visits = { state: 'off' };

  function noop() {}

  /* A tag from the link: #src=<tag> (preferred: a fragment never
     reaches any server's logs) or ?src=<tag>. Unreadable becomes
     'other', absent becomes ''. Both forms, and count=off, are taken
     off the address bar for everyone, counting or not, so a tag is
     never bookmarked, shared on or cached as its own page. Any other
     query or fragment is left exactly as it was. */
  function readAddress() {
    var found = { source: '', off: false };
    try {
      var query = new URLSearchParams(location.search);
      var hash = location.hash || '';
      var inHash = /^#(src|count)=/.test(hash) ? new URLSearchParams(hash.slice(1)) : null;
      var raw = (inHash && inHash.get('src')) || query.get('src') || '';
      found.off = (inHash && inHash.get('count') === 'off') || query.get('count') === 'off';
      raw = String(raw).trim().toLowerCase();
      found.source = !raw ? '' : SOURCE_SHAPE.test(raw) ? raw : 'other';

      if (inHash || query.has('src') || query.has('count')) {
        query.delete('src');
        query.delete('count');
        var rest = query.toString();
        history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') +
          (inHash ? '' : hash));
      }
    } catch (e) { /* the address keeps its tag; nothing else changes */ }
    return found;
  }

  var nav = window.navigator || {};
  var found = readAddress();

  function setFlag(value) { localStorage.setItem(FLAG_KEY, value); }

  function start() {
    if (found.off) {
      try { setFlag('1'); visits.state = 'counted'; } catch (e) { /* nothing to mark */ }
      return;
    }
    if (!cfg.countFirstOpens || !cfg.isConfigured) return;
    if (location.hostname !== HOST) { visits.state = 'elsewhere'; return; }
    if (nav.globalPrivacyControl === true || nav.doNotTrack === '1' ||
        window.doNotTrack === '1' || nav.msDoNotTrack === '1') {
      visits.state = 'declined';   // nothing read, nothing written
      return;
    }

    try {
      var flag = localStorage.getItem(FLAG_KEY);
      if (flag === null) {
        var before = false;
        for (var i = 0; i < HISTORY_KEYS.length; i++) {
          if (localStorage.getItem(HISTORY_KEYS[i]) !== null) before = true;
        }
        /* Written now, not at send time: someone who scans a code and
           closes the tab at once is still sent on their next open,
           after sync.js has made the device key. */
        flag = before ? '1' : PENDING + found.source;
        setFlag(flag);
      }
      if (flag.indexOf(PENDING) !== 0) { visits.state = 'counted'; return; }
    } catch (e) {
      /* Without a note that lasts, every open would look like a first. */
      visits.state = 'no-storage';
      return;
    }

    visits.state = 'pending';
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later);
  }

  function later() {
    setTimeout(whenSeen, DELAY_MS);
  }

  /* A background tab or a prerender nobody looks at is not an open. */
  function whenSeen() {
    if (document.prerendering) {
      document.addEventListener('prerenderingchange', whenSeen);
      return;
    }
    if (document.visibilityState === 'hidden') {
      document.addEventListener('visibilitychange', function seen() {
        if (document.visibilityState === 'hidden') return;
        document.removeEventListener('visibilitychange', seen);
        send();
      });
      return;
    }
    send();
  }

  function send() {
    try {
      if (nav.onLine === false) return;   // still pending: the next open sends it
      if (!CT.app) return;                // the app never started; still pending

      var flag = localStorage.getItem(FLAG_KEY);
      if (flag === null || flag.indexOf(PENDING) !== 0) return;   // another tab sent it
      /* Marked before it goes, so a browser is never counted twice. A
         request that then fails is one uncounted open, never two. */
      setFlag('1');
      if (nav.webdriver === true || AUTOMATED.test(nav.userAgent || '')) {
        visits.state = 'counted';
        return;
      }
      var source = flag.slice(PENDING.length);
      if (source && !SOURCE_SHAPE.test(source)) source = 'other';

      visits.state = 'sent';
      fetch(cfg.supabaseUrl + '/rest/v1/rpc/count_first_open', {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: 'Bearer ' + cfg.supabaseAnonKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_source: source, p_platform: CT.inPlayApp ? 'play' : 'web' })
      }).catch(noop);
    } catch (e) { /* uncounted, silently */ }
  }

  try { start(); } catch (e) { /* counting must never stop the app */ }
}());
