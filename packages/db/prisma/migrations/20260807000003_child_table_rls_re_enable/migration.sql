-- Re-enable ROW LEVEL SECURITY on child tables (DB-07 closure)
--
-- Migration 20260803000002 enabled RLS on these 9 child tables but caused
-- production scan pipeline failures (42501 on ScanEvent writes). Migration
-- 20260803000003 rolled back to DISABLE as a hotfix.
--
-- Root cause analysis identified two issues:
--   1. account-deletion.ts wrote to ScorecardShare outside withWorkspaceRLS
--      (now fixed — moved into the per-workspace RLS context loop)
--   2. The CI reproduction job (rls-child-write-repro) now passes, confirming
--      all application write paths correctly use withWorkspaceRLS
--
-- Policies are already defined from migration 20260803000001; this migration
-- only re-enables and forces RLS.

ALTER TABLE "ScanEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanEvent" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evidence" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ScanResultManifest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanResultManifest" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ScanCoverageReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanCoverageReceipt" FORCE ROW LEVEL SECURITY;

ALTER TABLE "FixProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FixProposal" FORCE ROW LEVEL SECURITY;

ALTER TABLE "PullRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ScorecardShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardShare" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ScorecardEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardEvent" FORCE ROW LEVEL SECURITY;
