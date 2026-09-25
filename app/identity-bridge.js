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
        return null;   // null tells identity to use its own path
      });
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
     Three states, because a signed-in person is in exactly one of them
     and each wants something different said:

       trial, more than NUDGE_DAYS left  →  a quiet badge. They are
         living with the app; do not sell to them yet. This is the same
         restraint app.js applies to the upgrade panel, which stays
         hidden for the same window and for the same reason.

       trial ending, or ended            →  a button. Now is when asking
         is useful, and the only state here that is an action.

       entitled                          →  a bordered badge. Status,
         not an offer. Nothing to click.

     Read from CT.billing, so the header cannot disagree with the panel
     further down the page. */
  var NUDGE_DAYS = 4;

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

  function drawPlanStatus(container) {
    container.innerHTML = '';

    if (!CT.billing || !CT.billing.enabled()) return;

    var ent = CT.billing.get();
    var trialing = (ent.status === 'trialing' || ent.plan === 'trial') && ent.entitled;
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
    } else if (trialing && left !== null && left > NUDGE_DAYS) {
      node = document.createElement('span');
      node.className = 'plan-chip plan-chip--trial';
      node.appendChild(mark());
      node.appendChild(document.createTextNode('Free Trial'));
    } else {
      /* Every premium touch-point in the app points at the same page
         now, rather than some going to #account and others to
         pricing.html -- one place to buy, everywhere the offer is
         made. On pricing.html itself this would be a self-link, so the button
         is skipped there; the whole page already is the offer. */
      if (/(^|\/)pricing\.html$/.test(location.pathname)) return;
      node = document.createElement('a');
      node.className = 'plan-chip plan-chip--offer';
      node.href = 'pricing.html';
      node.appendChild(document.createTextNode('Get '));
      node.appendChild(mark());
      node.appendChild(document.createTextNode('Premium'));
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

    var header = document.getElementById('topbarSignin');
    if (header) {
      window.Aibhlinn.identityUI.mount({
        target: header,
        renderStatus: renderPlanStatus,
        productName: 'Pie Timers',
        showSuiteContext: true
      });
    }

    var secondary = document.getElementById('upgradeSignin');
    if (secondary) {
      window.Aibhlinn.identityUI.mount({
        target: secondary,
        renderStatus: renderPlanStatus,
        productName: 'Pie Timers',
        showSuiteContext: false // already said once, in the header
      });
    }
  });
})();
