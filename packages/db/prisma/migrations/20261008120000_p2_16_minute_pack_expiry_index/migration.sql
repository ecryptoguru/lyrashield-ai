-- P2-16 migration A of 2 — AUDITED: MinutePack cross-tenant expiry sweep.
--
-- One index, backed by EXPLAIN evidence on a disposable PostgreSQL 16.14
-- instance seeded with 200,000 synthetic rows. Plain additive `CREATE INDEX`.
-- No column, constraint or data change, no drops, no renames.
--
-- This is the index the v24 audit carried forward on measured evidence. The
-- companion migration 20261008130000_p2_16_webhook_event_integrity_index is
-- outside the audited scope and can be dropped on its own without touching
-- this file.
--
-- Prisma Migrate 7.4.0 and later split a migration script on statement
-- boundaries and runs each statement outside the wrapping transaction, so
-- CONCURRENTLY is accepted here (prisma-engines PR #5767, merged 2026-02-11).
-- This repository pins prisma 7.9.1 (packages/db/package.json), so the
-- statement is written CONCURRENTLY to avoid holding a write lock on the index
-- build. The repository already applies CONCURRENTLY migrations this way in
-- 20260907214500_finding_history_pagination_indexes.
--
-- FORWARD-ONLY. There is no down migration. See the PR body: removing this
-- index later is a separately reviewed forward migration, never a down step.

-- ── MinutePack expiry sweep ─────────────────────────────────────────────────
-- expirePacks (packages/billing/src/usage/expiry.ts:33-40) reads across every
-- tenant:
--   WHERE "deletedAt" IS NULL AND "expiresAt" < now() AND "remainingMinutes" > 0
-- Every existing MinutePack index leads with workspaceId or accountId
-- (MinutePack_workspaceId_expiresAt_idx, MinutePack_workspaceId_expiresAt_remainingMinutes_idx,
-- MinutePack_accountId_idx), so none of them can serve the expiresAt bound on
-- its own. Before this index the planner used a sequential scan.
--
-- Measured on the disposable instance, 200,000 rows, 30 percent already expired:
--   before  30.484 ms  Seq Scan, 140,000 rows removed by filter
--   after   15.885 ms  Bitmap Index Scan on this index
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
