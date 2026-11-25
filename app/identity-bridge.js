/* ============================================================
   Pie Timers' own glue for the shared identity/entitlements modules.

   This file is the ONLY place in Pie Timers that says "pie-timers" as
   a product string. Everything upstream (identity/*.js) has no
   idea which app is calling; everything downstream (the rest
   of app.js) never sees a product string at all, and asks
   hasCapability('can_sync') via CT.entitlements, a thin product-scoped
   wrapper defined below.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};
  var cfg = CT.config;
  var PRODUCT_ID = 'pie-timers';

  /* "Did you mean …@gmail.com?" for app.js's own two email forms; the
     shared sign-in panel asks it directly. Above the early return
     because the tester invite is not an account feature. */
  CT.emailTypos = window.Aibhlinn && window.Aibhlinn.emailTypos;

  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return; // no account features configured

  /* Poll rather than use a callback: CT.turnstile owns the widget's
     callbacks already, and token() is the single place that knows
     whether one has arrived. */
  function waitForToken(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      (function poll() {
        var token = CT.turnstile.token();
        if (token || Date.now() > deadline) return resolve(token || '');
        setTimeout(poll, 200);
      }());
    });
  }

  /* init() consumes the magic-link hash and returns whatever was found.
     Keeping that result is what lets CT.auth.consumeRedirect() report a redirect
     error to sync.js without sync.js knowing identity exists -- and the value
     must be kept rather than re-read, because a hash can only be
     consumed once. */
  CT.pendingIdentityRedirect = window.Aibhlinn.identity.init({
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey,
    redirectUrl: cfg.redirectUrl || null,

    /* ── One protected sign-in path ──────────────────────────────
       identity's own signInWithEmail posts straight to Supabase's
       /auth/v1/otp, which has nowhere to put a bot check or a
       throttle. Pie Timers has both, in the `signin` edge function:
       Turnstile, then per-email and per-IP limits in Postgres, then
       Supabase's own limits behind that. Until this delegate existed
       the header panel bypassed all three while the Account tab's
       form used them -- two sign-in routes, one of them an open relay
       for emailing strangers at the expense of our sending quota and
       the domain's reputation.

       prepareSignIn draws the check when the panel opens, so the
       person is not left waiting on a widget after they have already
       pressed the button. CT.turnstile lives in billing.js, which
       loads after this file, so both hooks resolve the reference lazily at call
       time rather than capturing one here. */
    prepareSignIn: function (challengeHost) {
      if (!cfg.turnstileEnabled || !CT.turnstile) return Promise.resolve(false);
      return CT.turnstile.mount(challengeHost);
    },

    signIn: function (email, ctx) {
      if (!cfg.turnstileEnabled || !CT.turnstile) return CT.auth.signInWithEmail(email, '');

      /* Bounded. mount() waits on a third-party script, and a network
         that hangs rather than fails would leave the button on
         "Sending…" forever with nothing to press -- worse than an
         unchecked sign-in and impossible to diagnose from the outside. */
      var mounted = Promise.race([
        CT.turnstile.mount(ctx && ctx.challengeHost),
        new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 8000); })
      ]);

      return mounted.then(function () {
        /* The widget is drawn when the panel opens, but a token only
           arrives once Cloudflare finishes -- and someone typing an
           email address fast can beat the check. Wait a few seconds rather
           than standing aside the moment nothing is ready, so the
           checked path is the normal one and not a race. */
        return waitForToken(6000);
      }).then(function (token) {
        if (token) {
          return CT.auth.signInWithEmail(email, token).then(function (result) {
            CT.turnstile.reset();   // tokens are single-use
            return result;
          });
        }

        /* Still nothing. Fall through to identity's own path rather
           than refusing: a bot check that will not complete must not
           become a sign-in nobody can complete. That request is
           unchecked -- the state the app was in before this delegate
           existed -- so nothing new is exposed, but this is not where the
           ends either. Loud on purpose: silence is how the unchecked
           path survived unnoticed in the first place. */
        console.warn('Turnstile produced no token in time; signing in without ' +
                     'the bot check. See identity-bridge.js.');

        /* Ask `signin` anyway before going round it. It answers the store
           review address without a bot check and sends that address
           nothing; identity's own path would email it, and within a minute
           of a review sign-in Supabase refuses that email outright, which
           leaves the reviewer with no code box. For everyone else signin
           refuses an empty token with a 403, and identity's own path runs
           exactly as before. */
        return CT.auth.signInWithEmail(email, '').catch(function (err) {
          if (err && err.status === 403) return null;   // null tells identity to use its own path
          throw err;
        });
      });
    },

    /* ── The store review account ───────────────────────────────
       Google Play's reviewers cannot read an inbox, so the one account
       they use also takes a fixed code, checked by the `review-signin`
       edge function. identity calls this only once Supabase has refused
       a code.

       That code is ten digits and an emailed one is eight, so anything
       else stops here: a real person's mistyped code never leaves for the
       function, and their error appears as fast as it always did.
       Resolved lazily, like signIn above: supabase.js loads after this
       file. */
    verifyCode: function (email, code) {
      if (!/^\d{10}$/.test(String(code || '').replace(/[\s-]+/g, ''))) return null;
      if (!CT.auth || typeof CT.auth.verifyReviewCode !== 'function') return null;
      return CT.auth.verifyReviewCode(email, code);
    }
  });

  window.Aibhlinn.entitlements.init({
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey
  });

  // Pie Timers-scoped entitlement checks, so the rest of the app never
  // has to know the product id or import the suite module directly.
  CT.entitlements = {
    hasCapability: function (capability) {
      return window.Aibhlinn.entitlements.hasCapability(PRODUCT_ID, capability);
    },
    refresh: function () { return window.Aibhlinn.entitlements.refresh(); }
  };

  /* ── Plan status in the header ───────────────────────────────────
     What a signed-in person sees, left to right (owner, 25 Nov 2026):

       free trial running   →  a quiet badge, "Day 3 of 14", and to the
         right of that badge the Get Premium button. While the launch
         offer is open the button carries one more line, "Pay nothing
         until 2027". Until 25 Nov 2026 the button stayed hidden until
         four days were left; the launch offer rewards subscribing
         during the trial, so hiding the button hid the offer.

       trial ended          →  the Get Premium button alone, no extra
         line: someone whose trial has ended pays on the day.

       entitled             →  a bordered badge. Status, not an offer.

     The button and the entitled badge are always the last thing in the
     slot, so neither changes place from one state to the next; the
     trial badge is only ever added to the left.

     Read from CT.billing, so the header cannot disagree with the panel
     further down the page. */
  var TRIAL_DAYS = 14;
  /* The same instant as FOUNDATION_CLOSES on pricing.html: the end of
     31 December 2026 anywhere on Earth. If the offer's date moves, move
     this one too (CLAUDE.md lists the others). */
  var OFFER_CLOSES = Date.UTC(2027, 0, 1, 12, 0);

  function daysLeft(ent) {
    if (!ent.currentPeriodEnd) return null;
    var ms = new Date(ent.currentPeriodEnd).getTime() - Date.now();
    return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
  }

  function mark() {
    var img = document.createElement('img');
    img.src = 'aibhlinn-mark-40.png';
    img.alt = '';                 // decorative; the label alongside carries the meaning
    img.className = 'ai-mark';
    img.width = 20;
    img.height = 20;
    return img;
  }

  /* Every slot the chip has been drawn into. identity-ui calls
     renderStatus once, when drawing the signed-in header -- but the
     entitlement is not known then. CT.billing.get() answers from a
     default of "not entitled" until refresh() returns, so the first
     draw of a complimentary or paid account was the Get Premium
     button, and nothing ever came back to correct that.

     Slots are kept rather than re-mounted so sign-out is untouched,
     and detached ones are dropped as they are found: identity-ui
     rebuilds its wrapper on every auth change, which orphans the old
     span without telling anyone. */
  var statusSlots = [];

  /* "Day 3 of 14". Every trial is 14 days long, counted back from the
     day the trial finishes, which also holds for the accounts whose
     trial was restarted on 22 Nov 2026. Any other length (none exists
     today) gets the plain words. */
  function trialBadge(left) {
    var node = document.createElement('span');
    node.className = 'plan-chip plan-chip--trial';
    var main = document.createElement('span');
    main.className = 'plan-chip-main';
    main.appendChild(mark());
    main.appendChild(document.createTextNode('Free Trial'));
    node.appendChild(main);
    /* One day over is a device clock running behind the server on a new
       account, and is still day 1. */
    if (left !== null && left >= 1 && left <= TRIAL_DAYS + 1) {
      node.className += ' plan-chip--tagged';
      var tag = document.createElement('span');
      tag.className = 'plan-chip-tag';
      tag.textContent = 'Day ' + Math.max(1, TRIAL_DAYS - left + 1) + ' of ' + TRIAL_DAYS;
      node.appendChild(tag);
    }
    return node;
  }

  function offerButton(withTagline) {
    var node = document.createElement('a');
    node.className = 'plan-chip plan-chip--offer';
    node.href = 'pricing.html';
    var main = document.createElement('span');
    main.className = 'plan-chip-main';
    main.appendChild(document.createTextNode('Get '));
    main.appendChild(mark());
    main.appendChild(document.createTextNode('Premium'));
    node.appendChild(main);
    if (withTagline) {
      node.className += ' plan-chip--tagged';
      var tag = document.createElement('span');
      tag.className = 'plan-chip-tag';
      tag.textContent = 'Pay nothing until 2027';
      node.appendChild(tag);
    }
    return node;
  }

  function drawPlanStatus(container) {
    container.innerHTML = '';

    if (!CT.billing || !CT.billing.enabled()) return;

    var ent = CT.billing.get();
    /* Plan 'trial' is the account's own free trial. Status 'trialing' is
       not enough: Paddle reports it too for someone who has subscribed
       and is waiting for their first payment, and they are Premium. */
    var trialing = ent.plan === 'trial' && ent.entitled;
    var left = daysLeft(ent);
    var node;

    if (ent.entitled && !trialing) {
      node = document.createElement('span');
      node.className = 'plan-chip plan-chip--premium';
      node.appendChild(mark());
      node.appendChild(document.createTextNode('AibhlínnAI Premium'));
    } else if (CT.inPlayApp) {
      /* The Play app is consumption-only (app.js, IN_PLAY_APP): the
         Premium badge above is status and stays, but the Free Trial
         badge and the Get Premium button are both steps toward paying
         outside Google Play, so neither is drawn. Read here, at draw
         time, because app.js sets the flag after this file has loaded.

         An empty text node rather than nothing at all: identity-ui only
         keeps a slot that has something in it after the first draw,
         which comes before the entitlement is known, and a paying
         account's badge still has to land here when it arrives. */
      container.appendChild(document.createTextNode(''));
      return;
    } else {
      /* A trial whose finish has passed on this device's clock, with the
         server's answer not yet caught up, is drawn as ended: no badge
         and no "Pay nothing" line for someone who would pay today. */
      if (trialing && left === 0) trialing = false;
      if (trialing) container.appendChild(trialBadge(left));
      /* Every premium touch-point in the app points at the same page,
         one place to buy, everywhere the offer is made. On pricing.html
         a link there would point at the page already open, so the
         button is skipped; the whole page already is the offer. */
      if (/(^|\/)pricing\.html$/.test(location.pathname)) {
        /* An empty text node, as in the Play app above: the first draw
           comes before the entitlement is known, identity-ui keeps only
           a slot with something in it, and the day badge has to land
           here when the entitlement arrives. */
        if (!container.childNodes.length) container.appendChild(document.createTextNode(''));
        return;
      }
      node = offerButton(trialing && Date.now() < OFFER_CLOSES);
    }

    container.appendChild(node);
  }

  function renderPlanStatus(container) {
    statusSlots.push(container);
    drawPlanStatus(container);
  }

  /* Subscribed on DOMContentLoaded, not here: billing.js is loaded
     AFTER this file, so CT.billing does not exist yet at parse time and
     a subscription taken now would silently never happen. The same
     ordering caught out the session bridge. */
  function watchEntitlement() {
    if (!CT.billing || typeof CT.billing.onChange !== 'function') return;
    CT.billing.onChange(function () {
      statusSlots = statusSlots.filter(function (slot) { return slot.isConnected; });
      statusSlots.forEach(drawPlanStatus);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    watchEntitlement();

    /* No Google button inside the WebView Play app, where Google refuses
       its sign-in (app.js, IN_WEBVIEW_APP). Read here because app.js sets
       the flag after this file has loaded, as with CT.inPlayApp above. */
    var showGoogle = !CT.inWebViewApp;

    var header = document.getElementById('topbarSignin');
    if (header) {
      window.Aibhlinn.identityUI.mount({
        target: header,
        renderStatus: renderPlanStatus,
        productName: 'Pie Timers',
        showSuiteContext: true,
        showGoogle: showGoogle
      });
    }

    var secondary = document.getElementById('upgradeSignin');
    if (secondary) {
      window.Aibhlinn.identityUI.mount({
        target: secondary,
        renderStatus: renderPlanStatus,
        productName: 'Pie Timers',
        showSuiteContext: false, // already said once, in the header
        showGoogle: showGoogle
      });
    }
  });
})();
