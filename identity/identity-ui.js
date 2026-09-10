/* ============================================================
   AibhlínnAI shared sign-in UI.

   Renders a header button plus an anchored panel (emailed sign-in code
   primary, Google secondary). Every string a product might want to change —
   the "open app" label, the suite context line — is a parameter, not
   a hardcoded word, so this file is copy-pasted into a second app
   verbatim rather than forked.

   Depends on identity.js. Does not depend on entitlements.js or on
   anything Pie-Timers-specific.

   Usage:
     Aibhlinn.identityUI.mount({
       target: document.getElementById('signinSlot'),
       openLabel: 'Open Pie Timers',       // shown once signed in
       openHref: 'index.html',
       productName: 'Pie Timers',
       showSuiteContext: true              // the one-line "works across all our apps"
     });

   What this deliberately does NOT do:
     - no countdown pressure, no urgency copy
     - no full-screen modal — an anchored panel only
     - no auto-focus on page load; focus moves only when the person
       opens the panel themselves
   ============================================================ */
(function (global) {
  'use strict';

  var Aibhlinn = global.Aibhlinn = global.Aibhlinn || {};

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function mount(options) {
    var identity = Aibhlinn.identity;
    if (!identity) throw new Error('identity.js must load before identity-ui.js.');

    var opts = Object.assign({
      openLabel: 'Open',
      openHref: '#',
      productName: 'this app',
      showSuiteContext: true
    }, options);

    var wrap = el('div', { class: 'aib-signin', style: 'position:relative;display:inline-block;' });

    var btn = el('button', {
      type: 'button',
      class: 'aib-signin-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': 'Sign in with your AibhlínnAI account'
    }, [document.createTextNode('Sign in')]);

    var panel = el('div', {
      class: 'aib-signin-panel',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': 'aibSigninTitle',
      hidden: 'hidden'
    });

    panel.appendChild(el('button', {
      type: 'button', class: 'aib-signin-close', 'aria-label': 'Close'
    }, [document.createTextNode('×')]));

    panel.appendChild(el('h2', { id: 'aibSigninTitle', text: 'Sign in' }));
    panel.appendChild(el('p', {
      class: 'aib-sub',
      text: opts.showSuiteContext
        ? 'One AibhlínnAI account works across all our apps.'
        : 'Sign in with your AibhlínnAI account.'
    }));

    var form = el('form', { novalidate: 'novalidate' });
    var field = el('label', { class: 'aib-signin-field' });
    field.appendChild(el('span', { text: 'Email address' }));
    var emailInput = el('input', {
      type: 'email', autocomplete: 'email', required: 'required',
      placeholder: 'you@example.com'
    });
    field.appendChild(emailInput);
    form.appendChild(field);

    var submit = el('button', {
      type: 'submit', class: 'aib-signin-submit', text: 'Email me a sign-in code'
    });
    form.appendChild(submit);

    /* Where a product's bot check renders, if it supplies one. Empty and
       invisible otherwise -- identity itself knows nothing about
       Turnstile or any other vendor. */
    var challengeHost = el('div', { class: 'aib-signin-challenge' });
    form.appendChild(challengeHost);

    var status = el('p', { class: 'aib-signin-status', role: 'status', 'aria-live': 'polite' });
    form.appendChild(status);

    /* The same email carries a short code as well as the link. The link
       only signs in the browser that opens it; the code can be carried
       to the device running the app when the inbox is somewhere else
       — a personal address on a work machine, most often. Hidden until
       a send has actually happened, so it never invites a code that
       was never issued. */
    var codeRow = el('div', { class: 'aib-signin-code', hidden: 'hidden' });
    var codeField = el('label', { class: 'aib-signin-field' });
    codeField.appendChild(el('span', { text: 'Signed in elsewhere? Enter the code from the email' }));
    var codeInput = el('input', {
      type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '10', placeholder: '00000000'
    });
    codeField.appendChild(codeInput);
    codeRow.appendChild(codeField);
    var codeSubmit = el('button', {
      type: 'button', class: 'aib-signin-submit', text: 'Sign in with code'
    });
    codeRow.appendChild(codeSubmit);
    form.appendChild(codeRow);

    panel.appendChild(form);

    panel.appendChild(el('div', { class: 'aib-signin-divider', text: 'or' }));

    var googleBtn = el('button', {
      type: 'button', class: 'aib-signin-google', text: 'Continue with Google'
    });
    panel.appendChild(googleBtn);

    wrap.appendChild(btn);
    wrap.appendChild(panel);

    function openPanel() {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // Focus moves only because the person just activated this
      // control themselves — never on page load, never automatically.
      emailInput.focus();
      // Give a product-supplied bot check time to render before the
      // person is ready to submit, rather than making them wait after.
      identity.prepareSignIn(challengeHost);
      document.addEventListener('keydown', onKeydown);
      document.addEventListener('click', onOutsideClick, true);
    }

    function closePanel(returnFocus) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onOutsideClick, true);
      if (returnFocus) btn.focus();
    }

    function onKeydown(e) {
      if (e.key === 'Escape') closePanel(true);
    }
    function onOutsideClick(e) {
      if (!wrap.contains(e.target)) closePanel(false);
    }

    /* Signed in, the header used to offer one thing: a link into the
       app. Sign out existed only at the foot of the Settings tab, in a
       panel you had to know was there -- so the control that got you in
       vanished once you were in, and the way back out was somewhere
       else entirely. Sign-in and sign-out belong in the same place.

       What sits between them is the product's business, not identity's:
       a plan badge, a trial, an upgrade prompt. A product supplies
       renderStatus(container) and draws whatever it likes; identity
       neither knows nor asks what entitlement means here. */
    function renderSignedIn() {
      wrap.innerHTML = '';

      if (typeof opts.renderStatus === 'function') {
        var slot = el('span', { class: 'aib-signin-status-slot' });
        try { opts.renderStatus(slot); } catch (e) { /* a product's badge must not break sign-out */ }
        if (slot.childNodes.length) wrap.appendChild(slot);
      }

      var user = identity.getUser();
      var out = el('button', {
        type: 'button',
        class: 'aib-signout-btn',
        title: user && user.email ? 'Sign out of ' + user.email : 'Sign out'
      }, [document.createTextNode('Sign out')]);

      out.addEventListener('click', function () {
        out.disabled = true;
        out.textContent = 'Signing out…';
        /* Whatever happens, stop looking signed in. signOut() clears the
           local session before it calls the server, so a failed request
           means the token was already gone -- not that the person is
           still signed in. */
        identity.signOut().catch(function () {}).then(function () {
          out.disabled = false;
          out.textContent = 'Sign out';
        });
      });

      wrap.appendChild(out);
    }

    function renderSignedOut() {
      wrap.innerHTML = '';
      wrap.appendChild(btn);
      wrap.appendChild(panel);
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      /* Back to a clean form: a code row left over from a previous
         sign-in refers to an email that has since been consumed. */
      codeRow.hidden = true;
      codeInput.value = '';
      codeSubmit.disabled = false;
      codeSubmit.textContent = CODE_LABEL;
      submit.textContent = SUBMIT_LABEL;
      submit.disabled = false;
      status.textContent = '';
      status.dataset.tone = '';
    }

    btn.addEventListener('click', function () {
      if (panel.hidden) openPanel(); else closePanel(true);
    });
    panel.querySelector('.aib-signin-close').addEventListener('click', function () {
      closePanel(true);
    });

    /* The label carries the state. Once a code is on its way, "Email me a
       sign-in code" is a lie -- the useful thing to say is where to look
       and who it is from, since a message from a brand-new domain often
       lands in spam and an unfamiliar sender name is what makes people
       give up. The button stays out of action until a resend is genuinely
       useful, so a second press cannot quietly burn the throttle. */
    var SUBMIT_LABEL = submit.textContent;
    var RESEND_AFTER_MS = 30000;
    var resendTimer = null;

    function armResend() {
      clearTimeout(resendTimer);
      resendTimer = setTimeout(function () {
        submit.textContent = 'Send another code';
        submit.disabled = false;
      }, RESEND_AFTER_MS);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = emailInput.value.trim();
      if (!email) return;
      clearTimeout(resendTimer);
      submit.disabled = true;
      submit.textContent = 'Sending…';
      status.dataset.tone = '';
      status.textContent = '';
      identity.signInWithEmail(email, { challengeHost: challengeHost }).then(function () {
        submit.textContent = 'Check your inbox';
        status.textContent = 'We sent a sign-in code to ' + email + '.';
        status.appendChild(document.createElement('br'));
        status.appendChild(document.createTextNode(
          'This email comes from AibhlinnAI ➡️ check your spam folder if the email has not hit your inbox.'));
        codeRow.hidden = false;
        codeInput.focus();
        armResend();
      }).catch(function (err) {
        submit.textContent = SUBMIT_LABEL;
        submit.disabled = false;
        status.dataset.tone = 'error';
        status.textContent = err.message;
      });

      /* Last resort. If the promise above never settles at all -- a hung
         network, a third-party script that neither loads nor errors --
         the button would sit on "Sending…" with nothing to press. Give
         it back rather than leaving someone stuck with a reload as their
         only option. */
      setTimeout(function () {
        if (submit.textContent === 'Sending…') {
          submit.textContent = SUBMIT_LABEL;
          submit.disabled = false;
          status.dataset.tone = 'error';
          status.textContent = 'That took too long. Please try again.';
        }
      }, 20000);
    });

    /* Verifying the code completes sign-in on THIS device with no
       redirect: identity.onChange fires, render() swaps the panel for
       the signed-in header, and there is nothing left to do here. A
       wrong or stale code just comes back as an error to show. */
    var CODE_LABEL = codeSubmit.textContent;
    function submitCode() {
      var code = codeInput.value.replace(/\s+/g, '');
      if (!code) return;
      codeSubmit.disabled = true;
      codeSubmit.textContent = 'Signing in…';
      status.dataset.tone = '';
      status.textContent = '';
      identity.verifyEmailOtp(emailInput.value.trim(), code).catch(function (err) {
        codeSubmit.disabled = false;
        codeSubmit.textContent = CODE_LABEL;
        status.dataset.tone = 'error';
        status.textContent = err.message;
      });
    }
    codeSubmit.addEventListener('click', submitCode);
    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitCode(); }
    });

    /* Editing the address makes the previous "check your inbox" stale --
       it refers to somewhere the person is no longer signing in to, and
       the code that was sent there no longer applies either. */
    emailInput.addEventListener('input', function () {
      clearTimeout(resendTimer);
      submit.textContent = SUBMIT_LABEL;
      submit.disabled = false;
      status.dataset.tone = '';
      status.textContent = '';
      codeRow.hidden = true;
      codeInput.value = '';
      codeSubmit.disabled = false;
      codeSubmit.textContent = CODE_LABEL;
    });

    googleBtn.addEventListener('click', function () {
      identity.signInWithGoogle();
    });

    function render() {
      if (identity.isSignedIn()) renderSignedIn();
      else renderSignedOut();
    }

    identity.onChange(render);
    render();

    opts.target.appendChild(wrap);
    return { element: wrap };
  }

  Aibhlinn.identityUI = { mount: mount };
})(window);
