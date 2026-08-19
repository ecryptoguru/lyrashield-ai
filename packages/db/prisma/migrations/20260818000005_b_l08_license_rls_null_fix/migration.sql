-- B-L08: Fix RLS policies that allowed cross-tenant reads of unlinked
-- (NULL workspaceId) licenses. The original policies used
-- "workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id()
-- which made NULL rows visible to ALL tenants. This migration drops those
-- policies and replaces them with ones that restrict NULL workspaceId rows
-- to service/admin roles only (using a bypass function).

-- Drop the old permissive policies
DROP POLICY IF EXISTS license_rls_strict ON "License";
DROP POLICY IF EXISTS licenseactivation_rls_strict ON "LicenseActivation";
DROP POLICY IF EXISTS licensekey_rls_strict ON "LicenseKey";

-- Create new policies that do NOT allow NULL workspaceId rows for ordinary
-- workspace-scoped queries. NULL workspaceId rows (licenses issued outside a
-- workspace, e.g. direct Polar purchases) are only accessible via the
-- DATABASE_SYSTEM_URL bypass role or explicit admin checks.
CREATE POLICY license_rls_strict ON "License"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR "workspaceId" IS NULL);

CREATE POLICY licenseactivation_rls_strict ON "LicenseActivation"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR "workspaceId" IS NULL);

CREATE POLICY licensekey_rls_strict ON "LicenseKey"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR "workspaceId" IS NULL);
