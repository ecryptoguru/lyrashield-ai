-- Additive and closed: no backfill, role grant, epoch opening or admission change.
ALTER TABLE "ScanQueueOutbox"
  ADD COLUMN "payloadInputJson" TEXT,
  ADD COLUMN "publicationReceiptInputJson" TEXT,
  ADD COLUMN "publicationReceiptChecksum" TEXT;

ALTER TABLE "ScanQueueOutbox"
  ADD CONSTRAINT "ScanQueueOutbox_payload_input_checksum_check" CHECK (
    "payloadInputJson" IS NULL OR (
      octet_length("payloadInputJson") BETWEEN 2 AND 4096
      AND encode(digest(convert_to("payloadInputJson", 'UTF8'), 'sha256'), 'hex') = "payloadDigest"
    )
  ),
  ADD CONSTRAINT "ScanQueueOutbox_publication_receipt_checksum_check" CHECK (
    ("publicationReceiptInputJson" IS NULL AND "publicationReceiptChecksum" IS NULL)
    OR ("publicationReceiptInputJson" IS NOT NULL AND "publicationReceiptChecksum" IS NOT NULL
      AND octet_length("publicationReceiptInputJson") BETWEEN 2 AND 2048
      AND encode(digest(convert_to("publicationReceiptInputJson", 'UTF8'), 'sha256'), 'hex')
        = "publicationReceiptChecksum")
  );

CREATE FUNCTION app.scan_queue_publication_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payload JSONB;
  receipt JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."payloadInputJson" IS DISTINCT FROM OLD."payloadInputJson" THEN
      RAISE EXCEPTION 'queue payload bytes are immutable, including legacy absence' USING ERRCODE = '23514';
    END IF;
    IF OLD."payloadInputJson" IS NOT NULL AND OLD."state" = 'LEASED' AND NEW."state" = 'PENDING' THEN
      RAISE EXCEPTION 'attempted queue publication cannot return to pending' USING ERRCODE = '23514';
    END IF;
    IF OLD."publicationReceiptInputJson" IS NOT NULL AND (
      NEW."publicationReceiptInputJson" IS DISTINCT FROM OLD."publicationReceiptInputJson"
      OR NEW."publicationReceiptChecksum" IS DISTINCT FROM OLD."publicationReceiptChecksum"
    ) THEN
      RAISE EXCEPTION 'queue publication proof is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."payloadInputJson" IS NOT NULL AND NEW."state" NOT IN ('PENDING', 'UNKNOWN') THEN
    RAISE EXCEPTION 'new queue publication begins pending or quarantined' USING ERRCODE = '23514';
  END IF;

  IF NEW."payloadInputJson" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."state" IN ('LEASED','PUBLISHED')) THEN
    payload := NEW."payloadInputJson"::jsonb;
    IF NOT coalesce(jsonb_typeof(payload) = 'object'
      AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(payload) k
        WHERE k NOT IN ('scanId','workspaceId','targetId','goal','mode','policyId','focus'))
      AND (NOT payload ? 'focus' OR payload->>'focus' IN
        ('auth','payments','llm_surface','file_handling','data_exposure'))
      AND EXISTS (
        SELECT 1 FROM "Scan" s JOIN "ScanDispatchOperation" o ON o."scanId" = s.id
        WHERE s.id = NEW."scanId" AND o."operationId" = NEW."operationId"
          AND payload->>'scanId' = s.id AND payload->>'workspaceId' = s."workspaceId"
          AND payload->>'targetId' = s."targetId" AND payload->>'goal' = s.goal::text
          AND payload->>'mode' = s.mode::text
          AND payload->>'policyId' IS NOT DISTINCT FROM s."policyId"
      ), false) THEN
      RAISE EXCEPTION 'queue payload contradicts immutable admitted identity' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."state" = 'LEASED' THEN
    IF TG_OP <> 'UPDATE' OR OLD."state" <> 'PENDING'
      OR OLD."attempts" <> 0
      OR NEW."payloadInputJson" IS NULL
      OR NEW."leaseOwner" IS NULL OR length(NEW."leaseOwner") NOT BETWEEN 1 AND 128
      OR NEW."leaseExpiresAt" IS NULL OR NEW."leaseExpiresAt" <= clock_timestamp()
      OR NEW."leaseExpiresAt" > clock_timestamp() + interval '60 seconds'
      OR NEW."attempts" <> OLD."attempts" + 1
      OR NOT EXISTS (
        SELECT 1 FROM "ScanDispatchOperation" o JOIN "Scan" s ON s.id = o."scanId"
        WHERE o."operationId" = NEW."operationId" AND o."scanId" = NEW."scanId"
          AND o."state" IN ('QUEUED','WAITING_CAPACITY')
          AND s."deletedAt" IS NULL AND s.status IN ('QUEUED','PREFLIGHT')
          AND o."requestDigest" = app.scan_dispatch_scope_digest(s.id)
          AND NOT EXISTS (SELECT 1 FROM "ScanEvent" e WHERE e."scanId" = s.id AND e.stage = 'billable_boundary')
      ) THEN
      RAISE EXCEPTION 'queue lease requires bounded live unclaimed authority' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."publicationReceiptInputJson" IS NOT NULL THEN
    receipt := NEW."publicationReceiptInputJson"::jsonb;
    IF NEW."state" <> 'PUBLISHED' OR NEW."payloadInputJson" IS NULL OR NOT coalesce(
      jsonb_typeof(receipt) = 'object'
      AND receipt->>'version' = 'scan-queue-publication/1'
      AND receipt->>'outboxId' = NEW.id AND receipt->>'operationId' = NEW."operationId"
      AND receipt->>'jobId' = NEW."jobId" AND receipt->>'queueName' = 'scans'
      AND receipt->>'jobName' = 'scan' AND receipt->>'payloadDigest' = NEW."payloadDigest"
      AND receipt->>'jobState' IN ('waiting','delayed','paused','prioritized','active','completed','failed','waiting-children')
      AND receipt->>'observedAt' IS NOT NULL, false) THEN
      RAISE EXCEPTION 'queue publication proof contradicts its identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."state" = 'PUBLISHED' AND NEW."payloadInputJson" IS NOT NULL THEN
    RAISE EXCEPTION 'publication requires positive queue readback proof' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scan_queue_publication_guard
BEFORE INSERT OR UPDATE ON "ScanQueueOutbox"
FOR EACH ROW EXECUTE FUNCTION app.scan_queue_publication_guard();
REVOKE ALL ON FUNCTION app.scan_queue_publication_guard() FROM PUBLIC;

CREATE FUNCTION app.scan_queue_publication_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ScanQueueOutbox" q
    WHERE q."operationId" = NEW."operationId" AND q."scanId" = NEW."scanId"
      AND q."jobId" = NEW."scanId" AND q."state" = 'PUBLISHED'
      AND q."payloadInputJson" IS NOT NULL
      AND q."publicationReceiptInputJson" IS NOT NULL
      AND q."publicationReceiptChecksum" IS NOT NULL
      AND NEW."focusDigest" IS NOT DISTINCT FROM CASE
        WHEN q."payloadInputJson"::jsonb ? 'focus' THEN
          encode(digest(convert_to((q."payloadInputJson"::jsonb->'focus')::text, 'UTF8'), 'sha256'), 'hex')
        ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'dispatch requires a published immutable queue proof and focus binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_queue_publication_attempt_guard
BEFORE INSERT ON "ScanDispatchAttempt"
FOR EACH ROW EXECUTE FUNCTION app.scan_queue_publication_attempt_guard();
REVOKE ALL ON FUNCTION app.scan_queue_publication_attempt_guard() FROM PUBLIC;
