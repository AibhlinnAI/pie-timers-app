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
  var currentToken = '';

  var turnstile = {
    enabled: function () { return Boolean(cfg.turnstileEnabled); },

    /* Render the widget into #turnstileHost. Safe to call repeatedly. */
    mount: function () {
      if (!cfg.turnstileEnabled) return Promise.resolve(false);
      if (widgetId !== null) return Promise.resolve(true);

      var host = document.getElementById('turnstileHost');
      if (!host) return Promise.resolve(false);

      return loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
        .then(function () {
          if (!window.turnstile) return false;
          host.hidden = false;
          widgetId = window.turnstile.render(host, {
            sitekey: cfg.turnstileSiteKey,
            theme: 'light',
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

  function openCheckout(cadence, discountCode) {
    if (!cfg.billingEnabled) return Promise.reject(new Error('Billing is not configured.'));

    var priceId = cadence === 'monthly'
      ? cfg.paddle.monthlyPriceId
      : cfg.paddle.annualPriceId;

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

  CT.turnstile = turnstile;

  CT.billing = {
    enabled: function () { return Boolean(cfg.billingEnabled); },
    get: function () { return entitlement; },
    isEntitled: function () {
      // With no billing configured, nothing is gated.
      return cfg.billingEnabled ? entitlement.entitled : true;
    },
    refresh: refresh,
    openCheckout: openCheckout,
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
    }
  };
})();
