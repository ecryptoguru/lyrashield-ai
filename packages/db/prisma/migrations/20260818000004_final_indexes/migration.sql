-- Final composite indexes for query performance across Sprint 10 tables.
-- These cover the primary dashboard, payout-batch, license, and usage-balance
-- query patterns identified during schema review.

-- Affiliate dashboard KPI: clicks and conversions by affiliate within a date
-- range are covered by the ascending Click_affiliateId_clickedAt_idx and
-- Conversion_affiliateId_occurredAt_idx from migration 3. Postgres can scan an
-- ascending index backwards for latest-first listing, so no separate DESC
-- variant is needed (and a DESC variant is not declared in the Prisma schema,
-- which would cause migrate-diff drift).

-- Affiliate dashboard KPI: commissions by affiliate+status (already indexed
-- as Commission_affiliateId_status_availableAt_idx). Add a status-only index
-- for the payout-batch query that scans across all affiliates.
CREATE INDEX "Commission_status_availableAt_idx" ON "Commission"("status", "availableAt");

-- Payout batch: pending payouts ordered by requestedAt for FIFO processing
CREATE INDEX "Payout_status_requestedAt_idx" ON "Payout"("status", "requestedAt");

-- License queries: by workspaceId+sku (which licenses does this workspace own)
CREATE INDEX "License_workspaceId_sku_idx" ON "License"("workspaceId", "sku");

-- License queries: by ownerEmail+revoked (active licenses for an owner)
CREATE INDEX "License_ownerEmail_revoked_idx" ON "License"("ownerEmail", "revoked");

-- License activation: lastSeenAt for stale-activation sweeps
CREATE INDEX "LicenseActivation_lastSeenAt_idx" ON "LicenseActivation"("lastSeenAt");

-- Usage balance: UsageRecord by workspaceId+cycleStart already indexed in
-- migration 2. Add a composite with kind for per-kind balance queries.
CREATE INDEX "UsageRecord_workspaceId_cycleStart_kind_idx" ON "UsageRecord"("workspaceId", "cycleStart", "kind");

-- MinutePack: active packs with remaining minutes, ordered by expiry
-- (covered by MinutePack_workspaceId_expiresAt_idx from migration 2; add
--  a filter-friendly composite with remainingMinutes)
CREATE INDEX "MinutePack_workspaceId_expiresAt_remainingMinutes_idx" ON "MinutePack"("workspaceId", "expiresAt", "remainingMinutes");
