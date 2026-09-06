-- ═══════════════════ REMOVING SELF-CERTIFIED HARDSHIP ═══════════════════
-- schema-hardship.sql is gone. The free tier now does that job: every
-- feature that works on one device works without paying, for anyone,
-- forever. Sync, calendar and background alerts are what A$2.90 buys.
--
-- Run this once against any project that had the old function. It is
-- safe on a project that never did.

drop function if exists public.grant_hardship_access();

-- Any capability already granted this way is left alone deliberately:
-- identity.product_entitlements rows are time-bounded or explicit, and
-- taking access back from someone who asked for it is not a migration
-- step. Revoke individually if you ever need to.
