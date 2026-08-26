-- Durable external-artifact deletion outbox for explicit account/workspace
-- deletion. No Workspace FK by design: the task must survive the tenant row's
-- hard-delete cascade until the external object has been removed.
--
-- This table is not exposed through tenant APIs and contains no artifact body,
-- actor identity, or customer metadata. Runtime and system roles use separate,
-- narrowly scoped SECURITY DEFINER functions; direct table access stays closed.
-- Every deletion also validates the workspace-bound object prefix before I/O.
CREATE TABLE "ArtifactDeletionTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactDeletionTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArtifactDeletionTask_kind_check" CHECK ("kind" = 'EVIDENCE'),
    CONSTRAINT "ArtifactDeletionTask_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'DEAD_LETTER')),
    CONSTRAINT "ArtifactDeletionTask_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "ArtifactDeletionTask_lease_check" CHECK (
      ("status" = 'PROCESSING' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
      OR
      ("status" <> 'PROCESSING' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
    )
);

CREATE UNIQUE INDEX "ArtifactDeletionTask_kind_storageUri_key"
    ON "ArtifactDeletionTask"("kind", "storageUri");
CREATE INDEX "ArtifactDeletionTask_status_nextAttemptAt_idx"
    ON "ArtifactDeletionTask"("status", "nextAttemptAt");
CREATE INDEX "ArtifactDeletionTask_workspaceId_idx"
    ON "ArtifactDeletionTask"("workspaceId");

-- Ordinary runtime roles may receive broad table grants during environment
-- provisioning. RLS with no table policy keeps direct reads/writes closed while
-- allowing only SECURITY DEFINER functions owned by the migration role to reach
-- the operational outbox. The table owner must remain able to execute those
-- functions even when the Azure migration role is not BYPASSRLS.
ALTER TABLE "ArtifactDeletionTask" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "ArtifactDeletionTask" FROM PUBLIC;

-- Runtime account deletion may enqueue only a URI already referenced by an
-- Evidence row in the currently bound workspace. SECURITY DEFINER is narrowly
-- scoped to this insert and cannot read or claim arbitrary tasks.
CREATE OR REPLACE FUNCTION app.enqueue_artifact_deletion_task(
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
    FROM public."Evidence" evidence
    JOIN public."Finding" finding ON finding.id = evidence."findingId"
    WHERE finding."workspaceId" = p_workspace_id
      AND (evidence."storageUri" = p_storage_uri OR evidence."redactedStorageUri" = p_storage_uri)
  ) THEN
    RAISE EXCEPTION 'artifact deletion URI is not retained evidence for this workspace'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public."ArtifactDeletionTask" (
    id, "workspaceId", kind, "storageUri", status, attempts,
    "nextAttemptAt", "createdAt", "updatedAt"
  ) VALUES (
    p_id, p_workspace_id, 'EVIDENCE', p_storage_uri, 'PENDING', 0,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT (kind, "storageUri") DO UPDATE
    SET "updatedAt" = public."ArtifactDeletionTask"."updatedAt"
  RETURNING id INTO task_id;

  RETURN task_id;
END
$function$;

REVOKE ALL ON FUNCTION app.enqueue_artifact_deletion_task(TEXT, TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.claim_artifact_deletion_task(
  p_task_ids TEXT[],
  p_now TIMESTAMP(3),
  p_lease_token TEXT,
  p_lease_expires_at TIMESTAMP(3)
) RETURNS SETOF public."ArtifactDeletionTask"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT task.id
    FROM public."ArtifactDeletionTask" task
    WHERE (p_task_ids IS NULL OR task.id = ANY(p_task_ids))
      AND (
        (task.status = 'PENDING' AND task."nextAttemptAt" <= p_now)
        OR
        (task.status = 'PROCESSING' AND task."leaseExpiresAt" < p_now)
      )
    ORDER BY task."nextAttemptAt" ASC, task."createdAt" ASC, task.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public."ArtifactDeletionTask" task
  SET status = 'PROCESSING',
      attempts = task.attempts + 1,
      "leaseToken" = p_lease_token,
      "leaseExpiresAt" = p_lease_expires_at,
      "lastError" = NULL,
      "updatedAt" = p_now
  FROM candidate
  WHERE task.id = candidate.id
  RETURNING task.*;
END
$function$;

CREATE OR REPLACE FUNCTION app.complete_artifact_deletion_task(
  p_id TEXT,
  p_lease_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public."ArtifactDeletionTask"
  WHERE id = p_id AND status = 'PROCESSING' AND "leaseToken" = p_lease_token;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION app.fail_artifact_deletion_task(
  p_id TEXT,
  p_lease_token TEXT,
  p_status TEXT,
  p_next_attempt_at TIMESTAMP(3),
  p_last_error TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  updated_count INTEGER;
BEGIN
  IF p_status NOT IN ('PENDING', 'DEAD_LETTER') THEN
    RAISE EXCEPTION 'invalid artifact deletion failure status' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public."ArtifactDeletionTask"
  SET status = p_status,
      "nextAttemptAt" = p_next_attempt_at,
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "lastError" = left(p_last_error, 500),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE id = p_id AND status = 'PROCESSING' AND "leaseToken" = p_lease_token;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION app.count_dead_letter_artifact_deletion_tasks()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  SELECT count(*)::bigint
  FROM public."ArtifactDeletionTask"
  WHERE status = 'DEAD_LETTER'
$function$;

REVOKE ALL ON FUNCTION app.claim_artifact_deletion_task(TEXT[], TIMESTAMP, TEXT, TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_artifact_deletion_task(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_artifact_deletion_task(TEXT, TEXT, TEXT, TIMESTAMP, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.count_dead_letter_artifact_deletion_tasks() FROM PUBLIC;

-- Match the existing API-key SECURITY DEFINER grant pattern without granting
-- any function to PUBLIC. Runtime roles that already write Evidence may enqueue;
-- only reviewed production system roles may claim/complete/fail after cascade.
DO $grant_artifact_deletion$
DECLARE
  grantee_role TEXT;
BEGIN
  FOR grantee_role IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'Evidence'
      AND privilege_type = 'INSERT'
      AND grantee NOT IN ('PUBLIC')
      AND grantee <> current_user
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.enqueue_artifact_deletion_task(text, text, text) TO %I',
      grantee_role
    );
  END LOOP;

  FOR grantee_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('app_system_prod')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.claim_artifact_deletion_task(text[], timestamp, text, timestamp) TO %I',
      grantee_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.complete_artifact_deletion_task(text, text) TO %I',
      grantee_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.fail_artifact_deletion_task(text, text, text, timestamp, text) TO %I',
      grantee_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.count_dead_letter_artifact_deletion_tasks() TO %I',
      grantee_role
    );
  END LOOP;
END
$grant_artifact_deletion$;
