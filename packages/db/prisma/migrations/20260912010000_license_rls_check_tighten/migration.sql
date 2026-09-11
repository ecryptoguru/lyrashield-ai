-- B-002 (2026-09-11 review): license-family WITH CHECK permitted
-- workspaceId IS NULL writes under ANY workspace context, so a scoped
-- session could insert license rows invisible to every workspace (the USING
-- side already hides NULL rows). NULL-attribution license rows are minted
-- only by fulfillment/issue/activate paths, all of which run under the
-- privileged system role — so the runtime role must not be able to write
-- them. Drop the NULL clause from WITH CHECK.
--
-- Forward-only policy change: no data rewritten; the privileged role
-- (BYPASSRLS) is unaffected.

DROP POLICY license_rls_strict ON "License";
CREATE POLICY license_rls_strict ON "License"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

DROP POLICY licenseactivation_rls_strict ON "LicenseActivation";
CREATE POLICY licenseactivation_rls_strict ON "LicenseActivation"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

DROP POLICY licensekey_rls_strict ON "LicenseKey";
CREATE POLICY licensekey_rls_strict ON "LicenseKey"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
