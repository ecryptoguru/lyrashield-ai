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
      WHEN event->>'type'='attempt_prepared' THEN 'PREPARE_COMPLETED'
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
 expected_phase:=CASE e->>'nativeOperation' WHEN 'CONTAINER_CREATE_ACK' THEN 'EXECUTOR_CREATE'
    WHEN 'CONTAINER_START_ACK' THEN 'EXECUTOR_START' ELSE NULL END;
 SELECT c."commandInputChecksum" INTO checksum FROM public."ScanDispatchOutbox" c WHERE c.id=g."commandId"
   AND c."attemptId"=g."attemptId" AND c."operationId"=g."operationId" AND c."commandInputJson" IS NOT NULL;
 IF g.id IS NULL OR r.id IS NULL OR j.id IS NULL OR s.id IS NULL OR checksum IS NULL
   OR j.sequence>s."confirmedSequence" OR r."receiptHash" IS DISTINCT FROM j."originalHash"
   OR r.signature IS DISTINCT FROM j."originalInputJson"::jsonb->>'signature'
   OR r."eventType" IS DISTINCT FROM 'native_invocation_ack' OR r."terminalStatus" IS NOT NULL
   OR e->>'type' IS DISTINCT FROM 'native_invocation_ack'
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
   OR e->>'commandInputChecksum' IS DISTINCT FROM checksum OR e->>'executorKey' IS DISTINCT FROM g."executorKey"
   OR ownership->>'kind' IS DISTINCT FROM 'container' OR ownership->>'containerId' IS NULL OR ownership->>'containerId' !~ '^[a-f0-9]{64}$'
   OR ownership->>'executorKey' IS DISTINCT FROM g."executorKey"
   OR ownership->>'ownershipId' IS DISTINCT FROM 'own_'||substring(encode(public.digest(
     convert_to(g."attemptId",'UTF8')||decode('00','hex')||convert_to(g."commandId",'UTF8')||decode('00','hex')||convert_to(g."executorKey",'UTF8'),'sha256'),'hex') FROM 1 FOR 40)
   OR inspection->>'state' IS DISTINCT FROM 'PRESENT' OR inspection->'ownership' IS DISTINCT FROM ownership
   OR inspection->'running' IS DISTINCT FROM to_jsonb(expected_phase='EXECUTOR_START') THEN
  RAISE EXCEPTION 'invocation resolution lacks exact confirmed original native ACK' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.scan_execution_invocation_resolution_guard() FROM PUBLIC;
