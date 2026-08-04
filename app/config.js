/* ============================================================
   Pie Timers — deployment configuration
   ------------------------------------------------------------
   Fill these in with your Supabase project's values, then reload.
   Until they are set, the app runs exactly as before: fully
   local, no account, no sync. Nothing here is secret — the anon
   key is designed to be public and is protected by the
   row-level security policies in supabase/schema.sql.
   ============================================================ */
window.CT = window.CT || {};

window.CT.config = {
  /* Shown wherever the app offers help, and named in the terms and privacy
     policy. Change it here and it changes everywhere.
     Use an address on your own domain, not a personal mailbox: it is
     published, it will be scraped, and you cannot rotate a personal one. */
  supportEmail: 'support@aibhlinn.ai',

  /* Public URLs for your legal pages. Paddle checks these exist. */
  termsUrl: 'terms.html',
  privacyUrl: 'privacy.html',

  /* Project Settings → API → Project URL, e.g. https://abcdefgh.supabase.co */
  supabaseUrl: 'https://tgapmpbcqqnpsldehuqa.supabase.co',

  /* Project Settings → API Keys → Publishable key (formerly anon/public).
     Public by design: it identifies the project, it does not grant access.
     What protects the data is row-level security, verified live — every
     table returns nothing to a request without a session. */
  supabaseAnonKey: 'sb_publishable_WZqsLnw3OPfo6z_ou0GaYg_B8_HuNG0',

  /* Public VAPID key from your Web Push key pair. Required only for
     background push notifications. See README for how to generate it. */
  vapidPublicKey: '',

  /* Where auth links return to. Leave blank to use the current page,
     which is right for most deployments. Must be listed in
     Supabase → Authentication → URL Configuration → Redirect URLs. */
  redirectUrl: '',

  /* Cloudflare Turnstile site key (the public half). When set, the
     sign-in form is bot-checked and magic links are throttled. Leaving
     it blank sends sign-ins straight to Supabase, unthrottled — fine
     while you are the only user, not fine once sign-up is public. */
  turnstileSiteKey: '',

  /* Paddle checkout. Leave blank to run with no billing: every signed-in
     account is then treated as entitled. */
  paddle: {
    /* 'sandbox' while testing, 'production' when live. */
    environment: 'sandbox',
    clientToken: '',
    /* Price IDs from Paddle → Catalogue → Products. */
    annualPriceId: '',
    monthlyPriceId: '',

    /* What the upgrade panel displays. These are labels only — Paddle's
       checkout shows the real, tax-inclusive, localised price. Keep them
       in step with the actual prices set in Paddle. */
    annualPrice: '$19',
    annualPeriod: '/year',
    monthlyPrice: '$2.90',
    monthlyPeriod: '/month',

    /* Shown on the annual card. Deliberately concrete: a dollar figure
       beats a percentage. $2.90 × 12 = $34.80 against $19, so the saving
       is $15.80 — keep this exact rather than rounding a price claim up.
       Set deliberately low (not just "double-digit savings") so premium
       stays reachable for as many people as possible. */
    annualSaving: 'Save $15.80 a year',

    /* Sub-line on the annual card. $19/yr is $1.58 a month, which is a
       far easier thing to say than the annual figure. */
    annualNote: 'Works out at $1.58 a month'
  }
};

/* Convenience flags used throughout the app. */
window.CT.config.isConfigured = Boolean(
  window.CT.config.supabaseUrl && window.CT.config.supabaseAnonKey
);
window.CT.config.pushConfigured = Boolean(
  window.CT.config.isConfigured && window.CT.config.vapidPublicKey
);
window.CT.config.turnstileEnabled = Boolean(window.CT.config.turnstileSiteKey);
window.CT.config.billingEnabled = Boolean(
  window.CT.config.isConfigured &&
  window.CT.config.paddle.clientToken &&
  window.CT.config.paddle.annualPriceId
);
