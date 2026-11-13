-- Original native ACK resolves the invocation fence only. Financial and physical UNKNOWN holds remain.
CREATE OR REPLACE FUNCTION app.scan_supervisor_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  expected_sequence INTEGER;
  expected_previous TEXT;
  command_operation TEXT;
  command_attempt TEXT;
  command_epoch TEXT;
  source public."ScanSupervisorJournalRecord"%ROWTYPE;
  stream public."ScanSupervisorJournalStream"%ROWTYPE;
  event JSONB; expected_type TEXT; expected_terminal TEXT;
BEGIN
  IF NEW."journalRecordId" IS NULL THEN
  SELECT coalesce(max(r."sequence"), 0) + 1,
         (SELECT r2."receiptHash" FROM "ScanSupervisorReceipt" r2
          WHERE r2."supervisorInstanceId" = NEW."supervisorInstanceId"
          ORDER BY r2."sequence" DESC LIMIT 1)
    INTO expected_sequence, expected_previous
  FROM "ScanSupervisorReceipt" r
  WHERE r."supervisorInstanceId" = NEW."supervisorInstanceId";
  IF NEW."sequence" <> expected_sequence THEN
    RAISE EXCEPTION 'supervisor receipt sequence must be contiguous' USING ERRCODE = '23514';
  END IF;
  IF NEW."previousReceiptHash" IS DISTINCT FROM expected_previous THEN
    RAISE EXCEPTION 'supervisor receipt chain predecessor mismatch' USING ERRCODE = '23514';
  END IF;
  ELSE
    SELECT * INTO source FROM public."ScanSupervisorJournalRecord" WHERE id=NEW."journalRecordId";
    SELECT * INTO stream FROM public."ScanSupervisorJournalStream" WHERE id=source."streamId" FOR UPDATE;
    event:=source."originalInputJson"::jsonb->'payload';
    expected_terminal:=CASE WHEN event->>'type'='command_recovery_hold' THEN 'UNKNOWN'
      WHEN event->>'type'='command_terminal' THEN event->>'status' ELSE NULL END;
    expected_type:=CASE WHEN event->>'type'='command_intent' THEN 'COMMAND_ACCEPTED'
      WHEN event->>'type' IN ('attempt_prepared','prepare_invocation_completed') THEN 'PREPARE_COMPLETED'
      WHEN event->>'type' IN ('resource_create_planned','resource_create_acknowledged','resource_start_planned') THEN 'EXECUTOR_CREATE_INTENT'
      WHEN event->>'type'='native_invocation_ack' THEN 'EXECUTOR_CREATE_INTENT'
      WHEN event->>'type'='resource_bound' THEN 'EXECUTOR_CREATED'
      WHEN event->>'type'='resource_started' THEN 'EXECUTOR_STARTED'
      WHEN expected_terminal='PREPARED' THEN 'PREPARE_COMPLETED'
      WHEN expected_terminal='STARTED' THEN 'EXECUTOR_STARTED'
      WHEN expected_terminal='STOPPED' THEN 'STOPPED'
      WHEN expected_terminal='NEVER_DISPATCHED' THEN 'NEVER_DISPATCHED'
      ELSE 'UNKNOWN' END;
    IF source.id IS NULL OR source.sequence>stream."confirmedSequence"
      OR NEW."sequence"<>stream."projectionSequence"+1
      OR NEW."previousReceiptHash" IS DISTINCT FROM stream."projectionHash"
      OR NEW."supervisorInstanceId"<>stream."supervisorInstanceId"
      OR NEW."authorityEpochId"<>stream."authorityEpochId"
      OR NEW."operationId"<>source."operationId" OR NEW."attemptId"<>source."attemptId"
      OR NEW."receiptHash"<>source."originalHash"
      OR NEW.signature IS DISTINCT FROM source."originalInputJson"::jsonb->>'signature'
      OR NEW."eventType" IS DISTINCT FROM event->>'type'
      OR NEW."terminalStatus" IS DISTINCT FROM expected_terminal
      OR NEW."receiptType"::text IS DISTINCT FROM expected_type
      OR NEW."commandId" IS DISTINCT FROM coalesce(event->>'commandId',event->'command'->>'commandId')
      OR NOT EXISTS(SELECT 1 FROM public."ScanDispatchOutbox" c WHERE c.id=NEW."commandId"
        AND c."operationId"=source."operationId" AND c."attemptId"=source."attemptId"
        AND c."commandInputJson" IS NOT NULL AND EXISTS(
          SELECT 1 FROM public."ScanSupervisorJournalRecord" i WHERE i."streamId"=source."streamId"
          AND i."operationId"=source."operationId" AND i."attemptId"=source."attemptId" AND i.sequence<=source.sequence
          AND i."originalInputJson"::jsonb->'payload'->>'type'='command_intent'
          AND i."originalInputJson"::jsonb->'payload'->'command'=c."commandInputJson"::jsonb)) THEN
      RAISE EXCEPTION 'receipt projection lacks confirmed exact signed command source' USING ERRCODE='23514';
    END IF;
    UPDATE public."ScanSupervisorJournalStream" SET "projectionSequence"=NEW."sequence", "projectionHash"=NEW."receiptHash" WHERE id=stream.id;
  END IF;
  SELECT o."operationId", o."attemptId", a."authorityEpochId"
    INTO command_operation, command_attempt, command_epoch
  FROM "ScanDispatchOutbox" o
  JOIN "ScanDispatchAttempt" a ON a."operationId" = o."operationId" AND a."attemptId" = o."attemptId"
  WHERE o."id" = NEW."commandId";
  IF command_operation IS NULL
     OR command_operation <> NEW."operationId"
     OR command_attempt <> NEW."attemptId"
     OR command_epoch <> NEW."authorityEpochId" THEN
    RAISE EXCEPTION 'supervisor receipt contradicts its command identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


-- The private receipt consumer already authenticated both original and independent
-- envelopes/head before confirmation. This predicate binds that immutable retained
-- source to the exact original committed guard; it never grants new action authority.
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
    WHEN e->>'nativeOperation'='CONTAINER_START_ACK' THEN 'EXECUTOR_START' ELSE NULL END;

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
   OR e->>'actionChecksum' IS DISTINCT FROM g."actionChecksum" OR g."actionChecksum" IS DISTINCT FROM checksum
   OR e->>'commandInputChecksum' IS DISTINCT FROM checksum
   OR (expected_phase='PREPARE' AND (g."executorKey" IS NOT NULL OR NOT EXISTS(
     SELECT 1 FROM public."ScanSupervisorJournalRecord" p JOIN public."ScanDispatchOutbox" c ON c.id=g."commandId"
     WHERE p."streamId"=j."streamId" AND p."operationId"=g."operationId" AND p."attemptId"=g."attemptId" AND p.sequence<j.sequence
       AND p."originalInputJson"::jsonb->'payload'->>'type'='attempt_prepared'
       AND p."originalInputJson"::jsonb->'payload'->>'commandId'=g."commandId"
       AND p."originalInputJson"::jsonb->'payload'->'binding'=c."commandInputJson"::jsonb->'attempt'
       AND p."originalInputJson"::jsonb->'payload'->'executors'=c."commandInputJson"::jsonb->'executors'
       AND p."originalInputJson"::jsonb->'payload'->'provider' IS NOT DISTINCT FROM c."commandInputJson"::jsonb->'provider')))
   OR (expected_phase<>'PREPARE' AND (e->>'executorKey' IS DISTINCT FROM g."executorKey"
   OR ownership->>'kind' IS DISTINCT FROM 'container' OR ownership->>'containerId' IS NULL OR ownership->>'containerId' !~ '^[a-f0-9]{64}$'
   OR ownership->>'executorKey' IS DISTINCT FROM g."executorKey"
   OR ownership->>'ownershipId' IS DISTINCT FROM 'own_'||substring(encode(public.digest(
     convert_to(g."attemptId",'UTF8')||decode('00','hex')||convert_to(g."commandId",'UTF8')||decode('00','hex')||convert_to(g."executorKey",'UTF8'),'sha256'),'hex') FROM 1 FOR 40)
   OR inspection->>'state' IS DISTINCT FROM 'PRESENT' OR inspection->'ownership' IS DISTINCT FROM ownership
   OR inspection->'running' IS DISTINCT FROM to_jsonb(expected_phase='EXECUTOR_START'))) THEN
  RAISE EXCEPTION 'invocation resolution lacks exact confirmed original completion proof' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.scan_execution_invocation_resolution_guard() FROM PUBLIC;

-- Metadata preparation is a retained past fact, not permission to start an
-- executor. START remains closed until installed exact-host qualification.
CREATE FUNCTION app.scan_supervisor_preparation_completed(command_id TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.scan_preparation_gate_held() THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public."ScanDispatchOutbox" c
   JOIN public."ScanDispatchAttempt" a ON a."operationId"=c."operationId" AND a."attemptId"=c."attemptId"
   JOIN public."ScanExecutionInvocationGuard" g ON g."commandId"=c.id AND g."operationId"=a."operationId" AND g."attemptId"=a."attemptId" AND g.phase='PREPARE'
   JOIN public."ScanExecutionInvocationResolution" resolution ON resolution."guardId"=g.id
   JOIN public."ScanSupervisorReceipt" proof ON proof.id=resolution."receiptId" AND proof."commandId"=c.id AND proof."eventType"='prepare_invocation_completed'
   JOIN public."ScanSupervisorJournalRecord" original ON original.id=proof."journalRecordId"
   JOIN public."ScanSupervisorJournalStream" stream ON stream.id=original."streamId" AND stream."authorityEpochId"=a."authorityEpochId"
   WHERE c.id=command_id AND c."commandType"='PREPARE' AND c."commandInputJson" IS NOT NULL
     AND a."authorityAcceptedAt" IS NOT NULL AND a."workspaceId"=app.current_workspace_id()
     AND g."authorityEpochId"=a."authorityEpochId" AND g."actionChecksum"=c."commandInputChecksum"
     AND original.sequence<=stream."confirmedSequence"
     AND EXISTS(SELECT 1 FROM public."ScanSupervisorReceipt" terminal JOIN public."ScanSupervisorJournalRecord" t ON t.id=terminal."journalRecordId"
       WHERE terminal."commandId"=c.id AND terminal."eventType"='attempt_prepared' AND terminal."receiptType"='PREPARE_COMPLETED'
         AND t."streamId"=stream.id AND t.sequence<original.sequence AND t.sequence<=stream."confirmedSequence")
     AND NOT EXISTS(SELECT 1 FROM public."ScanSupervisorJournalRecord" hold WHERE hold."streamId"=stream.id
       AND hold."operationId"=a."operationId" AND hold."attemptId"=a."attemptId" AND hold.sequence<=stream."confirmedSequence"
       AND (hold."originalInputJson"::jsonb->'payload'->>'type'='command_recovery_hold'
         OR (hold."originalInputJson"::jsonb->'payload'->>'type' IN ('command_terminal','attempt_status')
           AND hold."originalInputJson"::jsonb->'payload'->>'status'='UNKNOWN'))));
END $$;
REVOKE ALL ON FUNCTION app.scan_supervisor_preparation_completed(TEXT) FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION app.reject_checked_preparation_consumption() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE command_id TEXT;
BEGIN
 IF NEW."toState" IN ('PREPARING','DISPATCH_PENDING','ACTIVE') AND EXISTS(
   SELECT 1 FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId" AND "authorityAcceptedAt" IS NOT NULL) THEN
  SELECT r."commandId" INTO command_id FROM public."ScanSupervisorReceipt" r WHERE r.id=NEW."supervisorReceiptId"
    AND r."operationId"=NEW."operationId" AND r."attemptId"=NEW."attemptId" AND r."eventType"='command_intent';
  IF NEW."toState"<>'PREPARING' OR command_id IS NULL OR NOT app.scan_supervisor_preparation_completed(command_id) THEN
   RAISE EXCEPTION 'checked execution consumption is not qualified' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reject_checked_preparation_consumption(),app.scan_checked_prepare_command() FROM PUBLIC;

-- Exact historical command lookup stays indexed after old local segments rotate.
-- This derived index never changes or manufactures immutable original bytes.
CREATE INDEX "ScanSupervisorJournalRecord_command_source_idx" ON "ScanSupervisorJournalRecord"(
 "streamId","attemptId",(coalesce("originalInputJson"::jsonb->'payload'->>'commandId',"originalInputJson"::jsonb->'payload'->'command'->>'commandId')),sequence);
