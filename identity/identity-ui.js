/* ============================================================
   AibhlínnAI shared sign-in UI.

   Renders a header button plus an anchored panel (magic link primary,
   Google secondary). Every string a product might want to change —
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
      type: 'submit', class: 'aib-signin-submit', text: 'Email me a sign-in link'
    });
    form.appendChild(submit);

    var status = el('p', { class: 'aib-signin-status', role: 'status', 'aria-live': 'polite' });
    form.appendChild(status);
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

    function renderSignedIn() {
      wrap.innerHTML = '';
      var open = el('a', {
        class: 'aib-signin-btn', href: opts.openHref,
        'aria-label': opts.openLabel
      }, [document.createTextNode(opts.openLabel)]);
      wrap.appendChild(open);
    }

    function renderSignedOut() {
      wrap.innerHTML = '';
      wrap.appendChild(btn);
      wrap.appendChild(panel);
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', function () {
      if (panel.hidden) openPanel(); else closePanel(true);
    });
    panel.querySelector('.aib-signin-close').addEventListener('click', function () {
      closePanel(true);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = emailInput.value.trim();
      if (!email) return;
      submit.disabled = true;
      status.dataset.tone = '';
      status.textContent = 'Sending…';
      identity.signInWithEmail(email).then(function () {
        status.textContent = 'Check ' + email + ' for your sign-in link.';
      }).catch(function (err) {
        status.dataset.tone = 'error';
        status.textContent = err.message;
      }).then(function () {
        submit.disabled = false;
      });
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
