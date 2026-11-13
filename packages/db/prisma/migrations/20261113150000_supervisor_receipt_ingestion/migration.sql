-- Private retained control-plane evidence. Installation provisions stream/key
-- metadata separately; no runtime/user grants or historical proof backfill.
CREATE TABLE "ScanSupervisorJournalStream" (
  id TEXT PRIMARY KEY,
  "authorityEpochId" TEXT NOT NULL REFERENCES "ScanAuthorityEpoch"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "supervisorInstanceId" TEXT NOT NULL,
  "originalKeyHash" TEXT NOT NULL CHECK ("originalKeyHash" ~ '^[a-f0-9]{64}$'),
  "wrapperKeyHash" TEXT NOT NULL CHECK ("wrapperKeyHash" ~ '^[a-f0-9]{64}$'),
  "confirmedSequence" BIGINT NOT NULL DEFAULT 0 CHECK ("confirmedSequence" BETWEEN 0 AND 9007199254740991),
  "originalHash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK ("originalHash" ~ '^[a-f0-9]{64}$'),
  "wrapperHash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK ("wrapperHash" ~ '^[a-f0-9]{64}$'),
  "headInputJson" TEXT,
  "projectionSequence" INTEGER NOT NULL DEFAULT 0 CHECK ("projectionSequence">=0),
  "projectionHash" TEXT CHECK ("projectionHash" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanSupervisorJournalStream_identity_key" UNIQUE ("authorityEpochId", "supervisorInstanceId")
);
CREATE TABLE "ScanSupervisorJournalRecord" (
  id TEXT PRIMARY KEY,
  "streamId" TEXT NOT NULL REFERENCES "ScanSupervisorJournalStream"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  "workspaceId" TEXT NOT NULL, "operationId" TEXT NOT NULL, "attemptId" TEXT NOT NULL,
  "originalHash" TEXT NOT NULL CHECK ("originalHash" ~ '^[a-f0-9]{64}$'),
  "wrapperHash" TEXT NOT NULL CHECK ("wrapperHash" ~ '^[a-f0-9]{64}$'),
  "originalInputJson" TEXT NOT NULL CHECK (octet_length("originalInputJson") <= 262144),
  "wrapperInputJson" TEXT NOT NULL CHECK (octet_length("wrapperInputJson") <= 262144),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("streamId", sequence), UNIQUE ("streamId", "originalHash"), UNIQUE ("streamId", "wrapperHash")
);
CREATE INDEX "ScanSupervisorJournalRecord_operationId_sequence_idx"
  ON "ScanSupervisorJournalRecord"("operationId", sequence);
REVOKE ALL ON "ScanSupervisorJournalStream", "ScanSupervisorJournalRecord" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['app_runtime_prod','app_system_prod','app_runtime_ci','anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public."ScanSupervisorJournalStream", public."ScanSupervisorJournalRecord" FROM %I',role_name);
    END IF;
  END LOOP;
END $$;


CREATE FUNCTION app.scan_supervisor_journal_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE stream public."ScanSupervisorJournalStream"%ROWTYPE;
  predecessor public."ScanSupervisorJournalRecord"%ROWTYPE;
  original JSONB; wrapper JSONB;
BEGIN
  SELECT * INTO stream FROM public."ScanSupervisorJournalStream" WHERE id=NEW."streamId" FOR UPDATE;
  original:=NEW."originalInputJson"::jsonb; wrapper:=NEW."wrapperInputJson"::jsonb;
  IF NOT coalesce(original->>'version'='1' AND wrapper->>'version'='1'
    AND (original->>'sequence')::bigint=NEW.sequence AND (wrapper->>'sequence')::bigint=NEW.sequence
    AND original->>'hash'=NEW."originalHash" AND wrapper->>'hash'=NEW."wrapperHash"
    AND wrapper->'payload'->'payload'=original
    AND wrapper->'payload'->>'epochId'=stream."authorityEpochId"
    AND original->'payload'->>'supervisorInstanceId'=stream."supervisorInstanceId"
    AND wrapper->'payload'->>'eventId'='supervisor:'||NEW."originalHash"
    AND wrapper->'payload'->>'workspaceId'=NEW."workspaceId"
    AND wrapper->'payload'->>'operationId'=NEW."operationId"
    AND wrapper->'payload'->>'attemptId'=NEW."attemptId",false) THEN
    RAISE EXCEPTION 'signed journal record binding mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.sequence>1 THEN
    SELECT * INTO predecessor FROM public."ScanSupervisorJournalRecord"
      WHERE "streamId"=NEW."streamId" AND sequence=NEW.sequence-1;
    IF predecessor.id IS NULL THEN
      RAISE EXCEPTION 'signed journal predecessor unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF original->>'previousHash' IS DISTINCT FROM coalesce(predecessor."originalHash",repeat('0',64))
    OR wrapper->>'previousHash' IS DISTINCT FROM coalesce(predecessor."wrapperHash",repeat('0',64)) THEN
    RAISE EXCEPTION 'signed journal chain mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_supervisor_journal_record_guard BEFORE INSERT ON "ScanSupervisorJournalRecord"
  FOR EACH ROW EXECUTE FUNCTION app.scan_supervisor_journal_record_guard();

CREATE FUNCTION app.scan_supervisor_journal_retained() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'signed supervisor journal is retained' USING ERRCODE='23514';
END $$;
CREATE TRIGGER scan_supervisor_journal_record_retained BEFORE UPDATE OR DELETE ON "ScanSupervisorJournalRecord"
  FOR EACH ROW EXECUTE FUNCTION app.scan_supervisor_journal_retained();
CREATE TRIGGER scan_supervisor_journal_stream_retained BEFORE DELETE ON "ScanSupervisorJournalStream"
  FOR EACH ROW EXECUTE FUNCTION app.scan_supervisor_journal_retained();

CREATE FUNCTION app.scan_supervisor_journal_stream_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE record public."ScanSupervisorJournalRecord"%ROWTYPE; head JSONB;
BEGIN
  IF (NEW.id,NEW."authorityEpochId",NEW."supervisorInstanceId",NEW."originalKeyHash",NEW."wrapperKeyHash",NEW."createdAt")
    IS DISTINCT FROM (OLD.id,OLD."authorityEpochId",OLD."supervisorInstanceId",OLD."originalKeyHash",OLD."wrapperKeyHash",OLD."createdAt")
    OR NEW."confirmedSequence"<OLD."confirmedSequence" THEN
    RAISE EXCEPTION 'supervisor stream identity or confirmed prefix changed' USING ERRCODE='23514';
  END IF;
  IF NEW."confirmedSequence"=OLD."confirmedSequence" THEN
    IF (NEW."originalHash",NEW."wrapperHash",NEW."headInputJson") IS DISTINCT FROM
      (OLD."originalHash",OLD."wrapperHash",OLD."headInputJson") THEN
      RAISE EXCEPTION 'confirmed supervisor head is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO record FROM public."ScanSupervisorJournalRecord" WHERE "streamId"=NEW.id AND sequence=NEW."confirmedSequence";
  head:=NEW."headInputJson"::jsonb;
  IF record.id IS NULL OR NOT coalesce(record."originalHash"=NEW."originalHash" AND record."wrapperHash"=NEW."wrapperHash"
    AND head->>'schema'='lyrashield-independent-authority-head/1'
    AND head->>'epochId'=NEW."authorityEpochId" AND head->>'supervisorInstanceId'=NEW."supervisorInstanceId"
    AND (head->>'sequence')::bigint=NEW."confirmedSequence" AND head->>'recordHash'=record."wrapperHash",false) THEN
    RAISE EXCEPTION 'confirmed supervisor head lacks retained signed chain' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_supervisor_journal_stream_guard BEFORE UPDATE ON "ScanSupervisorJournalStream"
  FOR EACH ROW EXECUTE FUNCTION app.scan_supervisor_journal_stream_guard();
REVOKE ALL ON FUNCTION app.scan_supervisor_journal_record_guard(),
  app.scan_supervisor_journal_retained(), app.scan_supervisor_journal_stream_guard() FROM PUBLIC;

-- Summary fields remain projections. The exact signed source is independently
-- retained in the private continuous ledger; legacy NULL stays unavailable.
ALTER TABLE "ScanSupervisorReceipt"
  ADD COLUMN "journalRecordId" TEXT UNIQUE REFERENCES "ScanSupervisorJournalRecord"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "eventType" TEXT,
  ADD COLUMN "terminalStatus" TEXT,
  ADD CONSTRAINT "ScanSupervisorReceipt_source_check" CHECK (
    ("journalRecordId" IS NULL AND "eventType" IS NULL AND "terminalStatus" IS NULL)
    OR ("journalRecordId" IS NOT NULL AND "eventType" IS NOT NULL
      AND ("terminalStatus" IS NULL OR "terminalStatus" IN
        ('RECEIVED','PREPARED','EFFECT_PENDING','STARTED','STOPPED','NEVER_DISPATCHED','UNKNOWN','REJECTED','FAILED')))
  );

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

-- Only authenticated uncertainty can consume a checked intent negatively.
CREATE OR REPLACE FUNCTION app.scan_checked_prepare_command() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE a public."ScanDispatchAttempt"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId";
  IF TG_OP='UPDATE' AND NEW."commandType"='PREPARE' AND a."authorityAcceptedAt" IS NOT NULL
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT (NEW.status='UNKNOWN' AND EXISTS(SELECT 1 FROM public."ScanSupervisorReceipt" r
      WHERE r."commandId"=NEW.id AND r."journalRecordId" IS NOT NULL
        AND r."receiptType"='UNKNOWN' AND r."terminalStatus"='UNKNOWN')) THEN
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

CREATE OR REPLACE FUNCTION app.scan_dispatch_outbox_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."operationId" <> OLD."operationId"
     OR NEW."attemptId" <> OLD."attemptId"
     OR NEW."commandType" <> OLD."commandType"
     OR NEW."sequence" <> OLD."sequence"
     OR NEW."commandDigest" <> OLD."commandDigest"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'scan dispatch command is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('LEASED', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'LEASED' AND NEW."status" IN ('PENDING', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'DELIVERED' AND NEW."status" IN ('ACCEPTED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('COMPLETED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'UNKNOWN' AND NEW."status" IN ('COMPLETED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid outbox status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'outbox attempt count cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'LEASED' AND (NEW."leaseOwner" IS NULL OR NEW."leaseExpiresAt" IS NULL) THEN
    RAISE EXCEPTION 'leased outbox command requires a lease' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('DELIVERED', 'ACCEPTED', 'COMPLETED', 'REJECTED') AND NEW."deliveredAt" IS NULL THEN
    RAISE EXCEPTION 'delivered or terminal outbox status requires delivery timestamp' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('ACCEPTED', 'COMPLETED', 'REJECTED') AND NOT EXISTS (
    SELECT 1 FROM "ScanSupervisorReceipt" r
    WHERE r."commandId" = NEW."id"
      AND r."operationId" = NEW."operationId"
      AND r."attemptId" = NEW."attemptId"
      AND r."receiptType" <> 'UNKNOWN'
  ) THEN
    RAISE EXCEPTION 'outbox acceptance requires an authenticated supervisor receipt' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'UNKNOWN' AND NOT (EXISTS (
    SELECT 1 FROM public."ScanPhysicalExecution" p JOIN public."ScanSupervisorReceipt" r
      ON r."attemptId"=p."attemptId" AND r."operationId"=p."operationId"
    WHERE p."attemptId"=NEW."attemptId" AND p."operationId"=NEW."operationId" AND p.state='UNKNOWN'
      AND r."commandId"=NEW.id AND r."journalRecordId" IS NOT NULL
      AND r."receiptType"='UNKNOWN' AND r."terminalStatus"='UNKNOWN'
  ) OR EXISTS (
    SELECT 1
    FROM "ScanPhysicalExecution" p
    JOIN "ScanSupervisorReceipt" r ON r."id" = p."lastReceiptId"
    WHERE p."attemptId" = NEW."attemptId"
      AND p."operationId" = NEW."operationId"
      AND p."state" = 'UNKNOWN'
      AND r."commandId" = NEW."id"
      AND r."receiptType" = 'UNKNOWN'
  )) THEN
    RAISE EXCEPTION 'unknown command lacks physical quarantine' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'UNKNOWN' AND NEW."status" = 'COMPLETED' AND NOT EXISTS (
    SELECT 1 FROM "ScanDispatchOutbox"
    WHERE "operationId" = NEW."operationId"
      AND "attemptId" = NEW."attemptId"
      AND "commandType" = 'RECONCILE'
      AND "status" = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'unknown command cannot complete without reconciliation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
