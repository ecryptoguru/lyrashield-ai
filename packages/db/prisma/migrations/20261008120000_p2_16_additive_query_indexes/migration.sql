-- P2-16 additive query indexes.
--
-- Two indexes, each backed by EXPLAIN evidence on a disposable PostgreSQL 16.14
-- instance seeded with 200,000 synthetic rows per table. Both are plain
-- additive `CREATE INDEX`. No column, constraint or data change, no drops, no
-- renames.
--
-- Prisma Migrate 7.4.0 and later split a migration script on statement
-- boundaries and runs each statement outside the wrapping transaction, so
-- CONCURRENTLY is accepted here (prisma-engines PR #5767, merged 2026-02-11).
-- This repository pins prisma 7.9.1 (packages/db/package.json), so both
-- statements are written CONCURRENTLY to avoid holding a write lock on the
-- index build. The repository already applies CONCURRENTLY migrations this way
-- in 20260907214500_finding_history_pagination_indexes.
--
-- FORWARD-ONLY. There is no down migration. See the PR body: removing either
-- index later is a separately reviewed forward migration, never a down step.

-- ── 1. MinutePack expiry sweep ──────────────────────────────────────────────
-- expirePacks (packages/billing/src/usage/expiry.ts:33-40) reads across every
-- tenant:
--   WHERE "deletedAt" IS NULL AND "expiresAt" < now() AND "remainingMinutes" > 0
-- Every existing MinutePack index leads with workspaceId or accountId
-- (MinutePack_workspaceId_expiresAt_idx, MinutePack_workspaceId_expiresAt_remainingMinutes_idx,
-- MinutePack_accountId_idx), so none of them can serve the expiresAt bound on
-- its own. Before this index the planner used a sequential scan.
--
-- Measured on the disposable instance, 200,000 rows, 30 percent already expired:
--   before  39.206 ms  Seq Scan, 140,000 rows removed by filter
--   after   16.817 ms  Bitmap Index Scan on this index
-- At 1 percent expired (2,000 of 200,000 rows, the shape an hourly sweep
-- actually sees) the same index took the query from 31.952 ms to 0.513 ms.
-- Index size at 200,000 rows is 1336 kB.
--
-- The predicate matches the query exactly, so the index holds only rows the
-- sweep can ever return. It also matches the declared schema predicate, which
-- is what keeps the migration drift check green: schema.prisma declares
--   @@index([expiresAt], where: raw("\"remainingMinutes\" > 0 AND \"deletedAt\" IS NULL"))
-- and this statement creates exactly that index.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "MinutePack_expiresAt_active_partial_idx"
  ON "MinutePack" ("expiresAt")
  WHERE "remainingMinutes" > 0 AND "deletedAt" IS NULL;

-- ── 2. WebhookEvent settlement-receipt integrity ────────────────────────────
-- checkSettlementReceiptIntegrity (apps/worker/src/jobs/billing-reconciliation.job.ts:644)
-- filters on provider, eventType and a createdAt window in all three of its
-- probes. WebhookEvent carries only WebhookEvent_provider_externalId_key,
-- WebhookEvent_workspaceId_idx and WebhookEvent_processed_idx, plus the two
-- payload expression indexes from 20260928140000, so the createdAt bound could
-- not be served by an index and every probe re-read the window from the heap.
--
-- Measured on the disposable instance, 200,000 rows over 400 days, 30-day
-- window:
--   duplicate settlement groups  76.318 ms -> 10.663 ms
--   polar refund orphans         36.838 ms ->  0.244 ms
--   razorpay refund orphans      29.213 ms ->  0.268 ms
-- The two orphan probes change from a parallel sequential scan over the whole
-- table to an Index Scan that stops after the 25-row LIMIT.
-- Index size at 200,000 rows is 1456 kB.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookEvent_provider_eventType_createdAt_idx"
  ON "WebhookEvent" ("provider", "eventType", "createdAt");
