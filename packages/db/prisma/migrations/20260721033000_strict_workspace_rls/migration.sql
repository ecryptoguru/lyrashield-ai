-- Fail closed for every workspace-scoped table.
--
-- The original rollout retained one allow-all policy while the transaction
-- context was absent. The application now sets app.current_workspace_id in the
-- same transaction as each workspace-scoped Prisma query, so that compatibility
-- policy is no longer safe or necessary.

DROP POLICY IF EXISTS project_rls_permissive ON "Project";
DROP POLICY IF EXISTS target_rls_permissive ON "Target";
DROP POLICY IF EXISTS credentialset_rls_permissive ON "CredentialSet";
DROP POLICY IF EXISTS policy_rls_permissive ON "Policy";
DROP POLICY IF EXISTS scan_rls_permissive ON "Scan";
DROP POLICY IF EXISTS apikey_rls_permissive ON "ApiKey";
DROP POLICY IF EXISTS finding_rls_permissive ON "Finding";
DROP POLICY IF EXISTS integration_rls_permissive ON "Integration";
DROP POLICY IF EXISTS usagerecord_rls_permissive ON "UsageRecord";
DROP POLICY IF EXISTS auditlog_rls_permissive ON "AuditLog";
DROP POLICY IF EXISTS report_rls_permissive ON "Report";
DROP POLICY IF EXISTS notification_rls_permissive ON "Notification";
DROP POLICY IF EXISTS schedule_rls_permissive ON "Schedule";
DROP POLICY IF EXISTS billingaccount_rls_permissive ON "BillingAccount";
DROP POLICY IF EXISTS invitation_rls_permissive ON "Invitation";
DROP POLICY IF EXISTS webhookevent_rls_permissive ON "WebhookEvent";
DROP POLICY IF EXISTS retest_rls_permissive ON "Retest";
DROP POLICY IF EXISTS agentapproval_rls_permissive ON "AgentApproval";
DROP POLICY IF EXISTS scoresnapshot_rls_permissive ON "ScoreSnapshot";
DROP POLICY IF EXISTS findingcandidate_rls_permissive ON "FindingCandidate";
DROP POLICY IF EXISTS findingverification_rls_permissive ON "FindingVerification";

-- Table owners normally bypass RLS. FORCE keeps the same deny-by-default
-- behavior during migrations, diagnostics, and any accidental owner-role use.
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Target" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CredentialSet" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Policy" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Scan" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Finding" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Integration" FORCE ROW LEVEL SECURITY;
ALTER TABLE "UsageRecord" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Report" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Schedule" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingAccount" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Retest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AgentApproval" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScoreSnapshot" FORCE ROW LEVEL SECURITY;
ALTER TABLE "FindingCandidate" FORCE ROW LEVEL SECURITY;
ALTER TABLE "FindingVerification" FORCE ROW LEVEL SECURITY;
