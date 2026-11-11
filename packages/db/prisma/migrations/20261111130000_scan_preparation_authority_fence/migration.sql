-- Checked PREPARE intent only. No production grants, activation, backfill, or
-- physical-consumption authority. Maintenance must drain before DDL/TRUNCATE.
ALTER TABLE "ScanDispatchAttempt"
  ADD COLUMN "authorityAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "authorityDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "authorityTransactionId" TEXT,
  ADD CONSTRAINT "ScanDispatchAttempt_checked_authority_check" CHECK (
    ("authorityAcceptedAt" IS NULL AND "authorityDeadlineAt" IS NULL AND "authorityTransactionId" IS NULL)
    OR ("authorityAcceptedAt" IS NOT NULL AND "authorityDeadlineAt" IS NOT NULL AND "authorityTransactionId" IS NOT NULL
      AND "authorityTransactionId" ~ '^[0-9]+$'
      AND isfinite("authorityAcceptedAt") AND isfinite("authorityDeadlineAt")
      AND "authorityDeadlineAt" > "authorityAcceptedAt"
      AND "authorityDeadlineAt" <= "expiresAt"
      AND "authorityDeadlineAt" <= "authorityAcceptedAt" + interval '10 seconds')
  );

-- The only new definer: a private SELECT of persisted context, before RLS is
-- bound. A definer owner unable to read forced-RLS rows fails closed.
CREATE FUNCTION app.scan_preparation_context(operation_id TEXT)
RETURNS TABLE("workspaceId" TEXT, "accountId" TEXT, "userId" TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT o."workspaceId", coalesce(s."sponsorAccountId",s."createdById"),s."createdById"
  FROM public."ScanDispatchOperation" o JOIN public."Scan" s
    ON s.id=o."scanId" AND s."workspaceId"=o."workspaceId"
  WHERE o."operationId"=operation_id
$$;
REVOKE ALL ON FUNCTION app.scan_preparation_context(TEXT) FROM PUBLIC;

CREATE FUNCTION app.require_scan_preparation_role() RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE name TEXT; column_name TEXT; role_name TEXT;
BEGIN
  IF session_user IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'preparation requires a direct restricted login' USING ERRCODE='42501';
  END IF;
  FOR role_name IN SELECT rolname FROM pg_catalog.pg_roles WHERE pg_has_role(current_user,oid,'SET') LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
    OR has_schema_privilege(role_name,'public','CREATE') OR has_schema_privilege(role_name,'app','CREATE')
    OR has_database_privilege(role_name,current_database(),'CREATE')
    OR has_database_privilege(role_name,current_database(),'TEMPORARY') THEN
    RAISE EXCEPTION 'preparation broker role can bypass authority isolation' USING ERRCODE='42501';
  END IF;
  FOREACH name IN ARRAY ARRAY['Workspace','WorkspaceMember','users','BillingAccount','agent_connections',
    'agent_operations','delegated_scan_provenance','Target','Policy'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER')
      OR has_any_column_privilege(role_name,format('public.%I',name),'UPDATE') THEN
      RAISE EXCEPTION 'preparation broker role has authority writer privileges' USING ERRCODE='42501';
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['Scan','UserScanSlot','ScanCapacityReservation','ScanAuthorityEpoch','ScanWorkerInstanceGrant'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'preparation broker role has authority writer privileges' USING ERRCODE='42501';
    END IF;
    FOR column_name IN SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid=format('public.%I',name)::regclass AND attnum>0 AND NOT attisdropped AND attname<>'updatedAt' LOOP
      IF has_column_privilege(role_name,format('public.%I',name),column_name,'UPDATE') THEN
        RAISE EXCEPTION 'preparation broker role has authority writer privileges' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ScanDispatchStart','ScanSupervisorReceipt','ScanPhysicalExecutionTransition','ScanDispatchReleaseReceipt'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER')
      OR has_any_column_privilege(role_name,format('public.%I',name),'UPDATE') THEN
      RAISE EXCEPTION 'preparation broker role can consume physical authority' USING ERRCODE='42501';
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ScanDispatchOperation','ScanDispatchAttempt','ScanDispatchOutbox','ScanPhysicalExecution','ScanQueueOutbox'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'preparation broker role can bypass immutable intent' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef
      AND p.oid<>'app.scan_preparation_context(text)'::regprocedure
      AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'preparation broker role can reach an unreviewed definer' USING ERRCODE='42501';
  END IF;
  END LOOP;
END $$;

CREATE FUNCTION app.scan_preparation_gate_held() RETURNS BOOLEAN
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
    AND pid=pg_backend_pid() AND classid=1819234670 AND objid=1 AND objsubid=2
    AND mode='ExclusiveLock' AND granted)
$$;

CREATE FUNCTION app.scan_preparation_writer_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  -- Advisory locks are reentrant. Never permit a source-authority write by a
  -- transaction which already accepted preparation, even after SET CONSTRAINTS.
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
    AND pid=pg_backend_pid() AND classid=1819234670 AND objid=1 AND objsubid=2
    AND mode='ExclusiveLock' AND granted) THEN
    RAISE EXCEPTION 'authority writes are forbidden after the preparation gate' USING ERRCODE='23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1819234670,1);
  RETURN NULL;
END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['Workspace','WorkspaceMember','users','BillingAccount',
    'agent_connections','agent_operations','delegated_scan_provenance','Target','Policy',
    'Scan','UserScanSlot','ScanCapacityReservation'] LOOP
    EXECUTE format('CREATE TRIGGER scan_preparation_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.scan_preparation_writer_gate()',name);
  END LOOP;
END $$;

CREATE FUNCTION app.acquire_scan_preparation_gate() RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  PERFORM app.require_scan_preparation_role();
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'preparation requires READ COMMITTED' USING ERRCODE='23514';
  END IF;
  -- Taken after existing broker locks; never wait and introduce a lock cycle.
  RETURN pg_catalog.pg_try_advisory_xact_lock(1819234670,1);
END $$;

-- Canonical JSON for the bounded accepted plan shape. Keys are a fixed ASCII
-- vocabulary; numbers below are restricted to safe integers and <=4-place
-- budget decimals, avoiding ECMAScript exponential/rounding differences.
-- Native JSONB quoting supplies exact UTF-8/control-character escaping.
CREATE FUNCTION app.scan_preparation_plan_json(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,app AS $$
DECLARE output TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||app.scan_preparation_plan_json(item),',' ORDER BY key COLLATE "C"),'')||'}'
        INTO output FROM jsonb_each(value) AS e(key,item);
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(app.scan_preparation_plan_json(item),',' ORDER BY ordinal),'')||']'
        INTO output FROM jsonb_array_elements(value) WITH ORDINALITY AS a(item,ordinal);
    WHEN 'number' THEN output:=trim_scale((value#>>'{}')::numeric)::text;
    ELSE output:=value::text;
  END CASE;
  RETURN output;
END $$;
REVOKE ALL ON FUNCTION app.scan_preparation_plan_json(JSONB) FROM PUBLIC;

-- This must run in a separate statement AFTER gate acquisition. One captured,
-- floored UTC wall clock supplies all decisions; it never promises COMMIT-time
-- validity. A supervisor must independently revalidate before consuming intent.
CREATE FUNCTION app.check_scan_preparation_authority(scan_id TEXT, expires_at TIMESTAMP)
RETURNS TABLE("acceptedAt" TIMESTAMP(3), "deadlineAt" TIMESTAMP(3))
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, app AS $$
DECLARE
  s public."Scan"%ROWTYPE; w public."Workspace"%ROWTYPE;
  c public.agent_connections%ROWTYPE; b public."BillingAccount"%ROWTYPE;
  at_time TIMESTAMP(3) := date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC');
  deadline TIMESTAMP(3); trial_start TIMESTAMP(3); effective_plan TEXT := 'FREE';
  profile TEXT; budget NUMERIC; duration INTEGER; ranked_count INTEGER;
BEGIN
  PERFORM app.require_scan_preparation_role();
  IF current_setting('transaction_isolation') <> 'read committed' OR NOT app.scan_preparation_gate_held() THEN
    RAISE EXCEPTION 'preparation requires its READ COMMITTED transaction gate' USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM public."Scan" WHERE id=scan_id AND "workspaceId"=app.current_workspace_id();
  IF NOT FOUND OR s."accountingVersion" IS DISTINCT FROM 2 OR s."deletedAt" IS NOT NULL
    OR s.status NOT IN ('QUEUED','PREFLIGHT') OR s."executionPlan" IS NULL
    OR coalesce(s."sponsorAccountId",s."createdById") IS DISTINCT FROM app.current_account_id() THEN
    RAISE EXCEPTION 'preparation scan/account authority unavailable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO w FROM public."Workspace" WHERE id=s."workspaceId" AND "deletedAt" IS NULL;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public."WorkspaceMember"
    WHERE "workspaceId"=s."workspaceId" AND "userId"=s."createdById" AND status='active')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=s."createdById") THEN
    RAISE EXCEPTION 'preparation membership revoked' USING ERRCODE='23514';
  END IF;
  -- All recognized MemberRole values receive operational permissions in the
  -- canonical auth post-map loop. Executable parity is a required fixture gate.
  IF coalesce(w."agencySponsorAccountId",s."createdById") IS DISTINCT FROM app.current_account_id()
    OR (w."agencySponsorAccountId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."WorkspaceMember"
      WHERE "workspaceId"=s."workspaceId" AND "userId"=w."agencySponsorAccountId" AND status='active' AND role='OWNER')) THEN
    RAISE EXCEPTION 'preparation sponsor changed or revoked' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public."Target" WHERE id=s."targetId" AND "workspaceId"=s."workspaceId"
    AND type='REPO' AND status='active' AND "deletedAt" IS NULL)
    OR s."executionPlan"->>'targetType' IS DISTINCT FROM 'REPO'
    OR coalesce(s."executionPlan"->>'workflow','') NOT IN ('REVIEW_TARGET','REVIEW_CHANGES')
    OR coalesce(s."executionPlan"->'attachmentIds','[]'::jsonb) <> '[]'::jsonb
    OR s."executionPlan" ? 'authorizationRef' THEN
    RAISE EXCEPTION 'unsupported preparation target/workflow/attachment authority' USING ERRCODE='23514';
  END IF;
  -- Raw SQL cannot skip the executable stored-plan hash check. Unsupported
  -- keys/types/nulls/numeric shapes are closed, rather than approximated.
  IF octet_length(s."executionPlan"::text)>16384
    OR s."executionPlan"->>'version' IS DISTINCT FROM 'lyrashield-scan-plan/1.0.0'
    OR jsonb_typeof(s."executionPlan") IS DISTINCT FROM 'object'
    OR jsonb_typeof(s."executionPlan"->'source') IS DISTINCT FROM 'object'
    OR jsonb_typeof(s."executionPlan"->'limits') IS DISTINCT FROM 'object'
    OR jsonb_typeof(s."executionPlan"->'capabilities') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s."executionPlan"->'attachmentIds') IS DISTINCT FROM 'array'
    OR s."executionPlan"->>'depth' IS DISTINCT FROM
      (CASE WHEN s.mode IN ('SAFE','QUICK') THEN 'QUICK' WHEN s.mode='STANDARD' THEN 'STANDARD' ELSE 'DEEP' END)
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(s."executionPlan") k WHERE k NOT IN
      ('version','workflow','targetType','depth','profileId','scope','source','limits','capabilities','attachmentIds'))
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(s."executionPlan"->'source') k WHERE k NOT IN
      ('revision','baseRevision','mergeBaseRevision'))
    OR EXISTS(SELECT 1 FROM jsonb_each(s."executionPlan"->'source') e WHERE jsonb_typeof(e.value)<>'string'
      OR (e.value#>>'{}') !~ '^[a-f0-9]{40}([a-f0-9]{24})?$')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(s."executionPlan"->'limits') k WHERE k NOT IN
      ('maxBudgetUsd','maxDurationMs','maxEngineMs','scannerReserveMs'))
    OR NOT (s."executionPlan"->'limits' ?& ARRAY['maxBudgetUsd','maxDurationMs','maxEngineMs','scannerReserveMs'])
    OR EXISTS(SELECT 1 FROM jsonb_each(s."executionPlan"->'limits') e WHERE jsonb_typeof(e.value)<>'number'
      OR (e.value#>>'{}')::numeric<0 OR (e.value#>>'{}')::numeric>2700000
      OR (e.key='maxBudgetUsd' AND (e.value#>>'{}')::numeric<>round((e.value#>>'{}')::numeric,4))
      OR (e.key<>'maxBudgetUsd' AND (e.value#>>'{}')::numeric<>trunc((e.value#>>'{}')::numeric)))
    OR jsonb_array_length(s."executionPlan"->'capabilities')>32
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(s."executionPlan"->'capabilities') AS cap(value)
      WHERE jsonb_typeof(cap.value)<>'string' OR octet_length(cap.value#>>'{}') NOT BETWEEN 1 AND 64)
    OR encode(public.digest(convert_to(app.scan_preparation_plan_json(s."executionPlan"),'UTF8'),'sha256'),'hex')
      IS DISTINCT FROM s."executionPlanHash" THEN
    RAISE EXCEPTION 'unsupported or hash-mismatched preparation plan' USING ERRCODE='23514';
  END IF;
  IF (s.goal='CHECK_PR') IS DISTINCT FROM (s."executionPlan"->>'workflow'='REVIEW_CHANGES')
    OR (s."executionPlan"->>'workflow'='REVIEW_TARGET' AND s."executionPlan"->>'scope' IS DISTINCT FROM 'SNAPSHOT')
    OR (s."executionPlan"->>'workflow'='REVIEW_CHANGES' AND
      (s."executionPlan"->>'scope' IS DISTINCT FROM 'DIFF'
       OR coalesce(s."executionPlan"#>>'{source,baseRevision}','') !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
       OR coalesce(s."executionPlan"#>>'{source,mergeBaseRevision}','') !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'))
    OR coalesce(s."executionPlan"#>>'{source,revision}','') !~ '^[a-f0-9]{40}([a-f0-9]{24})?$' THEN
    RAISE EXCEPTION 'preparation review goal/source mismatch' USING ERRCODE='23514';
  END IF;
  profile := CASE WHEN s.mode IN ('SAFE','QUICK') THEN 'REPO_QUICK' WHEN s.mode='STANDARD' THEN 'REPO_STANDARD' ELSE 'REPO_DEEP' END;
  budget := CASE WHEN s.mode IN ('SAFE','QUICK') THEN 1.2 WHEN s.mode='STANDARD' THEN 3.2 ELSE 5 END;
  duration := CASE WHEN s.mode IN ('DEEP','CUSTOM') THEN 2700000 ELSE 1380000 END;
  IF s."executionPlan"->>'profileId' IS DISTINCT FROM profile
    OR (s."executionPlan"#>>'{limits,maxBudgetUsd}')::numeric NOT BETWEEN 0 AND budget
    OR (s."executionPlan"#>>'{limits,maxDurationMs}')::integer NOT BETWEEN 1 AND duration
    OR (s."executionPlan"#>>'{limits,maxEngineMs}')::integer > (CASE WHEN s.mode IN ('DEEP','CUSTOM') THEN 2400000 ELSE 1200000 END)
    OR (s."executionPlan"#>>'{limits,scannerReserveMs}')::integer > (CASE WHEN s.mode IN ('DEEP','CUSTOM') THEN 300000 ELSE 180000 END)
    OR (s."executionPlan"#>>'{limits,maxEngineMs}')::integer+(s."executionPlan"#>>'{limits,scannerReserveMs}')::integer > (s."executionPlan"#>>'{limits,maxDurationMs}')::integer
    OR (s."policyId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."Policy"
      WHERE id=s."policyId" AND "workspaceId"=s."workspaceId" AND "deletedAt" IS NULL
        AND ("maxBudgetUsd" IS NULL OR "maxBudgetUsd">=0))) THEN
    RAISE EXCEPTION 'preparation profile or policy unavailable' USING ERRCODE='23514';
  END IF;
  -- Rank exactly as account.ts. Equal leading rank/start/update tuples remain
  -- ambiguous; no arbitrary subscription is chosen to grant authority.
  WITH ranked AS (SELECT id,dense_rank() OVER (ORDER BY
    CASE WHEN status IN ('active','trialing') OR (status IN ('past_due','canceled') AND "currentPeriodEnd">at_time)
      THEN CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'canceled' THEN 2 WHEN 'trialing' THEN 3 ELSE 6 END
      WHEN status='trial_expired' THEN 4 ELSE 6 END,
    coalesce("currentPeriodStart",'1970-01-01'::timestamp) DESC,"updatedAt" DESC) AS rank
    FROM public."BillingAccount" WHERE "accountId"=app.current_account_id() AND "deletedAt" IS NULL)
  SELECT count(*) INTO ranked_count FROM ranked WHERE rank=1;
  IF ranked_count>1 THEN RAISE EXCEPTION 'ambiguous preparation entitlement' USING ERRCODE='23514'; END IF;
  SELECT * INTO b FROM public."BillingAccount" WHERE "accountId"=app.current_account_id() AND "deletedAt" IS NULL
    ORDER BY CASE WHEN status IN ('active','trialing') OR (status IN ('past_due','canceled') AND "currentPeriodEnd">at_time)
      THEN CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'canceled' THEN 2 WHEN 'trialing' THEN 3 ELSE 6 END
      WHEN status='trial_expired' THEN 4 ELSE 6 END,
      coalesce("currentPeriodStart",'1970-01-01'::timestamp) DESC,"updatedAt" DESC LIMIT 1;
  IF FOUND AND (b.status IN ('active','trialing') OR (b.status IN ('past_due','canceled') AND b."currentPeriodEnd">at_time)) THEN
    effective_plan := b."currentPlan"::text;
  END IF;
  SELECT "trialStartedAt" INTO trial_start FROM public.users WHERE id=app.current_account_id();
  IF NOT FOUND OR (effective_plan='FREE' AND trial_start IS NOT NULL AND at_time>trial_start+interval '7 days')
    OR (s.mode IN ('DEEP','CUSTOM') AND effective_plan NOT IN ('PRO','LAUNCH_ASSURANCE','ENTERPRISE'))
    OR (w."agencySponsorAccountId" IS NOT NULL AND s."createdById"<>w."agencySponsorAccountId" AND effective_plan<>'LAUNCH_ASSURANCE') THEN
    RAISE EXCEPTION 'preparation entitlement unavailable' USING ERRCODE='23514';
  END IF;
  deadline := least(at_time+interval '10 seconds',date_trunc('milliseconds',expires_at));
  IF b.status IN ('past_due','canceled') AND effective_plan<>'FREE' THEN deadline:=least(deadline,b."currentPeriodEnd"); END IF;
  IF effective_plan='FREE' AND trial_start IS NOT NULL THEN deadline:=least(deadline,trial_start+interval '7 days'); END IF;
  IF s."delegatedConnectionId" IS NOT NULL THEN
    SELECT * INTO c FROM public.agent_connections WHERE id=s."delegatedConnectionId" AND "workspaceId"=s."workspaceId";
    IF NOT FOUND OR c.status<>'ACTIVE' OR c."revokedAt" IS NOT NULL OR c."userId"<>s."createdById"
      OR c."authorizationVersion" IS DISTINCT FROM s."delegatedAuthorizationVersion"
      OR NOT ('lyrashield.write'=ANY(c.scopes)) OR NOT (s.mode::text=ANY(c."allowedProfiles"))
      OR NOT ((CASE WHEN s."triggerType"='retest' THEN 'retest.create' ELSE 'scan.create' END)=ANY(c."allowedOperations"))
      OR NOT (c."allTargets" OR s."targetId"=ANY(c."allowedTargetIds"))
      OR (c."expiresAt" IS NOT NULL AND c."expiresAt"<=at_time)
      OR NOT EXISTS(SELECT 1 FROM public.delegated_scan_provenance p JOIN public.agent_operations o ON o.id=p."operationId"
        WHERE p."scanId"=s.id AND p."workspaceId"=s."workspaceId" AND p."targetId"=s."targetId"
          AND p."connectionId"=c.id AND p."authorizationVersion"=c."authorizationVersion"
          AND p."scanExecutionPlanHash"=s."executionPlanHash" AND p."operationInputHash"=o."inputHash"
          AND o."connectionId"=c.id AND o."principalId"=c.id AND o."principalType"='OAUTH_CONNECTION'
          AND o."authorizationVersion"=c."authorizationVersion" AND o."resultReference"=s.id
          AND o."workspaceId"=s."workspaceId"
          AND o."operationName"=(CASE WHEN s."triggerType"='retest' THEN 'retest.create' ELSE 'scan.create' END)
          AND o.status IN ('EXECUTING','COMPLETED') AND o."admissionProofHash" ~ '^[a-f0-9]{64}$') THEN
      RAISE EXCEPTION 'preparation delegation revoked or unproven' USING ERRCODE='23514';
    END IF;
    deadline := least(deadline,c."expiresAt");
  ELSIF s."delegatedAuthorizationVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'preparation delegation incomplete' USING ERRCODE='23514';
  END IF;
  deadline := date_trunc('milliseconds',deadline);
  IF NOT isfinite(at_time) OR NOT isfinite(deadline) OR deadline<=at_time THEN
    RAISE EXCEPTION 'preparation authority expired' USING ERRCODE='23514';
  END IF;
  RETURN QUERY SELECT at_time,deadline;
END $$;

CREATE FUNCTION app.scan_checked_preparation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE checked RECORD; grant_expiry TIMESTAMP(3);
BEGIN
  IF NOT isfinite(NEW."expiresAt") THEN
    RAISE EXCEPTION 'preparation expiry must be finite' USING ERRCODE='23514';
  END IF;
  SELECT "expiresAt" INTO grant_expiry FROM public."ScanWorkerInstanceGrant"
    WHERE id=NEW."workerInstanceGrantId" AND "revokedAt" IS NULL;
  SELECT * INTO checked FROM app.check_scan_preparation_authority(NEW."scanId",least(NEW."expiresAt",grant_expiry));
  IF NOT EXISTS(SELECT 1 FROM public."ScanCapacityReservation" r
    WHERE r."scanId"=NEW."scanId" AND r."workspaceId"=NEW."workspaceId"
      AND r."accountId"=NEW."sponsorAccountId" AND r."userId"=NEW."initiatingUserId"
      AND r."accountingVersion"=2 AND r.state='RESERVED') THEN
    RAISE EXCEPTION 'checked preparation requires reserved admission capacity' USING ERRCODE='23514';
  END IF;
  -- Spoofed, partial or refreshed caller metadata is never accepted.
  IF NEW."authorityAcceptedAt" IS NOT NULL OR NEW."authorityDeadlineAt" IS NOT NULL OR NEW."authorityTransactionId" IS NOT NULL THEN
    RAISE EXCEPTION 'preparation acceptance is server-derived' USING ERRCODE='23514';
  END IF;
  NEW."authorityAcceptedAt":=checked."acceptedAt";
  NEW."authorityDeadlineAt":=checked."deadlineAt";
  NEW."authorityTransactionId":=pg_current_xact_id()::text;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_checked_preparation_insert BEFORE INSERT ON "ScanDispatchAttempt"
  FOR EACH ROW EXECUTE FUNCTION app.scan_checked_preparation_insert();

CREATE FUNCTION app.scan_checked_prepare_command() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId";
  IF TG_OP='UPDATE' AND NEW."commandType"='PREPARE' AND a."authorityAcceptedAt" IS NOT NULL
    AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'checked preparation consumption is closed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW."commandType" IN ('START_PAID','START_UNMETERED') AND a."authorityAcceptedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'checked preparation execution is closed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW."commandType"='PREPARE' THEN
    IF a."authorityAcceptedAt" IS NULL OR a."authorityTransactionId" IS DISTINCT FROM pg_current_xact_id()::text
      OR NEW.status<>'PENDING' OR NEW.sequence<>1 OR NOT app.scan_preparation_gate_held()
      OR a."authorityDeadlineAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN
      RAISE EXCEPTION 'PREPARE requires its original live transaction bundle' USING ERRCODE='23514';
    END IF;
    PERFORM app.check_scan_preparation_authority(a."scanId",a."authorityDeadlineAt");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_checked_prepare_command BEFORE INSERT OR UPDATE ON "ScanDispatchOutbox"
  FOR EACH ROW EXECUTE FUNCTION app.scan_checked_prepare_command();

CREATE FUNCTION app.scan_checked_preparation_bundle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public."ScanDispatchAttempt" a
    JOIN public."ScanPhysicalExecution" p ON p."attemptId"=a."attemptId" AND p."operationId"=a."operationId"
      AND p."scanId"=a."scanId" AND p."workspaceId"=a."workspaceId" AND p.state='RESERVED'
    JOIN public."ScanDispatchOutbox" c ON c."operationId"=a."operationId" AND c."attemptId"=a."attemptId"
      AND c."commandType"='PREPARE' AND c.sequence=1 AND c.status='PENDING'
    JOIN public."ScanDispatchOperation" o ON o."operationId"=a."operationId" AND o.state='PREPARING'
    WHERE a."attemptId"=NEW."attemptId" AND a."authorityTransactionId"=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'checked preparation bundle is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scan_checked_preparation_bundle AFTER INSERT ON "ScanDispatchAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.scan_checked_preparation_bundle();

CREATE FUNCTION app.reject_checked_preparation_start() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId" AND "authorityAcceptedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'checked preparation execution is closed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reject_checked_preparation_start BEFORE INSERT ON "ScanDispatchStart"
  FOR EACH ROW EXECUTE FUNCTION app.reject_checked_preparation_start();

CREATE FUNCTION app.scan_checked_preparation_physical() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId";
  IF a."authorityAcceptedAt" IS NOT NULL AND
    (a."authorityTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR NOT app.scan_preparation_gate_held()
     OR NEW.state<>'RESERVED') THEN
    RAISE EXCEPTION 'checked physical reservation requires its original preparation transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_checked_preparation_physical BEFORE INSERT ON "ScanPhysicalExecution"
  FOR EACH ROW EXECUTE FUNCTION app.scan_checked_preparation_physical();

CREATE FUNCTION app.scan_checked_preparation_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NEW.state='PREPARING' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS(
    SELECT 1 FROM public."ScanDispatchAttempt" a WHERE a."operationId"=NEW."operationId"
      AND a."authorityAcceptedAt" IS NOT NULL AND a."authorityTransactionId"=pg_current_xact_id()::text
      AND app.scan_preparation_gate_held()) THEN
    RAISE EXCEPTION 'PREPARING requires its original preparation transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_checked_preparation_operation BEFORE UPDATE ON "ScanDispatchOperation"
  FOR EACH ROW EXECUTE FUNCTION app.scan_checked_preparation_operation();

-- Even a separately installed consumer cannot consume this closed intent.
-- STOP/reconciliation evidence may still quarantine or safely terminate it.
CREATE FUNCTION app.reject_checked_preparation_consumption() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW."toState" IN ('PREPARING','DISPATCH_PENDING','ACTIVE') AND EXISTS(
    SELECT 1 FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId" AND "authorityAcceptedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'checked preparation consumption is closed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reject_checked_preparation_consumption BEFORE INSERT ON "ScanPhysicalExecutionTransition"
  FOR EACH ROW EXECUTE FUNCTION app.reject_checked_preparation_consumption();

-- Trigger execution itself does not require an EXECUTE grant to the invoker.
REVOKE ALL ON FUNCTION app.scan_preparation_gate_held(),app.scan_preparation_writer_gate(),
  app.require_scan_preparation_role(),
  app.acquire_scan_preparation_gate(),app.check_scan_preparation_authority(TEXT,TIMESTAMP),
  app.scan_checked_preparation_insert(),app.scan_checked_prepare_command(),
  app.scan_checked_preparation_bundle(),app.reject_checked_preparation_start(),
  app.scan_checked_preparation_physical(),app.scan_checked_preparation_operation(),
  app.reject_checked_preparation_consumption() FROM PUBLIC;

-- Runtime TRUNCATE/DDL/trigger bypass is incompatible with the lock ordering.
-- These are revocations only; privileged maintenance uses a separate drain.
DO $$ DECLARE role_name TEXT; name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['app_runtime_prod','app_system_prod','app_runtime_ci'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      FOREACH name IN ARRAY ARRAY['Workspace','WorkspaceMember','users','BillingAccount','agent_connections',
        'agent_operations','delegated_scan_provenance','Target','Policy','Scan','UserScanSlot','ScanCapacityReservation'] LOOP
        EXECUTE format('REVOKE TRUNCATE,TRIGGER ON public.%I FROM %I',name,role_name);
      END LOOP;
      EXECUTE format('REVOKE EXECUTE ON FUNCTION app.scan_preparation_context(text),app.acquire_scan_preparation_gate(),app.check_scan_preparation_authority(text,timestamp) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
