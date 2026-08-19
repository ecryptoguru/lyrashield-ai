-- Perf indexes flagged by the Sprint-10 deep review.
-- Affiliate.reserveUntil: reserve-release job scans expired holds.
-- PayoutItem.payoutId: payout-item listing by payout.

CREATE INDEX IF NOT EXISTS "Affiliate_reserveUntil_idx" ON "Affiliate"("reserveUntil");
CREATE INDEX IF NOT EXISTS "PayoutItem_payoutId_idx" ON "PayoutItem"("payoutId");
