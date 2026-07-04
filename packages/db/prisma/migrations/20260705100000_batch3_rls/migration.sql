-- Batch 3: Postgres Row Level Security (RLS) on workspace-scoped tables
-- Defense-in-depth: the Prisma client extension already injects workspaceId
-- in WHERE clauses via AsyncLocalStorage. RLS provides a DB-level backstop.
--
-- Policy logic:
--   1. When app.current_workspace_id is set (via SET LOCAL in a transaction),
--      only rows with matching workspace_id are visible.
--   2. When app.current_workspace_id is NOT set (empty or NULL), all rows are
--      visible. This preserves backward compat for code paths that don't yet
--      use the withWorkspaceRLS transaction wrapper.
--
-- Tables excluded from RLS (deliberately):
--   - WorkspaceMember: queried cross-workspace (workspace switcher)
--   - OnboardingState: per-user, not tenant data
--   - Workspace: the parent table itself (queried by ID, not scoped)
--   - ScanEvent, Evidence, FixProposal, PullRequest, Ticket: child tables
--     without a direct workspaceId column (scoped via parent FKs)

-- Enable RLS on all workspace-scoped tables
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Target" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Scan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Finding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Integration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Retest" ENABLE ROW LEVEL SECURITY;

-- Helper function: safely get the current workspace setting as text.
-- Returns NULL if the setting is not set or is empty.
CREATE OR REPLACE FUNCTION app.current_workspace_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_workspace_id', true), '')
$$;

-- Permissive policy: allow all when no workspace context is set (backward compat)
-- Strict policy: only matching workspace_id when context IS set

-- Project
CREATE POLICY project_rls_permissive ON "Project"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY project_rls_strict ON "Project"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Target
CREATE POLICY target_rls_permissive ON "Target"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY target_rls_strict ON "Target"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- CredentialSet
CREATE POLICY credentialset_rls_permissive ON "CredentialSet"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY credentialset_rls_strict ON "CredentialSet"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Policy
CREATE POLICY policy_rls_permissive ON "Policy"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY policy_rls_strict ON "Policy"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Scan
CREATE POLICY scan_rls_permissive ON "Scan"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY scan_rls_strict ON "Scan"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- ApiKey
CREATE POLICY apikey_rls_permissive ON "ApiKey"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY apikey_rls_strict ON "ApiKey"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Finding
CREATE POLICY finding_rls_permissive ON "Finding"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY finding_rls_strict ON "Finding"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Integration
CREATE POLICY integration_rls_permissive ON "Integration"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY integration_rls_strict ON "Integration"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- UsageRecord
CREATE POLICY usagerecord_rls_permissive ON "UsageRecord"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY usagerecord_rls_strict ON "UsageRecord"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- AuditLog
CREATE POLICY auditlog_rls_permissive ON "AuditLog"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY auditlog_rls_strict ON "AuditLog"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Report
CREATE POLICY report_rls_permissive ON "Report"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY report_rls_strict ON "Report"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Notification
CREATE POLICY notification_rls_permissive ON "Notification"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY notification_rls_strict ON "Notification"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Schedule
CREATE POLICY schedule_rls_permissive ON "Schedule"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY schedule_rls_strict ON "Schedule"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- BillingAccount
CREATE POLICY billingaccount_rls_permissive ON "BillingAccount"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY billingaccount_rls_strict ON "BillingAccount"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Invitation
CREATE POLICY invitation_rls_permissive ON "Invitation"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY invitation_rls_strict ON "Invitation"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- WebhookEvent (workspaceId is nullable — allow when NULL or matching)
CREATE POLICY webhookevent_rls_permissive ON "WebhookEvent"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY webhookevent_rls_strict ON "WebhookEvent"
  FOR ALL USING ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id());

-- Retest
CREATE POLICY retest_rls_permissive ON "Retest"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY retest_rls_strict ON "Retest"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
