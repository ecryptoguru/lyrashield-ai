-- Read-only source acquisition before PREPARE. No source/authority mutation grant.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyrashield_preparation_source_reader') THEN
    CREATE ROLE lyrashield_preparation_source_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyrashield_preparation_source_reader'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)) THEN
    RAISE EXCEPTION 'source reader group is not restricted' USING ERRCODE='42501';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO lyrashield_preparation_source_reader;
GRANT SELECT ON "ScanDispatchOperation","Scan","Target","Policy","Integration","ScanAttachment","Workspace","WorkspaceMember",users,agent_connections,agent_operations,delegated_scan_provenance TO lyrashield_preparation_source_reader;
GRANT EXECUTE ON FUNCTION app.scan_preparation_context(text),app.require_scan_dispatch_worker_stage(text,text),app.current_workspace_id(),app.current_account_id(),app.scan_target_snapshot_digest(text),app.scan_dispatch_scope_digest(text),app.scan_policy_digest(text),public.digest(bytea,text) TO lyrashield_preparation_source_reader;
CREATE POLICY preparation_source_operation_scope ON "ScanDispatchOperation" FOR SELECT TO lyrashield_preparation_source_reader
  USING ("workspaceId"=app.current_workspace_id());

CREATE FUNCTION app.require_scan_preparation_source_role() RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE role_name TEXT; item RECORD; name TEXT;
BEGIN
  IF session_user IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'source reader requires a direct restricted login' USING ERRCODE='42501';
  END IF;
  FOR role_name IN SELECT rolname FROM pg_catalog.pg_roles WHERE pg_has_role(current_user,oid,'SET') LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
      OR has_schema_privilege(role_name,'public','CREATE') OR has_schema_privilege(role_name,'app','CREATE')
      OR has_database_privilege(role_name,current_database(),'CREATE') OR has_database_privilege(role_name,current_database(),'TEMPORARY') THEN
      RAISE EXCEPTION 'source reader can bypass isolation' USING ERRCODE='42501';
    END IF;
    FOR item IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p') LOOP
      IF has_table_privilege(role_name,item.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(role_name,item.oid,'INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'source reader cannot own mutable authority' USING ERRCODE='42501';
      END IF;
    END LOOP;
    FOR item IN SELECT p.oid,n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname IN ('public','app') LOOP
      IF has_function_privilege(role_name,item.oid,'EXECUTE') AND item.oid NOT IN
        ('app.scan_preparation_context(text)'::regprocedure,'app.require_scan_dispatch_worker_stage(text,text)'::regprocedure) THEN
        RAISE EXCEPTION 'source reader has unrelated privileged capability' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ScanDispatchOperation','Scan','Target','Policy','Integration','ScanAttachment','Workspace','WorkspaceMember','users','agent_connections','agent_operations','delegated_scan_provenance'] LOOP
    IF NOT has_table_privilege(current_user,format('public.%I',name),'SELECT') THEN
      RAISE EXCEPTION 'source metadata reader is incomplete' USING ERRCODE='42501';
    END IF;
  END LOOP;
END $$;

-- Retain approved encrypted attachments on the same checked REPO path. Exact
-- manifests/bytes remain required by the signed compiler and protected mount.
CREATE OR REPLACE FUNCTION app.require_scan_preparation_role() RETURNS VOID
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
    'agent_operations','delegated_scan_provenance','Target','Policy','ScanAttachment'] LOOP
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
      AND p.oid NOT IN ('app.scan_preparation_context(text)'::regprocedure,
        'app.require_scan_dispatch_worker(text,text)'::regprocedure,
        'app.scan_dispatch_lifecycle_proof_current(text,boolean)'::regprocedure)
      AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'preparation broker role can reach an unreviewed definer' USING ERRCODE='42501';
  END IF;
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app.check_scan_current_execution_authority(scan_id TEXT, expires_at TIMESTAMP, phase TEXT)
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
  IF phase='PREPARE' AND NOT app.scan_preparation_gate_held() THEN
    RAISE EXCEPTION 'PREPARE requires exclusive authority gate' USING ERRCODE='23514';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' OR NOT app.scan_execution_gate_held() THEN
    RAISE EXCEPTION 'preparation requires its READ COMMITTED transaction gate' USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM public."Scan" WHERE id=scan_id AND "workspaceId"=app.current_workspace_id();
  IF NOT FOUND OR s."accountingVersion" IS DISTINCT FROM 2 OR s."deletedAt" IS NOT NULL
    OR NOT (CASE WHEN phase='PREPARE' THEN s.status IN ('QUEUED','PREFLIGHT') WHEN phase IN ('EXECUTOR_CREATE','EXECUTOR_START','PROVIDER_DISPATCH','SANDBOX_TOOL') THEN s.status='RUNNING' ELSE false END) OR s."executionPlan" IS NULL
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
    OR s."executionPlan" ? 'authorizationRef' THEN
    RAISE EXCEPTION 'unsupported preparation target/workflow/attachment authority' USING ERRCODE='23514';
  END IF;
  IF NOT app.scan_attachment_ids_valid(ARRAY(SELECT jsonb_array_elements_text(s."executionPlan"->'attachmentIds')))
    OR (SELECT count(*) FROM public."ScanAttachment" a WHERE a.id=ANY(ARRAY(SELECT jsonb_array_elements_text(s."executionPlan"->'attachmentIds')))
      AND a."workspaceId"=s."workspaceId" AND a.status='ACTIVE' AND a."deletedAt" IS NULL
      AND a.checksum ~ '^[a-f0-9]{64}$' AND a."byteLength" BETWEEN 0 AND 1048576)
      <> jsonb_array_length(s."executionPlan"->'attachmentIds')
    OR coalesce((SELECT sum(a."byteLength") FROM public."ScanAttachment" a WHERE a.id=ANY(ARRAY(SELECT jsonb_array_elements_text(s."executionPlan"->'attachmentIds')))
      AND a."workspaceId"=s."workspaceId"),0)>4194304 THEN
    RAISE EXCEPTION 'approved preparation attachments unavailable' USING ERRCODE='23514';
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
      OR ('lyrashield.write'=ANY(c.scopes)) IS NOT TRUE
      OR (s.mode::text=ANY(ARRAY(SELECT upper(permitted.profile) FROM unnest(c."allowedProfiles") AS permitted(profile)))) IS NOT TRUE
      OR ((CASE WHEN s."triggerType"='retest' THEN 'retest.create' ELSE 'scan.create' END)=ANY(c."allowedOperations")) IS NOT TRUE
      OR (c."allTargets" OR s."targetId"=ANY(c."allowedTargetIds")) IS NOT TRUE
      OR c.scopes IS NULL OR c."allowedProfiles" IS NULL OR c."allowedOperations" IS NULL OR c."allowedTargetIds" IS NULL
      OR array_position(c.scopes,NULL) IS NOT NULL OR array_position(c."allowedProfiles",NULL) IS NOT NULL
      OR array_position(c."allowedOperations",NULL) IS NOT NULL OR array_position(c."allowedTargetIds",NULL) IS NOT NULL
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
