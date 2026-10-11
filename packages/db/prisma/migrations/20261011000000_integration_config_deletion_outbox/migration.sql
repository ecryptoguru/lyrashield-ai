-- Integration credentials use the same encrypted, workspace-bound evidence
-- store as evidence and scan attachments. Keep the row-reference check inside
-- a narrow SECURITY DEFINER function so account erasure can enqueue durable
-- deletion before Integration and Workspace rows cascade away.

ALTER TABLE "ArtifactDeletionTask" DROP CONSTRAINT "ArtifactDeletionTask_kind_check";
ALTER TABLE "ArtifactDeletionTask"
  ADD CONSTRAINT "ArtifactDeletionTask_kind_check"
  CHECK ("kind" IN ('EVIDENCE', 'SCAN_ATTACHMENT', 'INTEGRATION_CONFIG'));

CREATE OR REPLACE FUNCTION app.enqueue_integration_config_deletion_task(
  p_id TEXT,
  p_workspace_id TEXT,
  p_storage_uri TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  task_id TEXT;
BEGIN
  IF app.current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'artifact deletion workspace context mismatch'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."Integration" integration
    WHERE integration."workspaceId" = p_workspace_id
      AND integration."configRef" = p_storage_uri
  ) THEN
    RAISE EXCEPTION 'artifact deletion URI is not an integration config for this workspace'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public."ArtifactDeletionTask" (
    id, "workspaceId", kind, "storageUri", status, attempts,
    "nextAttemptAt", "createdAt", "updatedAt"
  ) VALUES (
    p_id, p_workspace_id, 'INTEGRATION_CONFIG', p_storage_uri, 'PENDING', 0,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT (kind, "storageUri") DO UPDATE
    SET "updatedAt" = public."ArtifactDeletionTask"."updatedAt"
  RETURNING id INTO task_id;

  RETURN task_id;
END
$function$;

REVOKE ALL ON FUNCTION app.enqueue_integration_config_deletion_task(TEXT, TEXT, TEXT) FROM PUBLIC;

-- Match the existing enqueue function grants: a runtime role may enqueue only
-- for the workspace and URI proven by the SECURITY DEFINER function.
DO $grant_integration_config_deletion$
DECLARE
  grantee_role TEXT;
BEGIN
  FOR grantee_role IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'Integration'
      AND privilege_type = 'INSERT'
      AND grantee NOT IN ('PUBLIC')
      AND grantee <> current_user
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.enqueue_integration_config_deletion_task(text, text, text) TO %I',
      grantee_role
    );
  END LOOP;
END
$grant_integration_config_deletion$;
