-- Retain authenticated native execution observations without granting positive
-- physical authority. Qualification/native resolution remain separate gates.
ALTER TYPE "ScanSupervisorReceiptType" ADD VALUE 'EXECUTOR_CREATED';

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

