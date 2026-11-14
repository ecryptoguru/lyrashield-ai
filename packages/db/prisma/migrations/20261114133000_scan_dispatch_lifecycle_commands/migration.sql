-- Existing unavailable commands/decisions stay unavailable and are never backfilled.
ALTER TABLE public."ScanDispatchOutbox"
  ADD COLUMN IF NOT EXISTS "executorKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "authorityProofInputJson" TEXT,
  ADD COLUMN IF NOT EXISTS "authorityProofChecksum" TEXT;
DROP INDEX IF EXISTS public."ScanDispatchOutbox_operationId_commandType_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ScanDispatchOutbox_operationId_commandType_executorKey_key"
  ON public."ScanDispatchOutbox"("operationId","commandType","executorKey");
ALTER TABLE public."ScanDispatchStart"
  ADD COLUMN IF NOT EXISTS "authorityProofInputJson" TEXT,
  ADD COLUMN IF NOT EXISTS "authorityProofChecksum" TEXT;

CREATE OR REPLACE FUNCTION app.scan_dispatch_lifecycle_proof_current(proof_json TEXT, allow_shared BOOLEAN DEFAULT false)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p JSONB; receipt_hash TEXT; shared_held BOOLEAN;
BEGIN
  IF proof_json IS NULL OR octet_length(proof_json)>16384 THEN RETURN false; END IF;
  p:=proof_json::jsonb;
  SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
    AND classid=1819234670 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) INTO shared_held;
  IF NOT app.scan_preparation_gate_held() AND NOT (allow_shared IS TRUE AND shared_held) THEN RETURN false; END IF;
  IF p->>'purpose' IS DISTINCT FROM 'lyrashield-supervisor-attempt-proof/2'
    OR p#>>'{binding,workspaceId}' IS DISTINCT FROM app.current_workspace_id()
    OR (p->>'issuedAt')::timestamptz>clock_timestamp()
    OR (p->>'expiresAt')::timestamptz<=clock_timestamp()
    OR (p->>'expiresAt')::timestamptz>(p->>'issuedAt')::timestamptz+interval '10 seconds' THEN RETURN false; END IF;
  SELECT j."originalHash" INTO receipt_hash FROM public."ScanSupervisorJournalRecord" j
    JOIN public."ScanSupervisorJournalStream" s ON s.id=j."streamId"
    WHERE s."authorityEpochId"=p#>>'{binding,authorityEpochId}' AND s."supervisorInstanceId"=p->>'supervisorInstanceId'
      AND s."confirmedSequence"=(p->>'headSequence')::bigint
      AND encode(public.digest(convert_to(s."headInputJson",'UTF8'),'sha256'),'hex')=p->>'headInputChecksum'
      AND j."workspaceId"=app.current_workspace_id() AND j."operationId"=p#>>'{binding,operationId}'
      AND j."attemptId"=p#>>'{binding,attemptId}' AND j.sequence<=s."confirmedSequence"
      AND ((j."originalInputJson"::jsonb#>>'{payload,type}') NOT IN ('command_intent','prepare_invocation_completed','native_invocation_retired')
        OR (j."originalInputJson"::jsonb#>>'{payload,type}'='command_intent' AND j."originalInputJson"::jsonb#>>'{payload,command,type}'='PREPARE'))
      AND NOT (j."originalInputJson"::jsonb#>>'{payload,type}'='native_invocation_ack'
        AND coalesce(j."originalInputJson"::jsonb#>>'{payload,nativeOperation}','') IN ('SANDBOX_TOOL_START_ACK','SANDBOX_TOOL_MUTATION_ACK'))
    ORDER BY j.sequence DESC LIMIT 1;
  RETURN receipt_hash IS NOT NULL AND receipt_hash=p#>>'{command,expectedReceiptHash}' AND EXISTS(
    SELECT 1 FROM public."ScanDispatchAttempt" a JOIN public."ScanDispatchOutbox" c ON c."operationId"=a."operationId"
      AND c."attemptId"=a."attemptId" AND c."commandType"='PREPARE'
    WHERE a."workspaceId"=app.current_workspace_id() AND a."operationId"=p#>>'{binding,operationId}'
      AND a."attemptId"=p#>>'{binding,attemptId}' AND a."scanId"=p#>>'{binding,scanId}'
      AND a."authorityEpochId"=p#>>'{binding,authorityEpochId}' AND c."commandInputChecksum"=p->>'prepareChecksum');
END $$;
REVOKE ALL ON FUNCTION app.scan_dispatch_lifecycle_proof_current(TEXT,BOOLEAN) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.require_scan_dispatch_stage_role() RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r RECORD; n TEXT; col TEXT;
BEGIN
  IF session_user IS DISTINCT FROM current_user THEN RAISE EXCEPTION 'stage requires a direct restricted login' USING ERRCODE='42501'; END IF;
  FOR r IN SELECT * FROM pg_roles WHERE pg_has_role(current_user,oid,'SET') LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole
      OR has_schema_privilege(r.rolname,'public','CREATE') OR has_schema_privilege(r.rolname,'app','CREATE')
      OR has_database_privilege(r.rolname,current_database(),'CREATE,TEMPORARY') THEN
      RAISE EXCEPTION 'stage role can bypass authority isolation' USING ERRCODE='42501'; END IF;
    FOREACH n IN ARRAY ARRAY['Workspace','WorkspaceMember','users','BillingAccount','Target','Policy','Integration','TargetDomainVerification','ScanAttachment','LiveAiSafetyPlan','LiveAiSafetyRun','LiveAiSafetySettings','UserScanSlot','agent_connections','agent_operations','delegated_scan_provenance','ScanDispatchWorkerAssignment',
      'ScanDispatchAttempt','ScanPhysicalExecution','ScanDispatchOutbox','ScanSupervisorReceipt','ScanSupervisorJournalRecord','ScanSupervisorJournalStream','ScanExecutionActionIntent','ScanExecutionInvocationGuard','ScanExecutionInvocationResolution'] LOOP
      IF has_table_privilege(r.rolname,format('public.%I',n),'INSERT,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(r.rolname,format('public.%I',n),'UPDATE') THEN
        RAISE EXCEPTION 'stage role can mutate source or native authority' USING ERRCODE='42501'; END IF;
    END LOOP;
    FOREACH n IN ARRAY ARRAY['ScanSupervisorReceipt','ScanSupervisorJournalRecord','ScanSupervisorJournalStream','ScanExecutionActionIntent','ScanExecutionInvocationGuard','ScanExecutionInvocationResolution'] LOOP
      IF has_table_privilege(r.rolname,format('public.%I',n),'SELECT') THEN
        RAISE EXCEPTION 'stage role can read private native authority' USING ERRCODE='42501'; END IF;
    END LOOP;
    FOREACH n IN ARRAY ARRAY['Scan','ScanCapacityReservation','ScanWorkerInstanceGrant','ScanAuthorityEpoch'] LOOP
      IF has_table_privilege(r.rolname,format('public.%I',n),'INSERT,DELETE,TRUNCATE,TRIGGER') THEN
        RAISE EXCEPTION 'stage role can mutate source ownership' USING ERRCODE='42501'; END IF;
      FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',n)::regclass AND attnum>0 AND NOT attisdropped
        AND attname<>ALL(CASE WHEN n='Scan' THEN ARRAY['status','startedAt','updatedAt'] WHEN n='ScanCapacityReservation' THEN ARRAY['state','updatedAt'] ELSE ARRAY['updatedAt'] END) LOOP
        IF has_column_privilege(r.rolname,format('public.%I',n),col,'UPDATE') THEN
          RAISE EXCEPTION 'stage role has unrelated writer columns' USING ERRCODE='42501'; END IF;
      END LOOP;
    END LOOP;
    IF has_table_privilege(r.rolname,'public."ScanDispatchOperation"','INSERT,DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'stage role can replace source operation identity' USING ERRCODE='42501'; END IF;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public."ScanDispatchOperation"'::regclass AND attnum>0 AND NOT attisdropped AND attname<>ALL(ARRAY['state','updatedAt']) LOOP
      IF has_column_privilege(r.rolname,'public."ScanDispatchOperation"',col,'UPDATE') THEN
        RAISE EXCEPTION 'stage role can change operation identity' USING ERRCODE='42501'; END IF;
    END LOOP;
    FOREACH n IN ARRAY ARRAY['ScanDispatchStart','ScanEvent'] LOOP
      IF has_table_privilege(r.rolname,format('public.%I',n),'UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(r.rolname,format('public.%I',n),'UPDATE') THEN
        RAISE EXCEPTION 'stage role can rewrite the billing decision' USING ERRCODE='42501'; END IF;
    END LOOP;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.require_scan_dispatch_stage_role() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.reject_checked_preparation_start() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE; p JSONB;
BEGIN
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId" AND "operationId"=NEW."operationId";
  IF a."authorityAcceptedAt" IS NULL THEN RETURN NEW; END IF;
  p:=NEW."authorityProofInputJson"::jsonb;
  IF NEW."authorityProofInputJson" IS NULL OR NEW."authorityProofChecksum" IS NULL
    OR NEW."authorityProofChecksum"<>encode(public.digest(convert_to(NEW."authorityProofInputJson",'UTF8'),'sha256'),'hex')
    OR p#>>'{binding,workspaceId}' IS DISTINCT FROM a."workspaceId" OR a."workspaceId" IS DISTINCT FROM app.current_workspace_id()
    OR p#>>'{binding,operationId}' IS DISTINCT FROM NEW."operationId" OR p#>>'{binding,attemptId}' IS DISTINCT FROM NEW."attemptId"
    OR p#>>'{input,type}' IS DISTINCT FROM (CASE WHEN NEW.kind='PAID' THEN 'START_PAID' ELSE 'START_UNMETERED' END)
    OR p->>'preparedCompleted' IS DISTINCT FROM 'true'
    OR NEW."maxBudgetUsd">a."maxBudgetUsd" OR NEW."maxRuntimeMs" IS DISTINCT FROM a."maxRuntimeMs" OR NEW."policyDigest" IS DISTINCT FROM a."policyDigest"
    OR NOT app.scan_dispatch_lifecycle_proof_current(NEW."authorityProofInputJson",true)
    OR NOT EXISTS(SELECT 1 FROM public."ScanAuthorityEpoch" e JOIN public."ScanWorkerInstanceGrant" g ON g."authorityEpochId"=e.id
      WHERE e.id=a."authorityEpochId" AND e."isOpen" AND g.id=a."workerInstanceGrantId" AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'checked start requires a current exact scoped native proof' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.scan_dispatch_lifecycle_descriptor_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p JSONB; a public."ScanDispatchAttempt"%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."executorKey" IS DISTINCT FROM OLD."executorKey" OR NEW."authorityProofInputJson" IS DISTINCT FROM OLD."authorityProofInputJson"
      OR NEW."authorityProofChecksum" IS DISTINCT FROM OLD."authorityProofChecksum" THEN
      RAISE EXCEPTION 'lifecycle authority is immutable including legacy absence' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId" AND "operationId"=NEW."operationId";
  IF NEW."authorityProofInputJson" IS NULL AND NEW."authorityProofChecksum" IS NULL THEN
    IF a."authorityAcceptedAt" IS NOT NULL AND NEW."commandType"<>'PREPARE' THEN
      RAISE EXCEPTION 'new checked lifecycle commands require an exact signed proof' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  p:=NEW."authorityProofInputJson"::jsonb;
  IF NEW."authorityProofChecksum" IS NULL OR NEW."authorityProofChecksum"<>encode(public.digest(convert_to(NEW."authorityProofInputJson",'UTF8'),'sha256'),'hex')
    OR NEW."commandInputJson" IS NULL OR p->'command' IS DISTINCT FROM NEW."commandInputJson"::jsonb
    OR p->>'commandChecksum' IS DISTINCT FROM NEW."commandInputChecksum"
    OR p#>>'{binding,workspaceId}' IS DISTINCT FROM a."workspaceId" OR p#>>'{binding,operationId}' IS DISTINCT FROM NEW."operationId"
    OR p#>>'{binding,attemptId}' IS DISTINCT FROM NEW."attemptId" OR p#>>'{binding,authorityEpochId}' IS DISTINCT FROM a."authorityEpochId"
    OR NEW."executorKey" IS DISTINCT FROM coalesce(p#>>'{command,executorKey}','')
    OR NOT app.scan_dispatch_lifecycle_proof_current(NEW."authorityProofInputJson",false)
    OR (NEW."commandType" IN ('START_PAID','START_UNMETERED') AND NOT EXISTS(SELECT 1 FROM public."ScanDispatchStart" s
      WHERE s."operationId"=NEW."operationId" AND s."attemptId"=NEW."attemptId" AND s."authorityProofInputJson" IS NOT NULL)) THEN
    RAISE EXCEPTION 'lifecycle descriptor lacks exact current scoped authority' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scan_dispatch_lifecycle_descriptor_guard ON public."ScanDispatchOutbox";
CREATE TRIGGER scan_dispatch_lifecycle_descriptor_guard BEFORE INSERT OR UPDATE ON public."ScanDispatchOutbox"
  FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_lifecycle_descriptor_guard();
REVOKE ALL ON FUNCTION app.scan_dispatch_lifecycle_descriptor_guard() FROM PUBLIC;

-- Positive original PREPARE completion may project metadata preparation. Later
-- execution transitions additionally require the immutable staged/frozen decision.
CREATE OR REPLACE FUNCTION app.reject_checked_preparation_consumption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId";
 IF a."authorityAcceptedAt" IS NOT NULL AND NEW."toState" IN ('PREPARING','DISPATCH_PENDING','ACTIVE') AND NOT EXISTS(
   SELECT 1 FROM public."ScanDispatchOutbox" p WHERE p."operationId"=a."operationId" AND p."attemptId"=a."attemptId"
    AND p."commandType"='PREPARE' AND app.scan_supervisor_preparation_completed(p.id)
    AND (NEW."toState"='PREPARING' OR EXISTS(SELECT 1 FROM public."ScanDispatchStart" s JOIN public."ScanDispatchOutbox" c
      ON c."operationId"=s."operationId" AND c."attemptId"=s."attemptId"
      WHERE s."operationId"=a."operationId" AND s."attemptId"=a."attemptId" AND s."authorityProofInputJson" IS NOT NULL
        AND c."commandType" IN ('START_PAID','START_UNMETERED') AND c."authorityProofInputJson" IS NOT NULL
        AND EXISTS(SELECT 1 FROM public."ScanSupervisorReceipt" r WHERE r.id=NEW."supervisorReceiptId" AND r."commandId"=c.id AND r."operationId"=c."operationId" AND r."attemptId"=c."attemptId" AND r."journalRecordId" IS NOT NULL)
        AND EXISTS(SELECT 1 FROM public."ScanExecutionInvocationGuard" g JOIN public."ScanExecutionInvocationResolution" r ON r."guardId"=g.id WHERE g."commandId"=c.id AND g."attemptId"=c."attemptId" AND g."operationId"=c."operationId" AND g."actionChecksum"=c."commandInputChecksum" AND g.phase=(CASE WHEN NEW."toState"='ACTIVE' THEN 'EXECUTOR_START' ELSE 'EXECUTOR_CREATE' END))))) THEN
    RAISE EXCEPTION 'checked consumption requires complete original proof and frozen decision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- Only the scoped boolean read joins the preparation role definer allowlist.
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
      AND p.oid NOT IN ('app.scan_preparation_context(text)'::regprocedure,
        'app.require_scan_dispatch_worker(text,text)'::regprocedure,
        'app.scan_dispatch_lifecycle_proof_current(text,boolean)'::regprocedure)
      AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'preparation broker role can reach an unreviewed definer' USING ERRCODE='42501';
  END IF;
  END LOOP;
END $$;
