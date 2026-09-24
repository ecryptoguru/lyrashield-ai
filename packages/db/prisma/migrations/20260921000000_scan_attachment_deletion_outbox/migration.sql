-- Scan attachment objects are encrypted artifacts under the same
-- evidence/<workspaceId>/ object prefix as Evidence. The durable deletion
-- outbox now tracks them as a distinct kind so both erasure paths (account
-- deletion's workspace cascade and explicit attachment deletion) leave a
-- retryable task behind: the metadata row can be soft-deleted or cascade away
-- while the external object removal keeps retrying until it succeeds.
--
-- Additive only: widen the kind CHECK, then add a narrowly scoped SECURITY
-- DEFINER enqueue that authorizes a ScanAttachment URI belonging to the
-- currently bound workspace. The existing Evidence enqueue, claim, complete
-- and fail contracts are unchanged.

ALTER TABLE "ArtifactDeletionTask" DROP CONSTRAINT "ArtifactDeletionTask_kind_check";
ALTER TABLE "ArtifactDeletionTask"
  ADD CONSTRAINT "ArtifactDeletionTask_kind_check"
  CHECK ("kind" IN ('EVIDENCE', 'SCAN_ATTACHMENT'));

-- Runtime deletion paths may enqueue only a URI already referenced by a
-- ScanAttachment row in the currently bound workspace — any status, since a
-- soft-deleted row's object still needs removal. SECURITY DEFINER is narrowly
-- scoped to this insert and cannot read or claim arbitrary tasks.
CREATE OR REPLACE FUNCTION app.enqueue_scan_attachment_deletion_task(
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
    FROM public."ScanAttachment" attachment
    WHERE attachment."workspaceId" = p_workspace_id
      AND attachment."storageUri" = p_storage_uri
  ) THEN
    RAISE EXCEPTION 'artifact deletion URI is not a scan attachment for this workspace'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public."ArtifactDeletionTask" (
    id, "workspaceId", kind, "storageUri", status, attempts,
    "nextAttemptAt", "createdAt", "updatedAt"
  ) VALUES (
    p_id, p_workspace_id, 'SCAN_ATTACHMENT', p_storage_uri, 'PENDING', 0,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT (kind, "storageUri") DO UPDATE
    SET "updatedAt" = public."ArtifactDeletionTask"."updatedAt"
  RETURNING id INTO task_id;

  RETURN task_id;
END
$function$;

REVOKE ALL ON FUNCTION app.enqueue_scan_attachment_deletion_task(TEXT, TEXT, TEXT) FROM PUBLIC;

-- Match the Evidence enqueue grant pattern without granting the function to
-- PUBLIC: runtime roles that already write ScanAttachment rows may enqueue;
-- claim/complete/fail remain limited to the reviewed system roles.
DO $grant_scan_attachment_deletion$
DECLARE
  grantee_role TEXT;
BEGIN
  FOR grantee_role IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'ScanAttachment'
      AND privilege_type = 'INSERT'
      AND grantee NOT IN ('PUBLIC')
      AND grantee <> current_user
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.enqueue_scan_attachment_deletion_task(text, text, text) TO %I',
      grantee_role
    );
  END LOOP;
END
$grant_scan_attachment_deletion$;
