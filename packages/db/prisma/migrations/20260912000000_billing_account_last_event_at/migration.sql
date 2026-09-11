-- Stale signed-event ordering (2026-09-11 review, VERIFY-C-001).
--
-- Subscription upserts previously overwrote status/period unconditionally, so
-- an out-of-order signed event could regress currentPeriodStart (re-widening
-- the balance window over prior-cycle leftovers) or flip canceled -> active.
-- `lastEventAt` is the monotonic provider-event clock the sync path checks
-- under the account advisory lock; internal downgrades stamp it too.
--
-- Additive and forward-only: nullable column, no data rewritten.

ALTER TABLE "BillingAccount" ADD COLUMN "lastEventAt" TIMESTAMP(3);
