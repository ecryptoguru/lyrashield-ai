-- Current REPO authority remains identical to checked admission; this adds no
-- URL/API/assessment/attachment approximation or physical-consumption enable.
CREATE FUNCTION app.scan_execution_gate_held() RETURNS BOOLEAN
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
   AND classid=1819234670 AND objid=1 AND objsubid=2
   AND mode IN ('ShareLock','ExclusiveLock') AND granted)
$$;
CREATE FUNCTION app.check_scan_current_execution_authority(scan_id TEXT, expires_at TIMESTAMP, phase TEXT)
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
-- Preserve the existing preparation API and its exclusive gate/state contract.
CREATE OR REPLACE FUNCTION app.check_scan_preparation_authority(scan_id TEXT, expires_at TIMESTAMP)
RETURNS TABLE("acceptedAt" TIMESTAMP(3),"deadlineAt" TIMESTAMP(3))
LANGUAGE sql VOLATILE SET search_path=pg_catalog,app AS $$
 SELECT * FROM app.check_scan_current_execution_authority(scan_id,expires_at,'PREPARE')
$$;

-- Every relevant source mutation participates even while its execution path
-- remains unsupported. Taking the shared gate does not grant execution.
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['Integration','TargetDomainVerification','ScanAttachment','LiveAiSafetyPlan','LiveAiSafetyRun','LiveAiSafetySettings'] LOOP
  EXECUTE format('CREATE TRIGGER scan_preparation_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.scan_preparation_writer_gate()',name);
 END LOOP;
END $$;

CREATE TABLE "ScanExecutionActionIntent" (
 id TEXT NOT NULL PRIMARY KEY,
 phase TEXT NOT NULL,
 "operationId" TEXT NOT NULL,
 "attemptId" TEXT NOT NULL,
 "scanId" TEXT NOT NULL,
 "workspaceId" TEXT NOT NULL,
 "authorityEpochId" TEXT NOT NULL,
 "authorityRevision" INTEGER NOT NULL,
 "requestId" TEXT NOT NULL,
 "prepareCommandId" TEXT NOT NULL,
 "authorityInputJson" TEXT NOT NULL,
 "authorityChecksum" TEXT NOT NULL,
 "actionInputJson" TEXT NOT NULL,
 "actionChecksum" TEXT NOT NULL,
 "ownershipReceiptId" TEXT,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ScanExecutionActionIntent_phase_check" CHECK(phase IN ('PROVIDER_DISPATCH','SANDBOX_TOOL')),
 CONSTRAINT "ScanExecutionActionIntent_bytes_check" CHECK(
   octet_length("authorityInputJson") BETWEEN 1 AND 131072 AND octet_length("actionInputJson") BETWEEN 1 AND 131072
   AND "authorityChecksum"~'^[a-f0-9]{64}$' AND "actionChecksum"~'^[a-f0-9]{64}$'
   AND encode(public.digest(convert_to("authorityInputJson",'UTF8'),'sha256'),'hex')="authorityChecksum"
   AND encode(public.digest(convert_to("actionInputJson",'UTF8'),'sha256'),'hex')="actionChecksum"
   AND "authorityRevision">=0 AND isfinite("expiresAt")
 ),
 CONSTRAINT "ScanExecutionActionIntent_operationId_attemptId_fkey" FOREIGN KEY("operationId","attemptId")
 REFERENCES "ScanDispatchAttempt"("operationId","attemptId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScanExecutionActionIntent_operationId_phase_requestId_key" ON "ScanExecutionActionIntent"("operationId",phase,"requestId");
CREATE INDEX "ScanExecutionActionIntent_workspaceId_idx" ON "ScanExecutionActionIntent"("workspaceId");
ALTER TABLE "ScanExecutionActionIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanExecutionActionIntent" FORCE ROW LEVEL SECURITY;
CREATE POLICY scan_execution_action_workspace ON "ScanExecutionActionIntent" USING ("workspaceId"=app.current_workspace_id()) WITH CHECK ("workspaceId"=app.current_workspace_id());
REVOKE ALL ON "ScanExecutionActionIntent" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','app_runtime_prod','app_system_prod','app_runtime_ci') LOOP
  EXECUTE format('REVOKE ALL ON "ScanExecutionActionIntent" FROM %I',role_name);
 END LOOP;
END $$;

CREATE FUNCTION app.scan_execution_action_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE; existing TEXT; prepare JSONB; authority JSONB; action JSONB; request JSONB; provider JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'action intent is immutable' USING ERRCODE='23514'; END IF;
 PERFORM app.require_scan_execution_action_role();
 IF NOT app.scan_execution_gate_held() OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'action intent requires current transaction gate' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."operationId",1));
 SELECT * INTO a FROM "ScanDispatchAttempt" WHERE "operationId"=NEW."operationId" AND "attemptId"=NEW."attemptId";
 IF NOT FOUND OR a."authorityAcceptedAt" IS NULL OR a."scanId"<>NEW."scanId" OR a."workspaceId"<>NEW."workspaceId"
   OR a."authorityEpochId"<>NEW."authorityEpochId" OR NEW."expiresAt">a."expiresAt"
   OR NEW."expiresAt"<=clock_timestamp() AT TIME ZONE 'UTC'
   OR a."policyDigest"<>app.scan_policy_digest(a."policyId") OR a."scopeDigest"<>app.scan_dispatch_scope_digest(a."scanId")
   OR NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" c WHERE c.id=NEW."prepareCommandId" AND c."attemptId"=a."attemptId"
     AND c."commandType"='PREPARE' AND c."commandInputJson" IS NOT NULL) THEN
  RAISE EXCEPTION 'action intent original authority unavailable' USING ERRCODE='23514';
 END IF;
 IF app.scan_preparation_plan_json(NEW."authorityInputJson"::jsonb)<>NEW."authorityInputJson"
   OR app.scan_preparation_plan_json(NEW."actionInputJson"::jsonb)<>NEW."actionInputJson" THEN
  RAISE EXCEPTION 'action intent input is noncanonical' USING ERRCODE='23514';
 END IF;
 -- One retained provider grant authority per attempt, never fresh grants to
 -- multiply an original policy budget or replace uncertain paid requests.
 IF NEW.phase='SANDBOX_TOOL' THEN
  RAISE EXCEPTION 'authenticated sandbox tool producer is not installed' USING ERRCODE='23514';
 END IF;
 IF NEW.phase='PROVIDER_DISPATCH' THEN
  authority:=NEW."authorityInputJson"::jsonb; action:=NEW."actionInputJson"::jsonb; request:=authority->'request';
  SELECT "commandInputJson"::jsonb INTO prepare FROM "ScanDispatchOutbox" WHERE id=NEW."prepareCommandId";
  provider:=prepare->'provider';
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR jsonb_typeof(authority->'policy') IS DISTINCT FROM 'object'
    OR jsonb_typeof(action) IS DISTINCT FROM 'object' OR jsonb_typeof(provider) IS DISTINCT FROM 'object'
    OR prepare#>>'{attempt,billingMode}' IS DISTINCT FROM 'PAID'
    OR request->>'operationId' IS DISTINCT FROM NEW."operationId" OR request->>'attemptId' IS DISTINCT FROM NEW."attemptId"
    OR request->>'scanId' IS DISTINCT FROM NEW."scanId" OR request->>'workspaceId' IS DISTINCT FROM NEW."workspaceId"
    OR request->>'authorityEpochId' IS DISTINCT FROM NEW."authorityEpochId"
    OR request->'authorityRevision' IS DISTINCT FROM to_jsonb(NEW."authorityRevision")
    OR prepare#>'{attempt,authorityRevision}' IS DISTINCT FROM to_jsonb(NEW."authorityRevision")
    OR request->>'requestId' IS NOT NULL OR action->>'requestId' IS DISTINCT FROM NEW."requestId"
    OR action->>'providerId' IS DISTINCT FROM request->>'providerId'
    OR action->>'method' IS DISTINCT FROM 'POST' OR action->>'contentType' IS DISTINCT FROM 'application/json'
    OR coalesce(action->>'path','')||coalesce(action->>'query','') IS DISTINCT FROM authority#>>'{policy,endpoint}'
    OR (request->>'expiresAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."expiresAt"
    OR (SELECT count(*) FROM jsonb_object_keys(authority))<>2
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(authority) key WHERE key NOT IN ('request','policy'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['providerId','maxRequests','costReservationMicros','maxReservedCostMicros']) name
      WHERE request->name IS DISTINCT FROM provider->name)
    OR (provider->>'maxReservedCostMicros')::numeric>a."maxBudgetUsd"*1000000
    OR NEW."ownershipReceiptId" IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM "ScanPhysicalExecution" p WHERE p."attemptId"=a."attemptId" AND p.state='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" c WHERE c.id=NEW."prepareCommandId" AND c.status='COMPLETED')
    OR NOT EXISTS(SELECT 1 FROM "ScanWorkerInstanceGrant" g JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
       WHERE g.id=a."workerInstanceGrantId" AND g."authorityEpochId"=a."authorityEpochId" AND g."revokedAt" IS NULL
       AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC' AND e."isOpen" AND e."closedAt" IS NULL)
    OR NOT EXISTS(SELECT 1 FROM "ScanDispatchStart" st JOIN "ScanCapacityReservation" r ON r."scanId"=a."scanId" AND r."workspaceId"=a."workspaceId"
       WHERE st."attemptId"=a."attemptId" AND st.kind='PAID' AND st."maxBudgetUsd"=a."maxBudgetUsd" AND st."policyDigest"=a."policyDigest"
       AND st."billableClaimEventId" IS NOT NULL AND st."providerGrantDigest" IS NOT NULL
       AND r.state='RUNNING' AND r."accountId"=a."sponsorAccountId" AND r."userId"=a."initiatingUserId" AND r."accountingVersion"=2) THEN
   RAISE EXCEPTION 'provider intent approved source unavailable' USING ERRCODE='23514';
  END IF;
  PERFORM app.check_scan_current_execution_authority(a."scanId",NEW."expiresAt",NEW.phase);
  SELECT "authorityChecksum" INTO existing FROM "ScanExecutionActionIntent"
   WHERE "attemptId"=NEW."attemptId" AND phase='PROVIDER_DISPATCH' LIMIT 1;
  IF existing IS NOT NULL AND existing<>NEW."authorityChecksum" THEN
   RAISE EXCEPTION 'provider action changed original grant authority' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scan_execution_action_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON "ScanExecutionActionIntent"
 FOR EACH ROW EXECUTE FUNCTION app.scan_execution_action_intent_guard();
REVOKE ALL ON FUNCTION app.scan_execution_gate_held(),app.check_scan_current_execution_authority(TEXT,TIMESTAMP,TEXT),app.scan_execution_action_intent_guard() FROM PUBLIC;

-- Session loss releases a native lock but never erases an in-flight operation.
-- A protected observer must resolve the exact original action; no clock expiry.
CREATE TABLE "ScanExecutionInvocationGuard" (
 id TEXT NOT NULL PRIMARY KEY,
 "operationId" TEXT NOT NULL,"attemptId" TEXT NOT NULL,"scanId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,
 "authorityEpochId" TEXT NOT NULL,phase TEXT NOT NULL,"commandId" TEXT,"requestId" TEXT,"executorKey" TEXT,
 "authorityChecksum" TEXT NOT NULL,"actionChecksum" TEXT NOT NULL,"bindingInputJson" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ScanExecutionInvocationGuard_bytes_check" CHECK(octet_length("bindingInputJson") BETWEEN 1 AND 16384 AND "authorityChecksum"~'^[a-f0-9]{64}$' AND "actionChecksum"~'^[a-f0-9]{64}$'),
 CONSTRAINT "ScanExecutionInvocationGuard_operationId_attemptId_fkey" FOREIGN KEY("operationId","attemptId") REFERENCES "ScanDispatchAttempt"("operationId","attemptId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScanExecutionInvocationGuard_original_action_key" ON "ScanExecutionInvocationGuard"("operationId",phase,"actionChecksum");
CREATE INDEX "ScanExecutionInvocationGuard_workspaceId_idx" ON "ScanExecutionInvocationGuard"("workspaceId");
CREATE TABLE "ScanExecutionInvocationResolution" (
 id TEXT NOT NULL PRIMARY KEY,"guardId" TEXT NOT NULL,"receiptId" TEXT NOT NULL,
 "proofInputJson" TEXT NOT NULL,"proofChecksum" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ScanExecutionInvocationResolution_proof_check" CHECK(octet_length("proofInputJson") BETWEEN 1 AND 131072 AND "proofChecksum"~'^[a-f0-9]{64}$' AND encode(public.digest(convert_to("proofInputJson",'UTF8'),'sha256'),'hex')="proofChecksum"),
 CONSTRAINT "ScanExecutionInvocationResolution_guardId_fkey" FOREIGN KEY("guardId") REFERENCES "ScanExecutionInvocationGuard"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ScanExecutionInvocationResolution_receiptId_fkey" FOREIGN KEY("receiptId") REFERENCES "ScanSupervisorReceipt"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScanExecutionInvocationResolution_guardId_key" ON "ScanExecutionInvocationResolution"("guardId");
ALTER TABLE "ScanExecutionInvocationGuard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanExecutionInvocationGuard" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanExecutionInvocationResolution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanExecutionInvocationResolution" FORCE ROW LEVEL SECURITY;
CREATE POLICY scan_invocation_guard_workspace ON "ScanExecutionInvocationGuard" USING ("workspaceId"=app.current_workspace_id()) WITH CHECK ("workspaceId"=app.current_workspace_id());
CREATE POLICY scan_invocation_resolution_workspace ON "ScanExecutionInvocationResolution" USING (EXISTS(SELECT 1 FROM "ScanExecutionInvocationGuard" g WHERE g.id="guardId" AND g."workspaceId"=app.current_workspace_id()));
REVOKE ALL ON "ScanExecutionInvocationGuard","ScanExecutionInvocationResolution" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','app_runtime_prod','app_system_prod','app_runtime_ci') LOOP
  EXECUTE format('REVOKE ALL ON "ScanExecutionInvocationGuard","ScanExecutionInvocationResolution" FROM %I',role_name);
 END LOOP;
END $$;

CREATE FUNCTION app.scan_execution_invocation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE b JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invocation guard is immutable' USING ERRCODE='23514'; END IF;
 PERFORM app.require_scan_execution_action_role();
 IF NOT app.scan_preparation_gate_held() THEN RAISE EXCEPTION 'invocation requires native exclusive gate' USING ERRCODE='23514'; END IF;
 b:=NEW."bindingInputJson"::jsonb;
 IF app.scan_preparation_plan_json(b)<>NEW."bindingInputJson"
   OR b->>'operationId' IS DISTINCT FROM NEW."operationId" OR b->>'attemptId' IS DISTINCT FROM NEW."attemptId"
   OR b->>'scanId' IS DISTINCT FROM NEW."scanId" OR b->>'workspaceId' IS DISTINCT FROM NEW."workspaceId"
   OR b->>'authorityEpochId' IS DISTINCT FROM NEW."authorityEpochId" OR b->>'phase' IS DISTINCT FROM NEW.phase
   OR b->>'commandId' IS DISTINCT FROM NEW."commandId" OR b->>'requestId' IS DISTINCT FROM NEW."requestId"
   OR b->>'executorKey' IS DISTINCT FROM NEW."executorKey" OR b->>'authorityChecksum' IS DISTINCT FROM NEW."authorityChecksum"
   OR b->>'actionChecksum' IS DISTINCT FROM NEW."actionChecksum"
   OR NEW.phase NOT IN ('PREPARE','EXECUTOR_CREATE','EXECUTOR_START','PROVIDER_DISPATCH')
   OR NOT EXISTS(SELECT 1 FROM "ScanDispatchAttempt" a WHERE a."attemptId"=NEW."attemptId" AND a."operationId"=NEW."operationId"
      AND a."scanId"=NEW."scanId" AND a."workspaceId"=NEW."workspaceId" AND a."authorityEpochId"=NEW."authorityEpochId" AND a."authorityAcceptedAt" IS NOT NULL) THEN
  RAISE EXCEPTION 'invocation guard identity unavailable' USING ERRCODE='23514';
 END IF;
 IF NEW.phase='PROVIDER_DISPATCH' THEN
  IF NOT EXISTS(SELECT 1 FROM "ScanExecutionActionIntent" i WHERE i."operationId"=NEW."operationId" AND i."attemptId"=NEW."attemptId"
     AND i."requestId"=NEW."requestId" AND i."authorityChecksum"=NEW."authorityChecksum" AND i."actionChecksum"=NEW."actionChecksum"
     AND i.phase=NEW.phase AND i."expiresAt">clock_timestamp() AT TIME ZONE 'UTC') THEN
   RAISE EXCEPTION 'original provider intent unavailable' USING ERRCODE='23514';
  END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" c WHERE c.id=NEW."commandId" AND c."operationId"=NEW."operationId"
    AND c."attemptId"=NEW."attemptId" AND c."commandInputChecksum"=NEW."actionChecksum") THEN
  RAISE EXCEPTION 'original command descriptor unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scan_execution_invocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "ScanExecutionInvocationGuard"
 FOR EACH ROW EXECUTE FUNCTION app.scan_execution_invocation_guard();

-- No resolution writer is enabled until original signed observer proof is
-- integrated. A daemon timeout or caller assertion can never release a guard.
CREATE FUNCTION app.scan_execution_invocation_resolution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'authenticated invocation resolution is not installed' USING ERRCODE='23514'; END $$;
CREATE TRIGGER scan_execution_invocation_resolution_guard BEFORE INSERT OR UPDATE OR DELETE ON "ScanExecutionInvocationResolution"
 FOR EACH ROW EXECUTE FUNCTION app.scan_execution_invocation_resolution_guard();

-- This narrowly reviewed private read runs before source revocation even for
-- runtime roles that cannot SELECT private guard rows. It exposes no payloads.
CREATE FUNCTION app.scan_execution_invocation_pending() RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'invocation observer cannot inspect forced private authority' USING ERRCODE='42501';
 END IF;
 RETURN EXISTS(SELECT 1 FROM public."ScanExecutionInvocationGuard" g
  WHERE NOT EXISTS(SELECT 1 FROM public."ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id));
END $$;
REVOKE ALL ON FUNCTION app.scan_execution_invocation_pending() FROM PUBLIC;
CREATE OR REPLACE FUNCTION app.scan_preparation_writer_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'source authority writes require READ COMMITTED' USING ERRCODE='23514';
 END IF;
 IF app.scan_preparation_gate_held() THEN
  RAISE EXCEPTION 'authority writes are forbidden after the preparation gate' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(1819234670,1);
 IF app.scan_execution_invocation_pending() THEN
  RAISE EXCEPTION 'revocation pending original invocation reconciliation' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.scan_execution_invocation_guard(),app.scan_execution_invocation_resolution_guard() FROM PUBLIC;

CREATE FUNCTION app.require_scan_execution_action_role() RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE role_name TEXT; name TEXT;
BEGIN
 PERFORM app.require_scan_preparation_role();
 FOR role_name IN SELECT rolname FROM pg_roles WHERE pg_has_role(current_user,oid,'SET') LOOP
  FOREACH name IN ARRAY ARRAY['Integration','TargetDomainVerification','ScanAttachment','LiveAiSafetyPlan','LiveAiSafetyRun','LiveAiSafetySettings'] LOOP
   IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(role_name,format('public.%I',name),'UPDATE') THEN
    RAISE EXCEPTION 'action role can mutate source authority' USING ERRCODE='42501';
   END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ScanExecutionActionIntent','ScanExecutionInvocationGuard'] LOOP
   IF has_table_privilege(role_name,format('public.%I',name),'UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(role_name,format('public.%I',name),'UPDATE') THEN
    RAISE EXCEPTION 'action role can rewrite original invocation evidence' USING ERRCODE='42501';
   END IF;
  END LOOP;
  IF has_table_privilege(role_name,'public."ScanExecutionInvocationResolution"','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(role_name,'public."ScanExecutionInvocationResolution"','UPDATE') THEN
   RAISE EXCEPTION 'action role can resolve its own uncertain invocation' USING ERRCODE='42501';
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.require_scan_execution_action_role() FROM PUBLIC;
