-- Additive authority generations invalidate pre-v2 dispatch intents; no paid work is replayed.
ALTER TABLE "Policy"
  ADD COLUMN "authorityIncarnation" TEXT NOT NULL DEFAULT pg_catalog.gen_random_uuid()::text,
  ADD COLUMN "authorityRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "Policy_authorityRevision_positive" CHECK ("authorityRevision" > 0);
ALTER TABLE "Scan"
  ADD COLUMN "policyBindingRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "Scan_policyBindingRevision_positive" CHECK ("policyBindingRevision" > 0);

CREATE FUNCTION app.scan_policy_authority_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW."authorityIncarnation":=pg_catalog.gen_random_uuid()::text;
    NEW."authorityRevision":=1;
  ELSE
    IF NEW."authorityIncarnation" IS DISTINCT FROM OLD."authorityIncarnation"
      OR NEW."authorityRevision" IS DISTINCT FROM OLD."authorityRevision" THEN
      RAISE EXCEPTION 'policy authority generation is database-owned' USING ERRCODE='23514';
    END IF;
    IF (pg_catalog.to_jsonb(NEW)-ARRAY['createdAt','updatedAt','authorityIncarnation','authorityRevision'])
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['createdAt','updatedAt','authorityIncarnation','authorityRevision']) THEN
      NEW."authorityRevision":=OLD."authorityRevision"+1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_policy_authority_generation BEFORE INSERT OR UPDATE ON "Policy"
  FOR EACH ROW EXECUTE FUNCTION app.scan_policy_authority_generation();

CREATE FUNCTION app.scan_policy_binding_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW."policyBindingRevision":=1;
  ELSE
    IF NEW."policyBindingRevision" IS DISTINCT FROM OLD."policyBindingRevision" THEN
      RAISE EXCEPTION 'scan policy binding generation is database-owned' USING ERRCODE='23514';
    END IF;
    IF NEW."policyId" IS DISTINCT FROM OLD."policyId" THEN
      NEW."policyBindingRevision":=OLD."policyBindingRevision"+1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_policy_binding_generation BEFORE INSERT OR UPDATE ON "Scan"
  FOR EACH ROW EXECUTE FUNCTION app.scan_policy_binding_generation();

CREATE OR REPLACE FUNCTION app.scan_policy_digest(policy_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(public.digest(convert_to(
    CASE WHEN policy_id IS NULL THEN jsonb_build_object('schemaVersion','scan-policy/none/2')
      WHEN p."id" IS NULL THEN jsonb_build_object('schemaVersion','scan-policy/missing/2','policyId',policy_id)
      ELSE (to_jsonb(p)-ARRAY['createdAt','updatedAt']) || jsonb_build_object('schemaVersion','scan-policy/2')
    END::text, 'UTF8'), 'sha256'), 'hex')
  FROM (SELECT 1) seed
  LEFT JOIN public."Policy" p ON p."id"=policy_id AND p."deletedAt" IS NULL
$$;

CREATE OR REPLACE FUNCTION app.scan_dispatch_scope_digest(scan_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'schemaVersion', 'scan-dispatch-scope/2',
    'scanId', s."id",
    'workspaceId', s."workspaceId",
    'initiatingUserId', s."createdById",
    'sponsorAccountId', coalesce(s."sponsorAccountId", s."createdById"),
    'targetId', s."targetId",
    'targetSnapshotDigest', app.scan_target_snapshot_digest(s."targetId"),
    'executionPlanHash', s."executionPlanHash",
    'policyId', coalesce(s."policyId", ''),
    'policyBindingRevision', s."policyBindingRevision"::text,
    'policyDigest', app.scan_policy_digest(s."policyId"),
    'delegatedAuthorizationVersion', s."delegatedAuthorizationVersion",
    'attachmentIds', coalesce(s."executionPlan"->'attachmentIds', '[]'::jsonb),
    'mode', s."mode"::text,
    'goal', s."goal"::text,
    'maxBudgetUsd', (s."executionPlan" #>> '{limits,maxBudgetUsd}')::numeric::text,
    'maxRuntimeMs', (s."executionPlan" #>> '{limits,maxDurationMs}')::integer
  )::text, 'UTF8'), 'sha256'), 'hex')
  FROM public."Scan" s
  WHERE s."id" = scan_id AND s."deletedAt" IS NULL
$$;

-- Existing attempts also require their original binding at START. This does not
-- authorize physical execution or replace the controller's invocation fence.
CREATE FUNCTION app.scan_policy_start_binding_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."ScanDispatchAttempt" a
    WHERE a."attemptId"=NEW."attemptId" AND a."operationId"=NEW."operationId"
      AND a."scopeDigest"=app.scan_dispatch_scope_digest(a."scanId")
      AND a."policyDigest"=app.scan_policy_digest(a."policyId")
      AND NEW."policyDigest"=a."policyDigest"
  ) THEN
    RAISE EXCEPTION 'START requires its current original policy binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_policy_start_binding_guard BEFORE INSERT ON "ScanDispatchStart"
  FOR EACH ROW EXECUTE FUNCTION app.scan_policy_start_binding_guard();
