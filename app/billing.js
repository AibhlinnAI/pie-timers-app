/* ============================================================
   Turnstile (bot check) + Paddle (checkout) + entitlement state.

   Note on dependencies: the rest of this app loads nothing from
   a third party. These two are unavoidable exceptions — both
   vendors require their own script, and neither can be called
   over plain HTTP. Both load lazily, only on the Account tab,
   so the app still starts and runs offline without them.

   Entitlement rule: the FREE tier is everything on one device.
   Only sync and background push are gated. A lapsed account can
   still download its own data — never hold someone's schedule
   hostage to a payment.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};
  var cfg = CT.config;

  /* ─────────────────────────── Script loading ─────────────────────────── */

  var loaded = {};

  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = function () { resolve(true); };
      tag.onerror = function () {
        loaded[src] = null;
        reject(new Error('Could not load ' + src));
      };
      document.head.appendChild(tag);
    });
    return loaded[src];
  }

  /* ─────────────────────────── Turnstile ─────────────────────────── */

  var widgetId = null;
  var currentHost = null;
  var currentToken = '';

  var turnstile = {
    enabled: function () { return Boolean(cfg.turnstileEnabled); },

    /* Render the widget. Defaults to #turnstileHost (the Account tab's
       own sign-in form); the identity panel passes its own element, so
       both sign-in routes get the same check.

       There is one widget, and it follows whichever form is actually in
       front of the person. That matters: app.js mounts into the Account
       tab on load, so without moving it the header panel would show no
       check at all and its token would stay empty forever -- a sign-in
       that can never succeed. Cloudflare allows only one render per
       element, so switching host means removing the old widget first. */
    mount: function (hostEl) {
      if (!cfg.turnstileEnabled) return Promise.resolve(false);

      var host = hostEl || document.getElementById('turnstileHost');
      if (!host) return Promise.resolve(false);
      /* Same host AND the widget is still in it. The id outliving its
       DOM is not hypothetical: the identity panel rebuilds its contents
       on auth changes, which throws the rendered widget away while this
       module still believes it is mounted -- and every later call then
       short-circuits to a widget that is not there, leaving a sign-in
       that can never produce a token. */
      if (widgetId !== null && host === currentHost && host.childElementCount > 0) {
        return Promise.resolve(true);
      }

      if (widgetId !== null && window.turnstile) {
        try { window.turnstile.remove(widgetId); } catch (e) { /* already gone */ }
        widgetId = null;
        currentToken = '';
      }

      return loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
        .then(function () {
          if (!window.turnstile) return false;
          host.hidden = false;
          currentHost = host;
          widgetId = window.turnstile.render(host, {
            sitekey: cfg.turnstileSiteKey,
            /* Named so the server can check the token was minted for this
               form and not lifted from another widget on the same key. */
            action: 'signin',
            theme: 'auto',
            callback: function (token) { currentToken = token; },
            'expired-callback': function () { currentToken = ''; },
            'error-callback': function () { currentToken = ''; }
          });
          return true;
        })
        .catch(function (err) {
          console.warn(err.message);
          return false;
        });
    },

    token: function () {
      if (!cfg.turnstileEnabled) return '';
      if (currentToken) return currentToken;
      if (window.turnstile && widgetId !== null) {
        try { return window.turnstile.getResponse(widgetId) || ''; } catch (e) { return ''; }
      }
      return '';
    },

    /* A token is single-use — reset after every submission. */
    reset: function () {
      currentToken = '';
      if (window.turnstile && widgetId !== null) {
        try { window.turnstile.reset(widgetId); } catch (e) { /* ignore */ }
      }
    }
  };

  /* ─────────────────────────── Entitlement ─────────────────────────── */

  var entitlement = { entitled: false, plan: null, status: 'unknown' };
  var listeners = [];

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(entitlement); } catch (e) { /* keep the rest running */ }
    });
  }

  function refresh() {
    if (!cfg.isConfigured || !CT.auth.isSignedIn()) {
      entitlement = { entitled: false, plan: null, status: 'signed-out' };
      emit();
      return Promise.resolve(entitlement);
    }
    return CT.db.getEntitlement().then(function (result) {
      entitlement = {
        entitled: Boolean(result.entitled),
        plan: result.plan || null,
        status: result.status || 'none',
        currentPeriodEnd: result.current_period_end || null,
        cancelAtPeriodEnd: Boolean(result.cancel_at_period_end),
        complimentary: Boolean(result.complimentary)
      };
      emit();
      return entitlement;
    });
  }

  /* ─────────────────────────── Google Play anti-steering ───────────────
     If this app is ever wrapped for Google Play (a Trusted Web Activity
     over this same site), the in-app experience must not link, mention,
     or hint at web/Paddle pricing — Play's policy on external purchase
     links (and, for many app categories, the User Choice Billing pilot
     aside, the default requirement) prohibits steering a Play user to
     pay outside Play Billing. The annual-only offer stays exclusive to
     this page's normal web context. Do not add a "cheaper on the web"
     message, a link to this pricing section, or a coupon reference
     anywhere reachable from the Play-wrapped build. If a Play-specific
     build variant is ever introduced, gate this whole panel out of it
     rather than editing its copy. */

  /* ─────────────────────────── Paddle ─────────────────────────── */

  var paddleReady = null;

  function initPaddle() {
    if (!cfg.billingEnabled) return Promise.resolve(false);
    if (paddleReady) return paddleReady;

    paddleReady = loadScript('https://cdn.paddle.com/paddle/v2/paddle.js')
      .then(function () {
        if (!window.Paddle) return false;
        if (cfg.paddle.environment === 'sandbox') {
          window.Paddle.Environment.set('sandbox');
        }
        window.Paddle.Initialize({
          token: cfg.paddle.clientToken,
          eventCallback: function (event) {
            // Paddle confirms client-side, but the webhook is the source of
            // truth. Re-read entitlement shortly after, once it has landed.
            if (event && event.name === 'checkout.completed') {
              setTimeout(refresh, 2500);
              setTimeout(refresh, 8000);
            }
          }
        });
        return true;
      })
      .catch(function (err) {
        paddleReady = null;
        console.warn(err.message);
        return false;
      });

    return paddleReady;
  }

  /* Which of the two prices for this cadence. Someone still inside
     their account trial takes the price that carries a trial, so
     checkout takes nothing today and they can cancel free right up to
     day 30 -- paddle-webhook moves that first charge to exactly day 30
     afterwards. Someone whose trial has already lapsed takes the plain
     price and pays now; handing them the trial price would give away a
     second free fortnight nobody offered.

     Falls back to the plain price whenever the trial pair is unset, so
     a half-configured catalogue charges honestly rather than failing. */
  function priceFor(cadence) {
    var p = cfg.paddle;
    var plain = cadence === 'monthly' ? p.monthlyPriceId : p.annualPriceId;
    var trial = cadence === 'monthly' ? p.monthlyTrialPriceId : p.annualTrialPriceId;

    var ent = entitlement;
    var inTrial = (ent.status === 'trialing' || ent.plan === 'trial') && ent.entitled;

    return (inTrial && trial) ? trial : plain;
  }

  function openCheckout(cadence, discountCode) {
    if (!cfg.billingEnabled) return Promise.reject(new Error('Billing is not configured.'));

    var priceId = priceFor(cadence);

    if (!priceId) return Promise.reject(new Error('That plan is not available yet.'));

    var user = CT.auth.getUser();
    if (!user) return Promise.reject(new Error('Please sign in first.'));

    return initPaddle().then(function (ok) {
      if (!ok) throw new Error('Could not open checkout. Please try again.');

      var options = {
        items: [{ priceId: priceId, quantity: 1 }],
        customer: { email: user.email },
        // The webhook reads this back to know whose account to credit.
        customData: { user_id: user.id },
        settings: { displayMode: 'overlay', theme: 'light' }
      };

      // Paddle validates the code itself and shows the error in the overlay,
      // so an expired or mistyped code fails gracefully rather than here.
      var code = (discountCode || '').trim();
      if (code) options.discountCode = code;

      window.Paddle.Checkout.open(options);
      return true;
    });
  }

  /* Opens Paddle's own hosted customer portal (payment method,
     invoices, cancel) in a new tab. Deliberately does not build a
     cancellation UI of our own -- Paddle is the merchant of record
     (terms.html §5), so the portal already reflects their actual
     buyer terms and refund policy instead of us reimplementing a
     second copy of it. */
  function openManagePortal() {
    if (!cfg.billingEnabled) return Promise.reject(new Error('Billing is not configured.'));

    var user = CT.auth.getUser();
    if (!user) return Promise.reject(new Error('Please sign in first.'));

    return CT.auth.validToken().then(function (token) {
      if (!token) throw new Error('Please sign in first.');
      return fetch(cfg.supabaseUrl + '/functions/v1/manage-subscription', {
        method: 'POST',
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || 'Could not open your billing portal.');
        return data;
      });
    });
  }

  CT.turnstile = turnstile;

  CT.billing = {
    enabled: function () { return Boolean(cfg.billingEnabled); },
    get: function () { return entitlement; },
    isEntitled: function () {
      // With no billing configured, nothing is gated.
      return cfg.billingEnabled ? entitlement.entitled : true;
    },
    /* Whether there is a Paddle subscription behind this account, which
       is a narrower question than isEntitled(). A trial, a complimentary
       grant and a friends-and-family code all entitle someone without
       creating anything Paddle can show them a portal for -- and since
       every new account starts on a trial, entitled-but-unbilled is the
       normal state for a customer's first fortnight, not an edge case.
       Only 'monthly' and 'annual' are written by paddle-webhook; 'trial'
       and 'complimentary' are granted in SQL. Deliberately not gated on
       status: a canceled subscriber still has invoices to read and a
       card to update, so they keep the portal. */
    hasPaidPlan: function () {
      return (entitlement.plan === 'monthly' || entitlement.plan === 'annual') &&
             !entitlement.complimentary;
    },
    refresh: refresh,
    openCheckout: openCheckout,
    openManagePortal: openManagePortal,
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
    }
  };
})();
