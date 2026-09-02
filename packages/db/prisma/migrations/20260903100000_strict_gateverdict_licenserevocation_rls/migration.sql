-- GateVerdict has no unscoped reader. Remove the compatibility policy so a
-- missing workspace GUC fails closed under the runtime NOBYPASSRLS role.
DROP POLICY IF EXISTS gateverdict_rls_permissive ON "GateVerdict";

-- License revocations inherit tenant scope from their license. This is
-- additive: existing revocation rows remain available to the system client.
ALTER TABLE "LicenseRevocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LicenseRevocation" FORCE ROW LEVEL SECURITY;

CREATE POLICY licenserevocation_rls_strict ON "LicenseRevocation"
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM "License"
      WHERE "License".id = "LicenseRevocation"."licenseId"
        AND "License"."workspaceId" = app.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "License"
      WHERE "License".id = "LicenseRevocation"."licenseId"
        AND "License"."workspaceId" = app.current_workspace_id()
    )
  );
