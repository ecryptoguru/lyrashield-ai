-- A captured proof cannot be modified by either billing or preparation credentials.
CREATE TABLE public."ScanDispatchLifecycleProof" (
  "proofChecksum" TEXT PRIMARY KEY CHECK("proofChecksum" ~ '^[a-f0-9]{64}$'),
  "operationId" TEXT NOT NULL,"attemptId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,
  "authorityEpochId" TEXT NOT NULL,"headInputChecksum" TEXT NOT NULL,"headSequence" BIGINT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK("expiresAt">"issuedAt" AND "expiresAt"<="issuedAt"+interval '10 seconds')
);
ALTER TABLE public."ScanDispatchLifecycleProof" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ScanDispatchLifecycleProof" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public."ScanDispatchLifecycleProof" FROM PUBLIC;
CREATE FUNCTION app.scan_dispatch_lifecycle_proof_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'accepted lifecycle proof is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER scan_dispatch_lifecycle_proof_immutable BEFORE UPDATE OR DELETE ON public."ScanDispatchLifecycleProof"
 FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_lifecycle_proof_immutable();
REVOKE ALL ON FUNCTION app.scan_dispatch_lifecycle_proof_immutable() FROM PUBLIC;

CREATE FUNCTION app.require_scan_dispatch_proof_role() RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r RECORD;
BEGIN
 IF current_user IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'proof registration requires a direct protected login' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE pg_has_role(current_user,oid,'SET') LOOP
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb
   OR has_schema_privilege(r.rolname,'public','CREATE') OR has_schema_privilege(r.rolname,'app','CREATE')
   OR has_database_privilege(r.rolname,current_database(),'CREATE,TEMPORARY')
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(r.rolname,c.oid,'SELECT,UPDATE')))
   OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.oid<>'app.register_scan_dispatch_lifecycle_proof(text)'::regprocedure AND has_function_privilege(r.rolname,p.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'proof registration role has unrelated authority' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.require_scan_dispatch_proof_role() FROM PUBLIC;

CREATE FUNCTION app.register_scan_dispatch_lifecycle_proof(proof_json TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p JSONB; h TEXT;
BEGIN
 IF octet_length(proof_json)>16384 THEN RAISE EXCEPTION 'proof registration is bounded' USING ERRCODE='23514'; END IF;
 p:=proof_json::jsonb; h:=encode(public.digest(convert_to(proof_json,'UTF8'),'sha256'),'hex');
 IF p->>'purpose' IS DISTINCT FROM 'lyrashield-supervisor-attempt-proof/2' OR coalesce(p->>'signature','') !~ '^[a-f0-9]{128}$'
   OR NOT pg_try_advisory_xact_lock(1819234670,1) THEN RAISE EXCEPTION 'proof registration authority unavailable' USING ERRCODE='23514'; END IF;
 PERFORM set_config('app.current_workspace_id',p#>>'{binding,workspaceId}',true);
 INSERT INTO public."ScanDispatchLifecycleProof"("proofChecksum","operationId","attemptId","workspaceId","authorityEpochId","headInputChecksum","headSequence","issuedAt","expiresAt")
 VALUES(h,p#>>'{binding,operationId}',p#>>'{binding,attemptId}',p#>>'{binding,workspaceId}',p#>>'{binding,authorityEpochId}',p->>'headInputChecksum',(p->>'headSequence')::bigint,(p->>'issuedAt')::timestamptz AT TIME ZONE 'UTC',(p->>'expiresAt')::timestamptz AT TIME ZONE 'UTC') ON CONFLICT("proofChecksum") DO NOTHING;
 IF NOT app.scan_dispatch_lifecycle_proof_current(proof_json,false) THEN RAISE EXCEPTION 'proof registration lacks exact current retained authority' USING ERRCODE='23514'; END IF;
 RETURN h;
END $$;
REVOKE ALL ON FUNCTION app.register_scan_dispatch_lifecycle_proof(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.scan_dispatch_lifecycle_proof_current(proof_json TEXT, allow_shared BOOLEAN DEFAULT false)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p JSONB; receipt_hash TEXT; shared_held BOOLEAN;
BEGIN
  IF proof_json IS NULL OR octet_length(proof_json)>16384 THEN RETURN false; END IF;
  p:=proof_json::jsonb;
  IF NOT EXISTS(SELECT 1 FROM public."ScanDispatchLifecycleProof" accepted
    WHERE accepted."proofChecksum"=encode(public.digest(convert_to(proof_json,'UTF8'),'sha256'),'hex')
      AND accepted."workspaceId"=app.current_workspace_id() AND accepted."operationId"=p#>>'{binding,operationId}'
      AND accepted."attemptId"=p#>>'{binding,attemptId}' AND accepted."authorityEpochId"=p#>>'{binding,authorityEpochId}') THEN RETURN false; END IF;
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
    FOREACH n IN ARRAY ARRAY['Workspace','WorkspaceMember','users','BillingAccount','Target','Policy','Integration','TargetDomainVerification','ScanAttachment','LiveAiSafetyPlan','LiveAiSafetyRun','LiveAiSafetySettings','UserScanSlot','agent_connections','agent_operations','delegated_scan_provenance','ScanDispatchWorkerAssignment','ScanDispatchLifecycleProof',
      'ScanDispatchAttempt','ScanPhysicalExecution','ScanDispatchOutbox','ScanSupervisorReceipt','ScanSupervisorJournalRecord','ScanSupervisorJournalStream','ScanExecutionActionIntent','ScanExecutionInvocationGuard','ScanExecutionInvocationResolution'] LOOP
      IF has_table_privilege(r.rolname,format('public.%I',n),'INSERT,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(r.rolname,format('public.%I',n),'UPDATE') THEN
        RAISE EXCEPTION 'stage role can mutate source or native authority' USING ERRCODE='42501'; END IF;
    END LOOP;
    FOREACH n IN ARRAY ARRAY['ScanDispatchLifecycleProof','ScanSupervisorReceipt','ScanSupervisorJournalRecord','ScanSupervisorJournalStream','ScanExecutionActionIntent','ScanExecutionInvocationGuard','ScanExecutionInvocationResolution'] LOOP
      IF has_table_privilege(r.rolname,format('public.%I',n),'SELECT') OR has_any_column_privilege(r.rolname,format('public.%I',n),'SELECT') THEN
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


CREATE OR REPLACE FUNCTION app.scan_checked_prepare_command() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId";
  IF TG_OP='UPDATE' AND NEW."commandType"='PREPARE' AND a."authorityAcceptedAt" IS NOT NULL
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT ((NEW.status IN ('ACCEPTED','COMPLETED') AND app.scan_supervisor_preparation_completed(NEW.id)) OR (NEW.status='UNKNOWN' AND EXISTS(SELECT 1 FROM public."ScanSupervisorReceipt" r
      WHERE r."commandId"=NEW.id AND r."journalRecordId" IS NOT NULL
        AND r."receiptType"='UNKNOWN' AND r."terminalStatus"='UNKNOWN'))) THEN
    RAISE EXCEPTION 'checked preparation consumption is closed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW."commandType" IN ('START_PAID','START_UNMETERED') AND a."authorityAcceptedAt" IS NOT NULL THEN
    PERFORM app.require_scan_preparation_role();
    IF NEW."authorityProofInputJson" IS NULL OR NOT app.scan_dispatch_lifecycle_proof_current(NEW."authorityProofInputJson",false)
      OR NOT EXISTS(SELECT 1 FROM public."ScanDispatchStart" st WHERE st."operationId"=NEW."operationId" AND st."attemptId"=NEW."attemptId" AND st."authorityProofInputJson" IS NOT NULL) THEN
      RAISE EXCEPTION 'checked lifecycle execution requires registered exact proof and staged decision' USING ERRCODE='23514';
    END IF;
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
