-- ScanAttachment has no unscoped reader: every accessor binds
-- app.current_workspace_id (withWorkspaceRLS in the service, the bound GUC
-- inside the account-deletion transaction or the enqueue function's own
-- bound-context check). Drop the compatibility policy so a missing workspace
-- context fails closed under the runtime NOBYPASSRLS role — an unbound read
-- can never return another tenant's attachment metadata.

DROP POLICY IF EXISTS scanattachment_rls_permissive ON "ScanAttachment";
