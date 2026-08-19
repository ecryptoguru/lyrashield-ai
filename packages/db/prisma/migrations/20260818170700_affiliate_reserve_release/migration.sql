-- Affiliate reserve release + payout currency tightening.
--
-- The new-affiliate reserve (20-30% held for 90 days) was held at payout time
-- but never released. This migration adds the tracking needed for a scheduled
-- reserve-release job:
--   * Commission.reserveReleasedAt / reserveReleasedAmount record that the
--     reserved portion of a PAID commission has been released, so the release
--     job is idempotent (it skips commissions already released).
--   * Payout.isReserveRelease marks a payout as a reserve-release payout so
--     it is distinguishable from a normal commission payout.
--   * PayoutItem.commissionId unique constraint is dropped so a commission
--     can have a second payout item for its reserved portion (the main payout
--     item plus the reserve-release item). Idempotency is enforced by
--     Commission.reserveReleasedAt, not by the unique constraint.
-- Also tightens Payout.currency from unbounded TEXT to VarChar(3) for
-- consistency with Conversion/Commission currency fields.

ALTER TABLE "Commission" ADD COLUMN "reserveReleasedAt" TIMESTAMP(3);
ALTER TABLE "Commission" ADD COLUMN "reserveReleasedAmount" DECIMAL(19,4);

ALTER TABLE "Payout" ADD COLUMN "isReserveRelease" BOOLEAN NOT NULL DEFAULT false;

-- Tighten Payout.currency to VarChar(3). Existing rows are already 3-char
-- ISO codes; the ALTER is safe because VarChar(3) accepts any value of length <= 3.
ALTER TABLE "Payout" ALTER COLUMN "currency" TYPE VARCHAR(3);

-- Drop the unique constraint on PayoutItem.commissionId so a commission can
-- have a second (reserve-release) payout item.
DROP INDEX IF EXISTS "PayoutItem_commissionId_key";
CREATE INDEX IF NOT EXISTS "PayoutItem_commissionId_idx" ON "PayoutItem"("commissionId");
