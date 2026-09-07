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
  vapidPublicKey: 'BNPjlp5QIR16Lg4XVAt7tkFd32z8H8ermRzROm3lBfcSHvg0Pg4-f2vv-JiQYcJRZTOplU58OTbSY0UzTdvsm-Y',

  /* Where auth links return to. Leave blank to use the current page,
     which is right for most deployments. Must be listed in
     Supabase → Authentication → URL Configuration → Redirect URLs. */
  redirectUrl: '',

  /* One-click Google Calendar. Off until Google has verified the app.

     Calendar scopes are sensitive: Google allows them in Testing mode
     for listed testers only, and blocks them in production until the
     app passes review. Published-but-unverified therefore gives every
     customer who presses the button a 403 and no explanation -- worse
     than not offering it, because it looks broken rather than absent.

     Sign-in is unaffected either way: that flow asks only for email,
     profile and openid, and never for the calendar.

     Turn this on the day verification clears. The iCal path below it
     works for everyone in the meantime, and needs no Google approval
     at all. */
  googleCalendarEnabled: true,

  /* Cloudflare Turnstile site key (the public half). When set, the
     sign-in form is bot-checked and magic links are throttled. Leaving
     it blank sends sign-ins straight to Supabase, unthrottled — fine
     while you are the only user, not fine once sign-up is public. */
  turnstileSiteKey: '0x4AAAAAAEjN3Ts18xs7ZDpk',

  /* Paddle checkout. Leave blank to run with no billing: every signed-in
     account is then treated as entitled. */
  paddle: {
    /* 'sandbox' while testing, 'production' when live. */
    environment: 'production',
    clientToken: 'live_f40ba5ce81b1aff0afd6ab1ff86',
    /* Price IDs from Paddle → Catalogue → Products.

       Four, not two. Paddle puts the trial length on the price, so it
       is the same for everyone who buys it -- and the two audiences
       need different answers. Someone subscribing during their account
       trial owes nothing yet, and their first charge is moved to day 30
       by paddle-webhook. Someone subscribing after it expired owes
       money today; giving them the trial price would hand them a second
       free fortnight nobody promised.

       billing.js chooses. If the trial pair is left blank, everyone
       gets the plain price and is charged on the spot. */
    annualPriceId: 'pri_01m1effmxgfb45pmtyfz1dnh77',
    monthlyPriceId: 'pri_01m1efkevnwpn0rj7g2kzjne0j',

    /* The same two plans, with a 14-day trial set on the price. */
    annualTrialPriceId: 'pri_01m1xrvghx8896bxbf9rgtmx0m',
    monthlyTrialPriceId: 'pri_01m1xrry3351rzzgjvr2aqk2vd',

    /* What the upgrade panel displays. These are labels only — Paddle's
       checkout shows the real, tax-inclusive, localised price. Keep them
       in step with the actual prices set in Paddle. */
    annualPrice: 'A$19',
    annualPeriod: '/year',
    monthlyPrice: 'A$2.90',
    monthlyPeriod: '/month',

    /* Shown on the annual card. Deliberately concrete: a dollar figure
       beats a percentage. A$2.90 × 12 = A$34.80 against A$19, so the saving
       is A$15.80 — keep this exact rather than rounding a price claim up.
       Set deliberately low (not just "double-digit savings") so premium
       stays reachable for as many people as possible. */
    annualSaving: 'Save A$15.80 a year',

    /* Sub-line on the annual card. A$19/yr is A$1.58 a month, which is a
       far easier thing to say than the annual figure. */
    annualNote: 'Works out at A$1.58 a month'
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
