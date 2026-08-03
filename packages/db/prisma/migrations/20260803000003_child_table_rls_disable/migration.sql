-- HOTFIX: roll back the child-table RLS activation from 20260803000002.
--
-- Enabling those policies took the scan pipeline down in production. A run
-- against a WEB_APP target failed with:
--
--   Invalid `prisma.scanEvent.create()` invocation: Database error.
--   Code: `42501`. Message: `new row violates row-level security policy
--   for table "ScanEvent"`
--
-- The policies themselves are correct, and every application write path already
-- goes through `withWorkspaceRLS` (which sets app.current_workspace_id as a
-- transaction-local GUC). Something between those two facts does not hold in
-- the production topology — the most likely candidates are the Supabase pooler
-- not preserving the transaction-local setting for the connection that performs
-- the insert, or a worker write path that reaches these tables outside the
-- wrapper. That needs to be diagnosed against production logs, not guessed at.
--
-- Disabling restores the exact state the system ran in all day: the policies
-- remain DEFINED but inert, and application-level workspace checks in
-- scan-service / fix-proposal-service / score-service remain the enforcement
-- boundary, as they have been since those tables were created. This reopens the
-- DB-07 gap; it does not introduce a new one.
--
-- Re-enable only together with:
--   1. a reproduction of the failure in CI against a real Postgres, and
--   2. an extension of rls-fail-closed.test.ts that exercises the WRITE path
--      through withWorkspaceRLS for an EXISTS-join child table — the existing
--      coverage asserts reads, which is why this passed CI and failed in prod.

ALTER TABLE "ScanEvent" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Evidence" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanResultManifest" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanCoverageReceipt" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "FixProposal" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardShare" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardEvent" DISABLE ROW LEVEL SECURITY;
