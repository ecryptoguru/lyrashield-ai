-- DB-07 follow-up: ACTIVATE the child-table RLS shipped in 20260803000001.
--
-- That migration ran `FORCE ROW LEVEL SECURITY` on the nine child tables and
-- defined correct EXISTS-join policies for each — but never ran
-- `ENABLE ROW LEVEL SECURITY` on any of them, and none of the nine had been
-- enabled by an earlier migration (20260705100000_batch3_rls explicitly
-- excluded five of them as "child tables without a direct workspaceId column";
-- ScorecardShare and ScorecardEvent were created later with no RLS at all).
--
-- In Postgres, FORCE only controls whether the table OWNER is subject to RLS
-- that is ALREADY active. Without ENABLE, the policies are never consulted:
-- the nine tables had zero database-level tenant isolation despite AGENTS.md
-- and PRD.md both asserting they carried the same protection as the 21 core
-- tables. This migration makes that assertion true.
--
-- ENABLE is idempotent in effect, and the policies from 20260803000001 are
-- already in place, so this is purely additive: once enabled, every query
-- without app.current_workspace_id() set fails closed (returns no rows) exactly
-- like the 21 core tables do.
--
-- Verify after deploy — relrowsecurity must be true for all nine:
--   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--   WHERE relname IN ('ScanEvent','Evidence','ScanResultManifest',
--                     'ScanCoverageReceipt','FixProposal','PullRequest',
--                     'Ticket','ScorecardShare','ScorecardEvent');

ALTER TABLE "ScanEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanResultManifest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanCoverageReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FixProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardEvent" ENABLE ROW LEVEL SECURITY;

-- Re-assert FORCE so the ordering is unambiguous for a fresh database that
-- applies both migrations in sequence, and so a reader of this file alone sees
-- the complete, correct pair.
ALTER TABLE "ScanEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Evidence" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanResultManifest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanCoverageReceipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "FixProposal" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardShare" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardEvent" FORCE ROW LEVEL SECURITY;
