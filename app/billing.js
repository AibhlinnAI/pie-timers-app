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

       There is one widget, following whichever form is actually in
       front of the person. That matters: app.js mounts into the Account
       tab on load, so without the move the header panel would show no
       check at all and its token would stay empty forever -- a sign-in
       that can never succeed. Cloudflare allows only one render per
       element, so switching host means removing the old widget first. */
    mount: function (hostEl) {
      if (!cfg.turnstileEnabled) return Promise.resolve(false);

      var host = hostEl || document.getElementById('turnstileHost');
      if (!host) return Promise.resolve(false);
      /* Same host AND the widget is still inside. The id outliving its
       DOM is not hypothetical: the identity panel rebuilds its contents
       on auth changes, which throws the rendered widget away while this
       module still believes the widget is mounted -- and every later call then
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
     build variant is ever introduced, gate this whole panel out of that variant
     rather than editing its copy.

     That wrapper now exists, as the same site rather than a separate
     build, and app.js recognises it by its referrer (CT.inPlayApp).
     There every offer is gated out rather than reworded, and as a
     backstop the two functions below that reach Paddle refuse to run,
     so a control missed in the markup still cannot open checkout or
     the customer portal. Outside the Play app nothing here changes. */
  var PLAY_APP_REFUSAL = 'That is not available in the Android app.';

  /* Until 20 Sep 2026 the two refusals below read CT.inPlayApp, so if
     app.js got the answer wrong the markup gating and the refusal were
     wrong together and the "backstop" described above added nothing.

     The one genuinely independent signal is getDigitalGoodsService: it
     is exposed to an app installed FROM A STORE, so it catches a Play
     app that has lost the referrer, the marker and storage all at once.
     Note it is NOT "no installed PWA has it" -- on ChromeOS a
     store-installed PWA is exposed to it too, which is why app.js pairs
     it with an Android test before using it to hide prices. Here it only
     refuses a click, so the looser form is acceptable; if that ever
     changes, take app.js's paired version.

     The remaining checks are the same signals app.js reads, re-evaluated
     at click time rather than at load. That is a real difference and not
     independence, and is described here as what it is rather than what
     would be more flattering.

     The storage catch returns false ON PURPOSE. Refusing here would take
     a WEB customer with site data blocked out of checkout and out of the
     cancellation portal, which is worse than the leak it would close --
     and getDigitalGoodsService already covers the Play case it leaves. */
  function inPlayAppNow() {
    if (window.CT && window.CT.inPlayApp) return true;
    if (typeof window.getDigitalGoodsService === 'function') return true;
    if (/^android-app:\/\/ai\.aibhlinn\.pietimers(\/|$)/.test(document.referrer || '')) return true;
    /* The WebView Play app sends no referrer and has no
       getDigitalGoodsService; this token is its signal (app.js). */
    if (/(^|\s)PieTimersAndroid\/\d/.test(navigator.userAgent || '')) return true;
    if ((location.hash || '').slice(1) === 'in-app') return true;
    try {
      return sessionStorage.getItem('countdown-timers/play-app') === '1';
    } catch (e) {
      return false;
    }
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
          /* How checkout looks, set here as well as on the open call
             below. A checkout opened on a transaction made by the server
             (the free-trial path in openCheckout) is opened with the
             transaction's id and no settings of its own, and Paddle's
             page for Paddle.Checkout.open says of that case: "There's no
             settings object, so checkout settings must be included in
             Paddle.Initialize()". */
          checkout: { settings: { displayMode: 'overlay', theme: 'light' } },
          eventCallback: function (event) {
            // Paddle confirms client-side, but the webhook is the source of
            // truth. Re-read entitlement shortly after, once the write has landed.
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

  /* The plain catalogue price for this cadence: the one paid on the
     day. It is the only kind of price this file ever opens.

     Someone whose free trial has ended takes it and pays now, before
     the new year or after it: the later first payment is only for
     someone who subscribes while their free trial is running (Mal,
     22 Nov). Never give a lapsed account a free period: that would be
     free time nobody offered.

     Someone whose own free trial IS running does not take a catalogue
     price at all. The create-checkout function decides their free
     period on the server, from the account's own row, and makes the
     transaction (openCheckout below). The two catalogue prices that
     carry a trial are retired: config.js still lists them, for an older
     cached copy of this file, and nothing here reads them. This file
     holds no date and must not gain one. */
  function plainPriceFor(cadence) {
    var p = cfg.paddle;
    return cadence === 'monthly' ? p.monthlyPriceId : p.annualPriceId;
  }

  /* A Paddle subscription behind this account. See CT.billing.hasPaidPlan
     below for why it is not gated on status. */
  function hasPaidPlan() {
    return (entitlement.plan === 'monthly' || entitlement.plan === 'annual') &&
           !entitlement.complimentary;
  }

  /* A subscription that is running and will bill: checkout is refused,
     because a second purchase would make a second subscription that
     bills as well, and the account's one row would only show the newer.
     That includes someone waiting for their first payment (Paddle status
     'trialing'). One already set to end is let through: it will not
     bill again, so buying a new plan is how they come back. */
  var ALREADY_SUBSCRIBED = "You're already on AibhlínnAI Premium. Manage or cancel from the app's Settings.";
  function alreadySubscribed() {
    return hasPaidPlan() && entitlement.entitled && !entitlement.cancelAtPeriodEnd;
  }

  /* What the customer is told when checkout does not open. None of
     them is ever followed by a checkout on another price. */
  var CHECKOUT_FAILED = 'Could not open checkout. Please try again.';
  var ACCOUNT_UNCHECKED = 'We could not check your account just now. Please try again.';
  var SIGN_IN_FIRST = 'Please sign in first.';
  var DISCOUNT_NOT_FOUND = 'That discount code was not recognised. Check it, or leave it out, and try again.';

  /* Asks the create-checkout function for a Paddle transaction for this
     account, and answers with the transaction's id. Only for an account
     whose own free trial is running.

     The function decides the free period: how many whole days put the
     first payment on the right day for THIS account. It reads the
     account from the access token, so nothing sent here says who is
     asking, which price, which date or how many days. The body carries
     the plan and a discount code if one was typed, and that is all.

     Every failure throws one of the sentences above. It never falls
     back to a catalogue price: the old trial price would bring back a
     checkout that shows one date and bills on another, and the plain
     price would charge today someone who owes nothing yet. Stopping
     with "try again" costs the customer one more click.

     It gives up after 15 seconds, by the same means as pricing.html's
     own lookup, so a request that never answers does not leave the
     button waiting for ever. */
  function requestTrialCheckout(cadence, code) {
    return CT.auth.validToken().catch(function () {
      return undefined;
    }).then(function (token) {
      /* undefined: the session could not be read at all (no network,
         say). That is "try again", not "signed out". */
      if (token === undefined) return null;
      if (!token) throw new Error(SIGN_IN_FIRST);

      var asked = { cadence: cadence === 'monthly' ? 'monthly' : 'annual' };
      if (code) asked.discountCode = code;
      var init = {
        method: 'POST',
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(asked)
      };

      // A browser too old to stop a request simply waits for it.
      var timer = null;
      if (typeof AbortController === 'function') {
        var stopper = new AbortController();
        init.signal = stopper.signal;
        timer = setTimeout(function () { stopper.abort(); }, 15000);
      }
      function done(answer) {
        if (timer !== null) clearTimeout(timer);
        return answer;
      }

      /* Null for anything that is not an answer: no network, a request
         stopped by the timer, a body that is not JSON. */
      return fetch(cfg.supabaseUrl + '/functions/v1/create-checkout', init)
        .then(function (response) {
          return response.json().then(function (data) {
            return { status: response.status, data: data };
          });
        })
        .then(done, function () { return done(null); });
    }).then(function (answer) {
      var data = answer && answer.data;
      var said = data && data.error;
      if (answer && answer.status === 200 && data && data.ok === true &&
          typeof data.transactionId === 'string' && /^txn_[a-z0-9]+$/.test(data.transactionId)) {
        return data.transactionId;
      }
      if (answer && answer.status === 409 && said === 'already_subscribed') throw new Error(ALREADY_SUBSCRIBED);
      /* The server says the free trial is not running, where the read a
         moment ago said it was: the trial ended in between, or the two
         reads disagree. The next click reads the account again and, if
         the trial has ended, takes the plain price. */
      if (answer && answer.status === 409 && said === 'not_in_trial') throw new Error(ACCOUNT_UNCHECKED);
      if (answer && answer.status === 401) throw new Error(SIGN_IN_FIRST);
      /* A typed code the server could not find. Said here, because on
         this path the code is checked before the overlay opens, and
         carrying on without it would show a price they were not
         expecting. */
      if (answer && answer.status === 422 && said === 'discount_not_found') throw new Error(DISCOUNT_NOT_FOUND);
      throw new Error(CHECKOUT_FAILED);
    });
  }

  function openCheckout(cadence, discountCode) {
    if (inPlayAppNow()) return Promise.reject(new Error(PLAY_APP_REFUSAL));
    if (!cfg.billingEnabled) return Promise.reject(new Error('Billing is not configured.'));

    var user = CT.auth.getUser();
    if (!user) return Promise.reject(new Error(SIGN_IN_FIRST));

    /* Re-read entitlement before choosing a path, rather than trusting
       whatever happens to be cached.

       There are two paths. An account whose own free trial is running
       asks the create-checkout function for a transaction that already
       carries the right free period, so checkout shows the right
       first-payment day itself. Any other account that may buy opens
       the plain catalogue price and pays on the day.

       The server makes its own check of the trial, so a stale read
       cannot hand anyone a free period they are not due. A stale read
       can still cost the customer money the other way: a trialling
       account read as not-entitled takes the plain price and is charged
       today instead of on the later date. That is not hypothetical -- a
       live test account on day 6 of a 14-day trial was charged A$2.90
       this way.

       Two routes produce a stale read, and only refreshing here closes
       both. refresh() is async and pricing.html's Buy handler never waited
       for the one fired at DOMContentLoaded, so a quick click beat the
       answer back; and a pricing.html tab opened while signed out never
       hears about a sign-in that happened in a different tab, so its
       entitlement stays signed-out indefinitely.

       Costs one request before the overlay opens.

       A lookup that fails stops here. CT.db.getEntitlement never rejects:
       on a failed lookup it answers status 'unknown' with no plan, which
       reads as "not in a trial" and so would open the plain price,
       charging someone whose trial IS running today rather than on the
       later date. (The note here used to say a failed refresh fell back
       to the cached value. It never did: the cache had already been
       overwritten.) Nothing is lost by stopping, since checkout needs
       the network anyway. */
    return refresh().catch(function () { return entitlement; }).then(function () {
      if (entitlement.status === 'unknown') throw new Error(ACCOUNT_UNCHECKED);
      if (alreadySubscribed()) throw new Error(ALREADY_SUBSCRIBED);

      /* The account's own free trial, still running: plan 'trial', the
         row the grant_trial trigger writes, and never status 'trialing'
         alone. Paddle reports 'trialing' too for someone who has ALREADY
         subscribed and is waiting for their first payment (plan
         'monthly' or 'annual'). Until 22 Nov either one counted, so a
         subscriber could be offered a free period a second time.
         create-checkout makes the same test on the server. */
      var inTrial = entitlement.plan === 'trial' && entitlement.entitled;
      var priceId = plainPriceFor(cadence);
      if (!priceId) throw new Error('That plan is not available yet.');

      /* Paddle's script first, on both paths. On the free-trial path
         that means a script that will not load never leaves a
         transaction behind that nobody can open. */
      return initPaddle().then(function (ok) {
        return { ok: ok, inTrial: inTrial, priceId: priceId };
      });
    }).then(function (state) {
      if (!state.ok) throw new Error(CHECKOUT_FAILED);

      var code = (discountCode || '').trim();

      if (state.inTrial) {
        return requestTrialCheckout(cadence, code).then(function (transactionId) {
          /* The transaction already holds the price, the free period,
             the account it is for and any discount, all written by the
             server. So nothing but its id and the email to fill in is
             passed: no items, no customData and no discountCode. The
             look of the overlay comes from Paddle.Initialize(). */
          window.Paddle.Checkout.open({
            transactionId: transactionId,
            customer: { email: user.email }
          });
          return true;
        });
      }

      var options = {
        items: [{ priceId: state.priceId, quantity: 1 }],
        customer: { email: user.email },
        // The webhook reads this back to know whose account to credit.
        customData: { user_id: user.id },
        settings: { displayMode: 'overlay', theme: 'light' }
      };

      // Paddle validates the code itself and shows the error in the overlay,
      // so an expired or mistyped code fails gracefully rather than here.
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
     second copy. */
  function openManagePortal() {
    if (inPlayAppNow()) return Promise.reject(new Error(PLAY_APP_REFUSAL));
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
    hasPaidPlan: hasPaidPlan,
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
