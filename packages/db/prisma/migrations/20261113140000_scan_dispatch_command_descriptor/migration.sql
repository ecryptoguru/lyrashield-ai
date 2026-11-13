-- Legacy command identities remain unavailable; no descriptor is reconstructed or backfilled.
CREATE FUNCTION app.scan_dispatch_command_input_valid(input_json TEXT, checksum TEXT, command_digest TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT (input_json IS NULL AND checksum IS NULL)
    OR (input_json IS NOT NULL AND checksum IS NOT NULL
      AND pg_catalog.octet_length(input_json) BETWEEN 2 AND 131072
      AND checksum ~ '^[a-f0-9]{64}$'
      AND checksum=pg_catalog.encode(public.digest(pg_catalog.convert_to(input_json,'UTF8'),'sha256'),'hex')
      AND command_digest=checksum)
$$;
ALTER TABLE "ScanDispatchOutbox"
  ADD COLUMN "commandInputJson" TEXT,
  ADD COLUMN "commandInputChecksum" TEXT,
  ADD CONSTRAINT "ScanDispatchOutbox_command_input_check" CHECK (
    app.scan_dispatch_command_input_valid("commandInputJson","commandInputChecksum","commandDigest")
  );

CREATE FUNCTION app.scan_dispatch_command_descriptor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE command JSONB; a public."ScanDispatchAttempt"%ROWTYPE; worker_identity TEXT; physical_revision INTEGER;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."commandInputJson" IS DISTINCT FROM OLD."commandInputJson"
      OR NEW."commandInputChecksum" IS DISTINCT FROM OLD."commandInputChecksum" THEN
      RAISE EXCEPTION 'command descriptor is immutable, including unavailable legacy rows' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."commandInputJson" IS NULL AND NEW."commandInputChecksum" IS NULL THEN RETURN NEW; END IF;
  command:=NEW."commandInputJson"::jsonb;
  IF jsonb_typeof(command)<>'object' OR app.scan_preparation_plan_json(command) IS DISTINCT FROM NEW."commandInputJson"
    OR command->>'commandId' IS DISTINCT FROM NEW.id
    OR command->>'type' IS DISTINCT FROM NEW."commandType"::text THEN
    RAISE EXCEPTION 'command descriptor contradicts canonical command identity' USING ERRCODE='23514';
  END IF;
  SELECT * INTO a FROM public."ScanDispatchAttempt" WHERE "attemptId"=NEW."attemptId" AND "operationId"=NEW."operationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'command descriptor attempt unavailable' USING ERRCODE='23514'; END IF;
  IF NEW."commandType"='PREPARE' THEN
    SELECT "instanceId" INTO worker_identity FROM public."ScanWorkerInstanceGrant"
      WHERE id=a."workerInstanceGrantId" AND "authorityEpochId"=a."authorityEpochId";
    SELECT revision INTO physical_revision FROM public."ScanPhysicalExecution"
      WHERE "attemptId"=a."attemptId" AND "operationId"=a."operationId";
    IF command-ARRAY['type','commandId','attempt','executors','provider']<>'{}'::jsonb
      OR jsonb_typeof(command->'attempt') IS DISTINCT FROM 'object'
      OR command#>>'{attempt,attemptId}' IS DISTINCT FROM a."attemptId"
      OR command#>>'{attempt,operationId}' IS DISTINCT FROM a."operationId"
      OR command#>>'{attempt,scanId}' IS DISTINCT FROM a."scanId"
      OR command#>>'{attempt,workspaceId}' IS DISTINCT FROM a."workspaceId"
      OR command#>>'{attempt,authorityEpochId}' IS DISTINCT FROM a."authorityEpochId"
      OR command#>>'{attempt,workerIdentity}' IS DISTINCT FROM worker_identity
      OR (command#>>'{attempt,authorityRevision}')::integer IS DISTINCT FROM physical_revision
      OR (command#>>'{attempt,expiresAt}')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM a."expiresAt"
      OR command#>>'{attempt,billingMode}' IS DISTINCT FROM (CASE WHEN a."maxBudgetUsd">0 THEN 'PAID' ELSE 'UNMETERED' END)
      OR jsonb_typeof(command->'executors') IS DISTINCT FROM 'array'
      OR jsonb_array_length(command->'executors') NOT BETWEEN 1 AND 10
      OR (a."maxBudgetUsd"=0 AND command ? 'provider') THEN
      RAISE EXCEPTION 'PREPARE descriptor contradicts persisted authority' USING ERRCODE='23514';
    END IF;
    IF (a."maxBudgetUsd">0) IS DISTINCT FROM (command ? 'provider')
      OR (command ? 'provider' AND NOT coalesce(
        jsonb_typeof(command->'provider')='object'
        AND jsonb_typeof(command#>'{provider,costReservationMicros}')='number'
        AND jsonb_typeof(command#>'{provider,maxReservedCostMicros}')='number'
        AND (command#>>'{provider,costReservationMicros}')::numeric BETWEEN 0 AND (command#>>'{provider,maxReservedCostMicros}')::numeric
        AND (command#>>'{provider,maxReservedCostMicros}')::numeric BETWEEN 0 AND a."maxBudgetUsd"*1000000
        AND (command#>>'{provider,costReservationMicros}')::numeric=trunc((command#>>'{provider,costReservationMicros}')::numeric)
        AND (command#>>'{provider,maxReservedCostMicros}')::numeric=trunc((command#>>'{provider,maxReservedCostMicros}')::numeric),false)) THEN
      RAISE EXCEPTION 'provider descriptor contradicts persisted budget authority' USING ERRCODE='23514';
    END IF;
  ELSIF command->>'attemptId' IS DISTINCT FROM a."attemptId"
    OR command-ARRAY['type','commandId','attemptId','executorKey','expectedReceiptHash']<>'{}'::jsonb
    OR coalesce(command->>'expectedReceiptHash','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'follow-up descriptor contradicts persisted attempt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_dispatch_command_descriptor_guard BEFORE INSERT OR UPDATE ON "ScanDispatchOutbox"
  FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_command_descriptor_guard();
