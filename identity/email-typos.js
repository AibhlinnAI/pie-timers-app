/* ============================================================
   Email typo check -- "did you mean …@gmail.com?"

   Found 24 September 2026 by comparing the Play tester list with
   auth.users: a tester typed "…@gmail.comj" into the tester invite
   and again into sign-in. Nothing objected. The one-time code went to
   an address that cannot exist, an account row was made and never
   used, and the tester got nothing that worked and no reason why.

   The server only checks for an @ and a dot, and should stay that
   loose: it cannot know every provider, and a real address it refuses
   is worse than a typo it lets through. So this sits in front of
   every field that sends a code, and only ever SUGGESTS. suggest()
   looks for a near miss of the providers people actually sign up with
   and hands back the corrected address, or null. It never changes what
   was typed; the page asks, and the person decides.

   Two kinds of slip:

   1. The name is right, the ending is not: gmail.comj, gmail.co,
      gmail.com.au, hotmail.cmo, outlook.comau, gmailcom.
   2. The name is misspelled: gmial.com, hotmial.com, yahooo.com.au.

   A real address flagged as a typo costs one tap on "keep". A typo
   waved through costs someone the whole sign-up. But a prompt that is
   often wrong teaches people to ignore it, so the rules lean quiet:

   - A domain whose name exactly matches a provider is only ever
     checked on its ending. mail.com, email.com and ymail.com are real
     providers one letter from gmail.com, and are listed for that
     reason alone.
   - One two-letter country ending is never "corrected" into another.
     hotmail.gr is left alone although hotmail.fr is a letter away, and
     icloud.com.au is offered icloud.com, not icloud.com.cn.
   - Names under five letters (live, me, aol, tpg) are only checked for
     a slip in the ending, never for a misspelled name: love.com.au
     could be anyone's domain, and it is one letter from live.com.au.

   In the shared identity folder rather than app/ because it is about
   signing in by email, not about Pie Timers: identity-ui.js asks it
   before its panel sends a code, and so can any other AibhlínnAI app.
   Pure functions, no DOM, no product names. Pie Timers' own two forms
   use it through emailTypoGate() in app/app.js. The cases are in
   tools/check-email-typos.js.
   ============================================================ */
(function (global) {
  'use strict';

  var Aibhlinn = global.Aibhlinn = global.Aibhlinn || {};

  /* [name, closed, endings]. Most likely first, since a tie goes to
     whichever comes first.

     closed: the provider issues addresses under these endings and no
     others, so any other ending on its exact name is a slip.
     open: it also issues addresses under country endings too many to
     list, so only a near miss of an ending listed here is flagged.

     The first ending is the one offered when none was typed at all.
     bigpond.com.au is real: Telstra delivers it to the same mailbox
     as bigpond.com. */
  var PROVIDERS = [
    ['gmail',      true,  ['com']],
    ['hotmail',    false, ['com', 'com.au', 'co.uk', 'co.nz']],
    ['outlook',    false, ['com', 'com.au', 'co.uk', 'co.nz']],
    ['icloud',     true,  ['com', 'com.cn']],
    ['yahoo',      false, ['com', 'com.au', 'co.uk', 'co.nz']],
    ['bigpond',    true,  ['com', 'net.au', 'com.au']],
    ['live',       false, ['com', 'com.au', 'co.uk']],
    ['googlemail', true,  ['com']],
    ['optusnet',   true,  ['com.au']],
    ['iinet',      true,  ['net.au']],
    ['westnet',    true,  ['com.au']],
    ['ozemail',    true,  ['com.au']],
    ['internode',  false, ['on.net']],
    ['telstra',    false, ['com']],
    ['tpg',        false, ['com.au']],
    ['dodo',       false, ['com.au']],
    ['me',         false, ['com']],
    ['mac',        false, ['com']],
    ['msn',        false, ['com']],
    ['aol',        false, ['com']],
    ['ymail',      true,  ['com']],
    ['rocketmail', true,  ['com']],
    ['gmx',        false, ['com', 'net']],
    ['mail',       false, ['com']],
    ['email',      false, ['com']]
  ].map(function (row) {
    return { name: row[0], closed: row[1], endings: row[2] };
  });

  /* Edit distance counting a swap of two neighbouring letters as one
     edit (optimal string alignment), so "gmial" is one slip from
     "gmail", not two. */
  function distance(a, b) {
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) d[i] = [i];
    for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  /* The two-letter country code an ending finishes on, or ''. */
  function country(ending) {
    var m = /(?:^|\.)([a-z]{2})$/.exec(ending);
    return m ? m[1] : '';
  }

  function sharedStart(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  /* The provider's own ending nearest to the one typed, as
     { ending, cost }, or null when nothing is near enough to offer.
     limit caps the cost; a closed provider otherwise has no cap. */
  function bestEnding(provider, typed, limit) {
    if (provider.endings.indexOf(typed) !== -1) return { ending: typed, cost: 0 };
    if (!typed) return { ending: provider.endings[0], cost: 1 };

    var from = country(typed);
    if (limit === undefined) limit = provider.closed ? Infinity : (from ? 1 : 2);

    var best = null;
    provider.endings.forEach(function (ending) {
      var to = country(ending);
      if (from && to && from !== to) return;
      var cost = distance(typed, ending);
      if (cost > limit) return;
      if (!best || cost < best.cost ||
          (cost === best.cost && sharedStart(typed, ending) > sharedStart(typed, best.ending))) {
        best = { ending: ending, cost: cost };
      }
    });
    return best;
  }

  function byName(name) {
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].name === name) return PROVIDERS[i];
    }
    return null;
  }

  /* "gmailcom", "hotmailcomau", "gmail": the dot went missing, so the
     name runs straight into its ending, or there is no ending at all.
     Longest name first, so "googlemail…" is not read as "gmail…". */
  function runOn(domain) {
    var names = PROVIDERS.slice().sort(function (a, b) { return b.name.length - a.name.length; });
    for (var i = 0; i < names.length; i++) {
      var p = names[i];
      if (domain.indexOf(p.name) !== 0) continue;
      var rest = domain.slice(p.name.length);
      if (!rest) return p.name + '.' + p.endings[0];
      for (var j = 0; j < p.endings.length; j++) {
        if (distance(rest, p.endings[j].replace(/\./g, '')) <= 1) return p.name + '.' + p.endings[j];
      }
    }
    return null;
  }

  /* The corrected domain, or null. May return the domain unchanged;
     suggest() treats that as nothing to say. */
  function fixDomain(typed) {
    var domain = typed.replace(/,/g, '.');
    var dot = domain.indexOf('.');

    if (dot === -1) {
      var joined = runOn(domain);
      if (joined) return joined;
    }

    var name = dot === -1 ? domain : domain.slice(0, dot);
    var ending = dot === -1 ? '' : domain.slice(dot + 1);

    var exact = byName(name);
    if (exact) {
      var fit = bestEnding(exact, ending);
      return fit ? exact.name + '.' + fit.ending : null;
    }

    var best = null;
    PROVIDERS.forEach(function (p) {
      if (p.name.length < 5) return;
      var nameCost = distance(name, p.name);
      if (nameCost > (p.name.length === 5 ? 1 : 2)) return;
      var near = bestEnding(p, ending, 1);
      if (!near) return;
      var cost = nameCost + near.cost;
      if (cost > 2) return;
      if (!best || cost < best.cost) best = { domain: p.name + '.' + near.ending, cost: cost };
    });
    return best ? best.domain : null;
  }

  /* The address as it was probably meant, or null when it already
     looks right or is not close enough to anything to guess. Only the
     domain is ever changed; the part before the @ comes back exactly
     as typed. */
  function suggest(address) {
    var text = String(address == null ? '' : address).trim();
    var at = text.lastIndexOf('@');
    if (at < 1 || at === text.length - 1) return null;

    var typed = text.slice(at + 1).toLowerCase();
    var fixed = fixDomain(typed);
    return fixed && fixed !== typed ? text.slice(0, at + 1) + fixed : null;
  }

  Aibhlinn.emailTypos = { suggest: suggest };
})(window);
