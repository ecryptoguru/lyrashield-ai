-- Exact tool intents retain the prepared authority and authenticated native ownership.
-- Existing provider intent and invocation constraints remain unchanged.
CREATE OR REPLACE FUNCTION app.scan_execution_action_intent_guard() RETURNS trigger
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
  authority:=NEW."authorityInputJson"::jsonb; action:=NEW."actionInputJson"::jsonb; request:=action->'request';
  SELECT "commandInputJson"::jsonb INTO prepare FROM "ScanDispatchOutbox" WHERE id=NEW."prepareCommandId";
  IF authority IS DISTINCT FROM jsonb_build_object('attempt',prepare->'attempt','executors',prepare->'executors','provider',coalesce(prepare->'provider','null'::jsonb))
    OR action->>'schema' IS DISTINCT FROM 'lyrashield-sandbox-tool-exec/1'
    OR request->>'requestId' IS DISTINCT FROM NEW."requestId"
    OR request#>>'{binding,operationId}' IS DISTINCT FROM NEW."operationId"
    OR request#>>'{binding,attemptId}' IS DISTINCT FROM NEW."attemptId"
    OR request#>>'{binding,authorityEpochId}' IS DISTINCT FROM NEW."authorityEpochId"
    OR prepare#>'{attempt,authorityRevision}' IS DISTINCT FROM to_jsonb(NEW."authorityRevision")
    OR request->>'user' IS DISTINCT FROM 'pentester'
    OR (CASE WHEN action->>'resultKind' IN ('pty/stdin','pty/terminate') THEN request ? 'argv' ELSE jsonb_typeof(request->'argv') IS DISTINCT FROM 'array' OR jsonb_array_length(request->'argv') NOT BETWEEN 1 AND 256 END)
    OR jsonb_typeof(request->'timeoutSeconds') IS DISTINCT FROM 'number' OR (request->>'timeoutSeconds')::numeric NOT BETWEEN 0.001 AND 300
    OR jsonb_typeof(request->'maxOutputBytes') IS DISTINCT FROM 'number' OR (request->>'maxOutputBytes')::numeric NOT BETWEEN 1 AND 1048576
    OR action#>>'{ownership,kind}' IS DISTINCT FROM 'container' OR action#>>'{ownership,executorKey}' IS DISTINCT FROM 'sandbox'
    OR action#>>'{ownership,containerId}' !~ '^[a-f0-9]{64}$'
    OR request#>>'{binding,sandboxHandle}' IS DISTINCT FROM action#>>'{ownership,ownershipId}'
    OR request->>'cwd' IS DISTINCT FROM action->>'workspaceRoot'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prepare->'executors') plan WHERE plan->>'key'='sandbox'
       AND plan#>>'{spec,kind}'='container' AND plan#>>'{spec,resourceDescriptor,workspaceRoot}'=action->>'workspaceRoot')
    OR NOT EXISTS(SELECT 1 FROM "ScanPhysicalExecution" p WHERE p."operationId"=a."operationId" AND p."attemptId"=a."attemptId" AND p.state='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" c WHERE c.id=NEW."prepareCommandId" AND c.status='COMPLETED')
    OR NOT EXISTS(SELECT 1 FROM "ScanSupervisorReceipt" r JOIN "ScanSupervisorJournalRecord" j ON j.id=r."journalRecordId"
       JOIN "ScanSupervisorJournalStream" s ON s.id=j."streamId"
       WHERE r.id=NEW."ownershipReceiptId" AND r."operationId"=a."operationId" AND r."attemptId"=a."attemptId"
       AND j."workspaceId"=a."workspaceId" AND r."authorityEpochId"=a."authorityEpochId"
       AND r."eventType"='resource_started' AND r."executorKey"='sandbox'
       AND s."authorityEpochId"=a."authorityEpochId" AND j.sequence<=s."confirmedSequence"
       AND j."originalInputJson"::jsonb#>'{payload,ownership}'=action->'ownership')
    OR NOT EXISTS(SELECT 1 FROM "ScanWorkerInstanceGrant" g JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
       WHERE g.id=a."workerInstanceGrantId" AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC'
       AND e.id=a."authorityEpochId" AND e."isOpen" AND e."closedAt" IS NULL)
    OR NOT EXISTS(SELECT 1 FROM "ScanCapacityReservation" r WHERE r."scanId"=a."scanId" AND r."workspaceId"=a."workspaceId"
       AND r.state='RUNNING' AND r."accountId"=a."sponsorAccountId" AND r."userId"=a."initiatingUserId" AND r."accountingVersion"=2) THEN
   RAISE EXCEPTION 'sandbox tool original ownership unavailable' USING ERRCODE='23514';
  END IF;
  PERFORM app.check_scan_current_execution_authority(a."scanId",NEW."expiresAt",NEW.phase);
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

CREATE OR REPLACE FUNCTION app.scan_execution_invocation_guard() RETURNS trigger
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
   OR NEW.phase NOT IN ('PREPARE','EXECUTOR_CREATE','EXECUTOR_START','PROVIDER_DISPATCH','SANDBOX_TOOL')
   OR NOT EXISTS(SELECT 1 FROM "ScanDispatchAttempt" a WHERE a."attemptId"=NEW."attemptId" AND a."operationId"=NEW."operationId"
      AND a."scanId"=NEW."scanId" AND a."workspaceId"=NEW."workspaceId" AND a."authorityEpochId"=NEW."authorityEpochId" AND a."authorityAcceptedAt" IS NOT NULL) THEN
  RAISE EXCEPTION 'invocation guard identity unavailable' USING ERRCODE='23514';
 END IF;
 IF NEW.phase IN ('PROVIDER_DISPATCH','SANDBOX_TOOL') THEN
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

-- A tool start ACK resolves only its original physical guard, never terminal tool output.
CREATE OR REPLACE FUNCTION app.scan_execution_invocation_resolution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE
 g public."ScanExecutionInvocationGuard"%ROWTYPE;
 r public."ScanSupervisorReceipt"%ROWTYPE;
 j public."ScanSupervisorJournalRecord"%ROWTYPE;
 s public."ScanSupervisorJournalStream"%ROWTYPE;
 e JSONB; ownership JSONB; inspection JSONB; expected_phase TEXT; checksum TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invocation resolution is immutable' USING ERRCODE='23514'; END IF;
 IF NOT app.scan_preparation_gate_held() OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'native resolution requires current exclusive source fence' USING ERRCODE='23514';
 END IF;
 SELECT * INTO g FROM public."ScanExecutionInvocationGuard" WHERE id=NEW."guardId" AND "workspaceId"=app.current_workspace_id();
 SELECT * INTO r FROM public."ScanSupervisorReceipt" WHERE id=NEW."receiptId";
 SELECT * INTO j FROM public."ScanSupervisorJournalRecord" WHERE id=r."journalRecordId";
 SELECT * INTO s FROM public."ScanSupervisorJournalStream" WHERE id=j."streamId" FOR UPDATE;
 e:=j."originalInputJson"::jsonb->'payload'; ownership:=e->'ownership'; inspection:=e->'inspection';
 expected_phase:=CASE WHEN e->>'type'='prepare_invocation_completed' THEN 'PREPARE' WHEN e->>'nativeOperation'='CONTAINER_CREATE_ACK' THEN 'EXECUTOR_CREATE'
    WHEN e->>'nativeOperation'='CONTAINER_START_ACK' THEN 'EXECUTOR_START' WHEN e->>'nativeOperation' IN ('SANDBOX_TOOL_START_ACK','SANDBOX_TOOL_MUTATION_ACK') THEN 'SANDBOX_TOOL' ELSE NULL END;

 SELECT c."commandInputChecksum" INTO checksum FROM public."ScanDispatchOutbox" c WHERE c.id=g."commandId"
   AND c."attemptId"=g."attemptId" AND c."operationId"=g."operationId" AND c."commandInputJson" IS NOT NULL;
 IF g.id IS NULL OR r.id IS NULL OR j.id IS NULL OR s.id IS NULL OR checksum IS NULL
   OR j.sequence>s."confirmedSequence" OR r."receiptHash" IS DISTINCT FROM j."originalHash"
   OR r.signature IS DISTINCT FROM j."originalInputJson"::jsonb->>'signature'
   OR r."eventType" IS DISTINCT FROM e->>'type' OR r."terminalStatus" IS NOT NULL
   OR coalesce(e->>'type','') NOT IN ('native_invocation_ack','prepare_invocation_completed')
   OR NEW."proofInputJson"::jsonb IS DISTINCT FROM e
   OR app.scan_preparation_plan_json(e) IS DISTINCT FROM NEW."proofInputJson"
   OR e->>'guardId' IS DISTINCT FROM g.id OR e->>'nativeRequestId' IS DISTINCT FROM g.id
   OR e->>'commandId' IS DISTINCT FROM g."commandId" OR r."commandId" IS DISTINCT FROM g."commandId"
   OR e->>'attemptId' IS DISTINCT FROM g."attemptId" OR r."attemptId" IS DISTINCT FROM g."attemptId"
   OR e->>'operationId' IS DISTINCT FROM g."operationId" OR r."operationId" IS DISTINCT FROM g."operationId"
   OR j."operationId" IS DISTINCT FROM g."operationId" OR j."attemptId" IS DISTINCT FROM g."attemptId"
   OR j."workspaceId" IS DISTINCT FROM g."workspaceId"
   OR e->>'authorityEpochId' IS DISTINCT FROM g."authorityEpochId" OR r."authorityEpochId" IS DISTINCT FROM g."authorityEpochId"
   OR s."authorityEpochId" IS DISTINCT FROM g."authorityEpochId" OR s."supervisorInstanceId" IS DISTINCT FROM r."supervisorInstanceId"
   OR e->>'supervisorInstanceId' IS DISTINCT FROM s."supervisorInstanceId"
   OR expected_phase IS NULL OR g.phase IS DISTINCT FROM expected_phase
   OR e->>'bindingInputChecksum' IS DISTINCT FROM encode(public.digest(convert_to(g."bindingInputJson",'UTF8'),'sha256'),'hex')
   OR e->>'actionChecksum' IS DISTINCT FROM g."actionChecksum" OR (expected_phase<>'SANDBOX_TOOL' AND g."actionChecksum" IS DISTINCT FROM checksum)
   OR e->>'commandInputChecksum' IS DISTINCT FROM checksum
   OR (expected_phase='PREPARE' AND (g."executorKey" IS NOT NULL OR NOT EXISTS(
     SELECT 1 FROM public."ScanSupervisorJournalRecord" p JOIN public."ScanDispatchOutbox" c ON c.id=g."commandId"
     WHERE p."streamId"=j."streamId" AND p."operationId"=g."operationId" AND p."attemptId"=g."attemptId" AND p.sequence<j.sequence
       AND p."originalInputJson"::jsonb->'payload'->>'type'='attempt_prepared'
       AND p."originalInputJson"::jsonb->'payload'->>'commandId'=g."commandId"
       AND p."originalInputJson"::jsonb->'payload'->'binding'=c."commandInputJson"::jsonb->'attempt'
       AND p."originalInputJson"::jsonb->'payload'->'executors'=c."commandInputJson"::jsonb->'executors'
       AND p."originalInputJson"::jsonb->'payload'->'provider' IS NOT DISTINCT FROM c."commandInputJson"::jsonb->'provider')))
   OR (expected_phase IN ('EXECUTOR_CREATE','EXECUTOR_START') AND (e->>'executorKey' IS DISTINCT FROM g."executorKey"
   OR ownership->>'kind' IS DISTINCT FROM 'container' OR ownership->>'containerId' IS NULL OR ownership->>'containerId' !~ '^[a-f0-9]{64}$'
   OR ownership->>'executorKey' IS DISTINCT FROM g."executorKey"
   OR ownership->>'ownershipId' IS DISTINCT FROM 'own_'||substring(encode(public.digest(
     convert_to(g."attemptId",'UTF8')||decode('00','hex')||convert_to(g."commandId",'UTF8')||decode('00','hex')||convert_to(g."executorKey",'UTF8'),'sha256'),'hex') FROM 1 FOR 40)
   OR inspection->>'state' IS DISTINCT FROM 'PRESENT' OR inspection->'ownership' IS DISTINCT FROM ownership
   OR inspection->'running' IS DISTINCT FROM to_jsonb(expected_phase='EXECUTOR_START')))
   OR (expected_phase='SANDBOX_TOOL' AND (
      g."executorKey" IS DISTINCT FROM 'sandbox' OR e->>'executorKey' IS DISTINCT FROM 'sandbox'
      OR e->>'requestId' IS DISTINCT FROM g."bindingInputJson"::jsonb->>'requestId'
      OR (CASE WHEN e->>'nativeOperation'='SANDBOX_TOOL_START_ACK' THEN coalesce(e->>'execId','') !~ '^[a-f0-9]{64}$' OR e ? 'nativeMutationId' OR e ? 'nativeReceiptSha256' OR e ? 'nativeTargets' ELSE e ? 'execId' OR e->>'nativeMutationId' IS DISTINCT FROM g.id OR coalesce(e->>'nativeReceiptSha256','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(e->'nativeTargets') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'nativeTargets')>32 END)
      OR ownership->>'kind' IS DISTINCT FROM 'container' OR ownership->>'executorKey' IS DISTINCT FROM 'sandbox'
      OR inspection->>'state' IS DISTINCT FROM 'PRESENT' OR jsonb_typeof(inspection->'running') IS DISTINCT FROM 'boolean'
      OR inspection->'ownership' IS DISTINCT FROM ownership
      OR NOT EXISTS(SELECT 1 FROM public."ScanExecutionActionIntent" i
        WHERE i.phase='SANDBOX_TOOL' AND i."operationId"=g."operationId" AND i."attemptId"=g."attemptId"
        AND i."workspaceId"=g."workspaceId" AND i."authorityEpochId"=g."authorityEpochId"
        AND i."requestId"=g."requestId" AND i."prepareCommandId"=g."commandId"
        AND i."actionChecksum"=g."actionChecksum" AND i."authorityChecksum"=g."authorityChecksum"
        AND i."actionInputJson"::jsonb->'ownership'=ownership
        AND (CASE WHEN e->>'nativeOperation'='SANDBOX_TOOL_START_ACK' THEN coalesce(i."actionInputJson"::jsonb->>'resultKind','exec') NOT IN ('pty/stdin','pty/terminate') AND inspection->'running'='true'::jsonb
        ELSE i."actionInputJson"::jsonb->>'resultKind' IN ('pty/stdin','pty/terminate')
          AND inspection->'running'=to_jsonb(NOT(coalesce(i."actionInputJson"::jsonb#>'{pty,stopSandbox}','false'::jsonb)='true'::jsonb))
          AND e->>'nativeReceiptSha256'=encode(public.digest(convert_to(app.scan_preparation_plan_json(jsonb_build_object('schema','lyrashield-native-pty-mutation/1','guardId',g.id,'actionChecksum',g."actionChecksum",'kind',i."actionInputJson"::jsonb->>'resultKind','targets',e->'nativeTargets')),'UTF8'),'sha256'),'hex')
          AND (i."actionInputJson"::jsonb->>'resultKind'<>'pty/stdin' OR (jsonb_array_length(e->'nativeTargets')=1 AND e#>'{nativeTargets,0,sessionId}'=i."actionInputJson"::jsonb#>'{pty,sessionId}'))
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e->'nativeTargets') t WHERE NOT EXISTS(
            SELECT 1 FROM public."ScanExecutionInvocationResolution" original JOIN public."ScanExecutionInvocationGuard" og ON og.id=original."guardId"
            JOIN public."ScanExecutionActionIntent" oi ON oi."operationId"=og."operationId" AND oi."attemptId"=og."attemptId" AND oi."workspaceId"=og."workspaceId" AND oi."requestId"=og."requestId" AND oi."actionChecksum"=og."actionChecksum"
            WHERE og.id=t->>'originalGuardId' AND og."operationId"=g."operationId" AND og."attemptId"=g."attemptId" AND og."workspaceId"=g."workspaceId" AND og."authorityEpochId"=g."authorityEpochId"
            AND oi."actionInputJson"::jsonb->>'resultKind'='pty/start' AND original."proofInputJson"::jsonb->>'nativeOperation'='SANDBOX_TOOL_START_ACK'
            AND original."proofInputJson"::jsonb->>'execId'=t->>'execId' AND original."proofInputJson"::jsonb->'ownership'=ownership))
        END)))) THEN
  RAISE EXCEPTION 'invocation resolution lacks exact confirmed original completion proof' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
