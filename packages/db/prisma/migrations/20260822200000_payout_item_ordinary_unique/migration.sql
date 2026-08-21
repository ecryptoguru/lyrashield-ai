-- Fix affiliate payout ledger invariants: capture-only discipline + ordinary uniqueness
-- Add isReserveRelease to PayoutItem so a commission can have exactly one ordinary
-- payout item and one reserve-release payout item. Backfill from Payout, then
-- enforce partial uniqueness for ordinary items only.

ALTER TABLE "PayoutItem" ADD COLUMN "isReserveRelease" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from parent Payout's isReserveRelease flag
UPDATE "PayoutItem"
SET "isReserveRelease" = "Payout"."isReserveRelease"
FROM "Payout"
WHERE "PayoutItem"."payoutId" = "Payout"."id";

-- Enforce: at most one ordinary (non-reserve) payout item per commission.
-- A second item is only allowed when isReserveRelease = true (the reserve-release payout).
-- Prisma cannot express partial unique indexes, so this is raw SQL only.
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutItem_commissionId_ordinary_unique"
  ON "PayoutItem"("commissionId") WHERE "isReserveRelease" = false;
