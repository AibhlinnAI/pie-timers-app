/* ============================================================
   The scheduled run, as plain orchestration: which feeds go this
   time, and how many are in flight at once.

   Each feed is synced by its own invocation of this function, not in
   a loop inside the scheduled one. Supabase gives an invocation about
   two seconds of CPU, and the loop spent it on every feed in turn --
   so once the feeds together cost more than that, the worker was
   killed partway (HTTP 546, WORKER_RESOURCE_LIMIT). Whichever feeds
   came after the kill were not refreshed, their rows recorded nothing,
   and the order shifted from run to run, so the damage moved around.
   Seen on 27-28 Sep 2026: every run for at least six hours.

   Written as .js for the same reason as ical.js: the exact shipping
   file runs under Node in tools/calendar-sync-test.mjs.
   ============================================================ */

/**
 * Pick this run's feeds: stalest first, entitled owners only, at most
 * `cap` of them. last_synced is the cursor -- a feed that is synced, or
 * fails, or dies is stamped with the time, so it goes to the back and
 * cannot hold up the queue.
 *
 * @param {{id: string, user_id: string}[]} feeds already ordered stalest first
 * @param {(userId: string) => Promise<boolean>} isEntitled
 * @param {number} cap
 * @returns {Promise<string[]>} feed ids
 */
export async function pickFeeds(feeds, isEntitled, cap) {
  var entitled = new Map();
  var picked = [];
  for (var i = 0; i < feeds.length && picked.length < cap; i++) {
    var feed = feeds[i];
    if (!entitled.has(feed.user_id)) entitled.set(feed.user_id, await isEntitled(feed.user_id));
    if (entitled.get(feed.user_id)) picked.push(feed.id);
  }
  return picked;
}

/**
 * Sync the given feeds, at most `parallel` at once, and stop starting
 * new ones once `budgetMs` has passed. Anything not started waits for
 * the next run, and because it is still the stalest it goes first then.
 *
 * `syncOne` resolves to "synced", "failed" (the feed's own error was
 * recorded), "died" (the worker never answered properly) or "deferred"
 * (not tried: the platform refused the call). A throw is counted as
 * "died", so one bad feed cannot end the run for the rest.
 *
 * @param {string[]} ids
 * @param {(id: string) => Promise<"synced"|"failed"|"died"|"deferred">} syncOne
 * @param {{parallel: number, budgetMs: number, now?: () => number}} options
 */
export async function fanOut(ids, syncOne, options) {
  var now = options.now || Date.now;
  var startedAt = now();
  var counts = { synced: 0, failed: 0, died: 0, deferred: 0 };
  var next = 0;

  async function lane() {
    while (next < ids.length) {
      if (now() - startedAt > options.budgetMs) return;
      var id = ids[next++];
      var outcome;
      try {
        outcome = await syncOne(id);
      } catch (e) {
        outcome = "died";
      }
      counts[outcome === "synced" || outcome === "failed" || outcome === "deferred" ? outcome : "died"]++;
    }
  }

  var lanes = [];
  for (var i = 0; i < Math.max(1, options.parallel); i++) lanes.push(lane());
  await Promise.all(lanes);

  counts.deferred += ids.length - next;   // never started: out of time
  return counts;
}
