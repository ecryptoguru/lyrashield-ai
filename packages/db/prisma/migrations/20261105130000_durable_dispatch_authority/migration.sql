-- Additive durable-dispatch authority foundation. Runtime producers remain
-- unchanged; no broker or supervisor is enabled by this migration.

CREATE TYPE "ScanDispatchCommandType" AS ENUM (
  'PREPARE', 'START_PAID', 'START_UNMETERED', 'STOP', 'RECONCILE'
);
CREATE TYPE "ScanDispatchOperationState" AS ENUM (
  'QUEUED', 'WAITING_CAPACITY', 'PREPARING', 'PREPARED', 'START_PENDING',
  'ACTIVE', 'STOPPING', 'TERMINATED', 'REJECTED', 'UNKNOWN'
);
CREATE TYPE "ScanQueueOutboxState" AS ENUM ('PENDING', 'LEASED', 'PUBLISHED', 'UNKNOWN');
CREATE TYPE "ScanDispatchOutboxStatus" AS ENUM (
  'PENDING', 'LEASED', 'DELIVERED', 'ACCEPTED', 'COMPLETED', 'REJECTED', 'UNKNOWN'
);
CREATE TYPE "ScanDispatchStartKind" AS ENUM ('PAID', 'UNMETERED');
CREATE TYPE "ScanSupervisorReceiptType" AS ENUM (
  'COMMAND_ACCEPTED', 'PREPARE_COMPLETED', 'EXECUTOR_CREATE_INTENT',
  'EXECUTOR_STARTED', 'EXECUTOR_EXITED', 'STOPPED', 'NEVER_DISPATCHED', 'UNKNOWN'
);
CREATE TYPE "ScanPhysicalExecutionState" AS ENUM (
  'RESERVED', 'PREPARING', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING',
  'STOPPED', 'NEVER_DISPATCHED', 'UNKNOWN'
);

CREATE TABLE "ScanAuthorityEpoch" (
  "id" TEXT NOT NULL,
  "epoch" INTEGER NOT NULL,
  "isOpen" BOOLEAN NOT NULL DEFAULT false,
  "openKey" TEXT,
  "openedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanAuthorityEpoch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanAuthorityEpoch_epoch_positive_check" CHECK ("epoch" > 0),
  CONSTRAINT "ScanAuthorityEpoch_closed_shape_check"
    CHECK (
      ("isOpen" AND "openedAt" IS NOT NULL AND "closedAt" IS NULL) OR
      (NOT "isOpen" AND "closedAt" IS NOT NULL AND
        ("openedAt" IS NULL OR "closedAt" >= "openedAt"))
    )
);
CREATE UNIQUE INDEX "ScanAuthorityEpoch_epoch_key" ON "ScanAuthorityEpoch"("epoch");
CREATE UNIQUE INDEX "ScanAuthorityEpoch_openKey_key" ON "ScanAuthorityEpoch"("openKey");

-- The baseline is deliberately closed. Admission stays disabled until a
-- separately reviewed authority broker opens a new, higher epoch.
INSERT INTO "ScanAuthorityEpoch"
  ("id", "epoch", "isOpen", "openKey", "openedAt", "closedAt", "createdAt", "updatedAt")
VALUES
  ('scan-authority-baseline', 1, false, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE FUNCTION app.scan_authority_epoch_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_max INTEGER;
BEGIN
  SELECT max("epoch") INTO current_max FROM "ScanAuthorityEpoch";
  IF current_max IS NOT NULL AND NEW."epoch" <= current_max THEN
    RAISE EXCEPTION 'authority epoch must increase monotonically' USING ERRCODE = '23514';
  END IF;
  IF NEW."isOpen" AND NEW."openKey" IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'open authority epoch requires open key' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW."isOpen" AND NEW."openKey" IS NOT NULL THEN
    RAISE EXCEPTION 'closed authority epoch cannot retain open key' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_authority_epoch_monotonic
BEFORE INSERT ON "ScanAuthorityEpoch"
FOR EACH ROW EXECUTE FUNCTION app.scan_authority_epoch_monotonic();

CREATE FUNCTION app.scan_authority_epoch_closed_default() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."epoch" <> OLD."epoch"
     OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (NEW."isOpen" AND NEW."openKey" IS DISTINCT FROM 'open')
     OR (NOT NEW."isOpen" AND NEW."openKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'authority epoch identity cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
    RAISE EXCEPTION 'authority epoch close is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT OLD."isOpen" AND NEW."isOpen" THEN
    RAISE EXCEPTION 'a closed authority epoch cannot be reopened' USING ERRCODE = '23514';
  END IF;
  IF OLD."isOpen" AND NOT NEW."isOpen" AND NEW."closedAt" IS NULL THEN
    RAISE EXCEPTION 'closing an authority epoch requires a closed timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_authority_epoch_closed_default
BEFORE UPDATE ON "ScanAuthorityEpoch"
FOR EACH ROW EXECUTE FUNCTION app.scan_authority_epoch_closed_default();

CREATE FUNCTION app.reject_scan_authority_epoch_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authority epoch history is retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_authority_epoch_retained
BEFORE DELETE ON "ScanAuthorityEpoch"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_authority_epoch_delete();

CREATE TABLE "ScanWorkerInstanceGrant" (
  "id" TEXT NOT NULL,
  "authorityEpochId" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "credentialHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanWorkerInstanceGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanWorkerInstanceGrant_credential_hash_check"
    CHECK ("credentialHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ScanWorkerInstanceGrant_expiry_check" CHECK ("expiresAt" > "issuedAt"),
  CONSTRAINT "ScanWorkerInstanceGrant_revocation_check"
    CHECK ("revokedAt" IS NULL OR "revokedAt" >= "issuedAt")
);
CREATE UNIQUE INDEX "ScanWorkerInstanceGrant_instanceId_key" ON "ScanWorkerInstanceGrant"("instanceId");
CREATE UNIQUE INDEX "ScanWorkerInstanceGrant_credentialHash_key" ON "ScanWorkerInstanceGrant"("credentialHash");
CREATE INDEX "ScanWorkerInstanceGrant_authorityEpochId_idx" ON "ScanWorkerInstanceGrant"("authorityEpochId");
CREATE INDEX "ScanWorkerInstanceGrant_expiresAt_idx" ON "ScanWorkerInstanceGrant"("expiresAt");
CREATE INDEX "ScanWorkerInstanceGrant_revokedAt_idx" ON "ScanWorkerInstanceGrant"("revokedAt");

ALTER TABLE "ScanWorkerInstanceGrant"
  ADD CONSTRAINT "ScanWorkerInstanceGrant_authorityEpochId_fkey"
  FOREIGN KEY ("authorityEpochId") REFERENCES "ScanAuthorityEpoch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_attachment_ids_valid(ids TEXT[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT cardinality(ids) <= 100
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ids) AS value
      WHERE value IS NULL OR length(value) NOT BETWEEN 1 AND 256
    )
$$;

CREATE TABLE "ScanDispatchAttempt" (
  "operationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "initiatingUserId" TEXT NOT NULL,
  "sponsorAccountId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetSnapshotDigest" TEXT NOT NULL,
  "executionPlanHash" TEXT NOT NULL,
  "scopeDigest" TEXT NOT NULL,
  "policyId" TEXT,
  "policyVersion" TEXT NOT NULL,
  "policyDigest" TEXT NOT NULL,
  "delegatedAuthorizationVersion" INTEGER,
  "attachmentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "focusDigest" TEXT,
  "mode" "ScanMode" NOT NULL,
  "goal" "ScanGoal" NOT NULL,
  "maxBudgetUsd" DECIMAL(19,4) NOT NULL,
  "maxRuntimeMs" INTEGER NOT NULL,
  "authorityEpochId" TEXT NOT NULL,
  "workerInstanceGrantId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanDispatchAttempt_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "ScanDispatchAttempt_digest_check"
    CHECK (
      "targetSnapshotDigest" ~ '^[a-f0-9]{64}$' AND
      "executionPlanHash" ~ '^[a-f0-9]{64}$' AND
      "scopeDigest" ~ '^[a-f0-9]{64}$' AND
      "policyDigest" ~ '^[a-f0-9]{64}$' AND
      ("focusDigest" IS NULL OR "focusDigest" ~ '^[a-f0-9]{64}$')
    ),
  CONSTRAINT "ScanDispatchAttempt_policy_check"
    CHECK (length("policyVersion") BETWEEN 1 AND 128),
  CONSTRAINT "ScanDispatchAttempt_attachment_ids_check"
    CHECK (app.scan_attachment_ids_valid("attachmentIds")),
  CONSTRAINT "ScanDispatchAttempt_delegation_check"
    CHECK ("delegatedAuthorizationVersion" IS NULL OR "delegatedAuthorizationVersion" > 0),
  CONSTRAINT "ScanDispatchAttempt_limits_check"
    CHECK ("maxBudgetUsd" >= 0 AND "maxRuntimeMs" > 0 AND "expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "ScanDispatchAttempt_attemptId_key" ON "ScanDispatchAttempt"("attemptId");
CREATE UNIQUE INDEX "ScanDispatchAttempt_attemptId_scanId_key" ON "ScanDispatchAttempt"("attemptId", "scanId");
CREATE UNIQUE INDEX "ScanDispatchAttempt_operationId_attemptId_key" ON "ScanDispatchAttempt"("operationId", "attemptId");
CREATE INDEX "ScanDispatchAttempt_scanId_idx" ON "ScanDispatchAttempt"("scanId");
CREATE INDEX "ScanDispatchAttempt_workspaceId_idx" ON "ScanDispatchAttempt"("workspaceId");
CREATE INDEX "ScanDispatchAttempt_policyId_idx" ON "ScanDispatchAttempt"("policyId");
CREATE INDEX "ScanDispatchAttempt_sponsorAccountId_idx" ON "ScanDispatchAttempt"("sponsorAccountId");
CREATE INDEX "ScanDispatchAttempt_authorityEpochId_idx" ON "ScanDispatchAttempt"("authorityEpochId");
CREATE INDEX "ScanDispatchAttempt_workerInstanceGrantId_idx" ON "ScanDispatchAttempt"("workerInstanceGrantId");
CREATE INDEX "ScanDispatchAttempt_expiresAt_idx" ON "ScanDispatchAttempt"("expiresAt");

ALTER TABLE "ScanDispatchAttempt"
  ADD CONSTRAINT "ScanDispatchAttempt_authorityEpochId_fkey"
  FOREIGN KEY ("authorityEpochId") REFERENCES "ScanAuthorityEpoch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanDispatchAttempt"
  ADD CONSTRAINT "ScanDispatchAttempt_workerInstanceGrantId_fkey"
  FOREIGN KEY ("workerInstanceGrantId") REFERENCES "ScanWorkerInstanceGrant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.reject_scan_dispatch_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scan dispatch attempt is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_dispatch_attempt_immutable
BEFORE UPDATE OR DELETE ON "ScanDispatchAttempt"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_dispatch_attempt_mutation();

CREATE TABLE "ScanDispatchOutbox" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "commandType" "ScanDispatchCommandType" NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1,
  "commandDigest" TEXT NOT NULL,
  "status" "ScanDispatchOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanDispatchOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanDispatchOutbox_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "ScanDispatchOutbox_digest_check" CHECK ("commandDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ScanDispatchOutbox_attempts_check" CHECK ("attempts" BETWEEN 0 AND 1000)
);
CREATE UNIQUE INDEX "ScanDispatchOutbox_operationId_commandType_key"
  ON "ScanDispatchOutbox"("operationId", "commandType");
CREATE INDEX "ScanDispatchOutbox_attemptId_idx" ON "ScanDispatchOutbox"("attemptId");
CREATE INDEX "ScanDispatchOutbox_status_availableAt_idx" ON "ScanDispatchOutbox"("status", "availableAt");

ALTER TABLE "ScanDispatchOutbox"
  ADD CONSTRAINT "ScanDispatchOutbox_operationId_attemptId_fkey"
  FOREIGN KEY ("operationId", "attemptId") REFERENCES "ScanDispatchAttempt"("operationId", "attemptId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_dispatch_outbox_command_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."operationId" <> OLD."operationId"
     OR NEW."attemptId" <> OLD."attemptId"
     OR NEW."commandType" <> OLD."commandType"
     OR NEW."commandDigest" <> OLD."commandDigest" THEN
    RAISE EXCEPTION 'scan dispatch command is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_dispatch_outbox_command_immutable
BEFORE UPDATE ON "ScanDispatchOutbox"
FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_outbox_command_immutable();

CREATE FUNCTION app.reject_scan_dispatch_outbox_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scan dispatch outbox is retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_dispatch_outbox_retained
BEFORE DELETE ON "ScanDispatchOutbox"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_dispatch_outbox_delete();

CREATE TABLE "ScanDispatchStart" (
  "startId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "kind" "ScanDispatchStartKind" NOT NULL,
  "maxBudgetUsd" DECIMAL(19,4) NOT NULL,
  "maxRuntimeMs" INTEGER NOT NULL,
  "policyDigest" TEXT NOT NULL,
  "fundingDigest" TEXT NOT NULL,
  "billableClaimEventId" TEXT,
  "providerGrantDigest" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanDispatchStart_pkey" PRIMARY KEY ("startId"),
  CONSTRAINT "ScanDispatchStart_digest_check" CHECK (
    "policyDigest" ~ '^[a-f0-9]{64}$' AND
    "fundingDigest" ~ '^[a-f0-9]{64}$' AND
    ("providerGrantDigest" IS NULL OR "providerGrantDigest" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "ScanDispatchStart_limits_check"
    CHECK ("maxBudgetUsd" >= 0 AND "maxRuntimeMs" > 0),
  CONSTRAINT "ScanDispatchStart_kind_shape_check" CHECK (
    ("kind" = 'PAID' AND "maxBudgetUsd" > 0 AND "billableClaimEventId" IS NOT NULL AND "providerGrantDigest" IS NOT NULL) OR
    ("kind" = 'UNMETERED' AND "maxBudgetUsd" = 0 AND "billableClaimEventId" IS NULL AND "providerGrantDigest" IS NULL)
  )
);
CREATE UNIQUE INDEX "ScanDispatchStart_operationId_key" ON "ScanDispatchStart"("operationId");
CREATE UNIQUE INDEX "ScanDispatchStart_attemptId_key" ON "ScanDispatchStart"("attemptId");
CREATE UNIQUE INDEX "ScanDispatchStart_operationId_attemptId_key"
  ON "ScanDispatchStart"("operationId", "attemptId");

ALTER TABLE "ScanDispatchStart"
  ADD CONSTRAINT "ScanDispatchStart_operationId_attemptId_fkey"
  FOREIGN KEY ("operationId", "attemptId") REFERENCES "ScanDispatchAttempt"("operationId", "attemptId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.reject_scan_dispatch_start_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scan dispatch start decision is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_dispatch_start_immutable
BEFORE UPDATE OR DELETE ON "ScanDispatchStart"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_dispatch_start_mutation();

CREATE TABLE "ScanSupervisorReceipt" (
  "id" TEXT NOT NULL,
  "supervisorInstanceId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "authorityEpochId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "previousReceiptHash" TEXT,
  "receiptHash" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "receiptType" "ScanSupervisorReceiptType" NOT NULL,
  "executorKey" TEXT,
  "outcome" TEXT,
  "evidenceDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanSupervisorReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanSupervisorReceipt_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "ScanSupervisorReceipt_hash_check" CHECK (
    "receiptHash" ~ '^[a-f0-9]{64}$' AND
    ("previousReceiptHash" IS NULL OR "previousReceiptHash" ~ '^[a-f0-9]{64}$') AND
    "evidenceDigest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "ScanSupervisorReceipt_signature_check"
    CHECK (length("signature") BETWEEN 32 AND 1024),
  CONSTRAINT "ScanSupervisorReceipt_executor_check" CHECK (
    ("receiptType" = 'EXECUTOR_CREATE_INTENT' AND "executorKey" IS NOT NULL) OR
    ("receiptType" <> 'EXECUTOR_CREATE_INTENT')
  )
);
CREATE UNIQUE INDEX "ScanSupervisorReceipt_supervisorInstanceId_sequence_key"
  ON "ScanSupervisorReceipt"("supervisorInstanceId", "sequence");
CREATE UNIQUE INDEX "ScanSupervisorReceipt_attemptId_sequence_key"
  ON "ScanSupervisorReceipt"("attemptId", "sequence");
CREATE UNIQUE INDEX "ScanSupervisorReceipt_receiptHash_key"
  ON "ScanSupervisorReceipt"("receiptHash");
CREATE INDEX "ScanSupervisorReceipt_commandId_idx" ON "ScanSupervisorReceipt"("commandId");
CREATE INDEX "ScanSupervisorReceipt_operationId_observedAt_idx"
  ON "ScanSupervisorReceipt"("operationId", "observedAt");
CREATE INDEX "ScanSupervisorReceipt_attemptId_receiptType_idx"
  ON "ScanSupervisorReceipt"("attemptId", "receiptType");

ALTER TABLE "ScanSupervisorReceipt"
  ADD CONSTRAINT "ScanSupervisorReceipt_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES "ScanDispatchOutbox"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanSupervisorReceipt"
  ADD CONSTRAINT "ScanSupervisorReceipt_operationId_attemptId_fkey"
  FOREIGN KEY ("operationId", "attemptId") REFERENCES "ScanDispatchAttempt"("operationId", "attemptId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanSupervisorReceipt"
  ADD CONSTRAINT "ScanSupervisorReceipt_authorityEpochId_fkey"
  FOREIGN KEY ("authorityEpochId") REFERENCES "ScanAuthorityEpoch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_supervisor_receipt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_sequence INTEGER;
  expected_previous TEXT;
  command_operation TEXT;
  command_attempt TEXT;
  command_epoch TEXT;
BEGIN
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
CREATE TRIGGER scan_supervisor_receipt_guard
BEFORE INSERT ON "ScanSupervisorReceipt"
FOR EACH ROW EXECUTE FUNCTION app.scan_supervisor_receipt_guard();

CREATE FUNCTION app.reject_scan_supervisor_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'supervisor receipt history is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_supervisor_receipt_immutable
BEFORE UPDATE OR DELETE ON "ScanSupervisorReceipt"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_supervisor_receipt_mutation();

CREATE TABLE "ScanPhysicalExecution" (
  "attemptId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "authorityEpochId" TEXT NOT NULL,
  "workerInstanceGrantId" TEXT NOT NULL,
  "state" "ScanPhysicalExecutionState" NOT NULL DEFAULT 'RESERVED',
  "unresolvedKey" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastReceiptId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanPhysicalExecution_pkey" PRIMARY KEY ("attemptId"),
  CONSTRAINT "ScanPhysicalExecution_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "ScanPhysicalExecution_scanId_state_idx" ON "ScanPhysicalExecution"("scanId", "state");
CREATE INDEX "ScanPhysicalExecution_workspaceId_state_idx" ON "ScanPhysicalExecution"("workspaceId", "state");
CREATE INDEX "ScanPhysicalExecution_authorityEpochId_idx" ON "ScanPhysicalExecution"("authorityEpochId");
CREATE INDEX "ScanPhysicalExecution_workerInstanceGrantId_idx" ON "ScanPhysicalExecution"("workerInstanceGrantId");
CREATE INDEX "ScanPhysicalExecution_revision_idx" ON "ScanPhysicalExecution"("revision");
CREATE UNIQUE INDEX "ScanPhysicalExecution_attemptId_scanId_key"
  ON "ScanPhysicalExecution"("attemptId", "scanId");
CREATE UNIQUE INDEX "ScanPhysicalExecution_attemptId_operationId_key"
  ON "ScanPhysicalExecution"("attemptId", "operationId");

-- UNKNOWN remains unresolved and therefore retains the scan quarantine. The
-- nullable key is populated for unresolved states and cleared only on a
-- terminal transition, independent of mutable Scan status or permit expiry.
CREATE UNIQUE INDEX "ScanPhysicalExecution_unresolvedKey_key"
  ON "ScanPhysicalExecution"("unresolvedKey");
CREATE UNIQUE INDEX "ScanPhysicalExecution_lastReceiptId_key"
  ON "ScanPhysicalExecution"("lastReceiptId");

ALTER TABLE "ScanPhysicalExecution"
  ADD CONSTRAINT "ScanPhysicalExecution_attemptId_scanId_fkey"
  FOREIGN KEY ("attemptId", "scanId") REFERENCES "ScanDispatchAttempt"("attemptId", "scanId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanPhysicalExecution"
  ADD CONSTRAINT "ScanPhysicalExecution_authorityEpochId_fkey"
  FOREIGN KEY ("authorityEpochId") REFERENCES "ScanAuthorityEpoch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanPhysicalExecution"
  ADD CONSTRAINT "ScanPhysicalExecution_workerInstanceGrantId_fkey"
  FOREIGN KEY ("workerInstanceGrantId") REFERENCES "ScanWorkerInstanceGrant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanPhysicalExecution"
  ADD CONSTRAINT "ScanPhysicalExecution_lastReceiptId_fkey"
  FOREIGN KEY ("lastReceiptId") REFERENCES "ScanSupervisorReceipt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_physical_execution_immutable_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."operationId" <> OLD."operationId"
     OR NEW."scanId" <> OLD."scanId"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."authorityEpochId" <> OLD."authorityEpochId"
     OR NEW."workerInstanceGrantId" <> OLD."workerInstanceGrantId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'physical execution identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."unresolvedKey" IS DISTINCT FROM (
    CASE WHEN NEW."state" IN ('RESERVED', 'PREPARING', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING', 'UNKNOWN')
      THEN NEW."scanId" ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'physical execution quarantine key is inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'physical execution revision cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW."lastReceiptId" IS DISTINCT FROM OLD."lastReceiptId"
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'physical evidence changes require a transition' USING ERRCODE = '23514';
  END IF;
  IF (NEW."state" <> OLD."state" OR NEW."revision" <> OLD."revision")
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'physical execution state changes require a transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_physical_execution_immutable_state
BEFORE UPDATE ON "ScanPhysicalExecution"
FOR EACH ROW EXECUTE FUNCTION app.scan_physical_execution_immutable_state();

CREATE FUNCTION app.reject_scan_physical_execution_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'physical execution evidence is retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_physical_execution_retained
BEFORE DELETE ON "ScanPhysicalExecution"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_physical_execution_delete();

CREATE TABLE "ScanPhysicalExecutionTransition" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "fromState" "ScanPhysicalExecutionState" NOT NULL,
  "toState" "ScanPhysicalExecutionState" NOT NULL,
  "supervisorReceiptId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanPhysicalExecutionTransition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanPhysicalExecutionTransition_revision_check" CHECK ("revision" > 1),
  CONSTRAINT "ScanPhysicalExecutionTransition_state_change_check" CHECK ("fromState" <> "toState"),
  CONSTRAINT "ScanPhysicalExecutionTransition_receipt_check"
    CHECK (length("supervisorReceiptId") > 0)
);
CREATE UNIQUE INDEX "ScanPhysicalExecutionTransition_attemptId_revision_key"
  ON "ScanPhysicalExecutionTransition"("attemptId", "revision");
CREATE UNIQUE INDEX "ScanPhysicalExecutionTransition_attemptId_supervisorReceipt_key"
  ON "ScanPhysicalExecutionTransition"("attemptId", "supervisorReceiptId");
CREATE INDEX "ScanPhysicalExecutionTransition_operationId_revision_idx"
  ON "ScanPhysicalExecutionTransition"("operationId", "revision");
CREATE INDEX "ScanPhysicalExecutionTransition_toState_createdAt_idx"
  ON "ScanPhysicalExecutionTransition"("toState", "createdAt");

ALTER TABLE "ScanPhysicalExecutionTransition"
  ADD CONSTRAINT "ScanPhysicalExecutionTransition_attemptId_operationId_fkey"
  FOREIGN KEY ("attemptId", "operationId") REFERENCES "ScanPhysicalExecution"("attemptId", "operationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanPhysicalExecutionTransition"
  ADD CONSTRAINT "ScanPhysicalExecutionTransition_supervisorReceiptId_fkey"
  FOREIGN KEY ("supervisorReceiptId") REFERENCES "ScanSupervisorReceipt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_physical_execution_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision INTEGER;
  current_state "ScanPhysicalExecutionState";
  current_scan_id TEXT;
  receipt_type "ScanSupervisorReceiptType";
  receipt_operation_id TEXT;
  receipt_attempt_id TEXT;
  receipt_epoch_id TEXT;
  receipt_command_type "ScanDispatchCommandType";
BEGIN
  SELECT "revision", "state", "scanId" INTO current_revision, current_state, current_scan_id
  FROM "ScanPhysicalExecution" WHERE "attemptId" = NEW."attemptId" FOR UPDATE;
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'physical execution does not exist' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" <> current_revision + 1 THEN
    RAISE EXCEPTION 'physical revision must increase by exactly one' USING ERRCODE = '23514';
  END IF;
  IF NEW."fromState" <> current_state THEN
    RAISE EXCEPTION 'transition source does not match current physical state' USING ERRCODE = '23514';
  END IF;
  IF current_state IN ('STOPPED', 'NEVER_DISPATCHED') THEN
    RAISE EXCEPTION 'terminal physical execution cannot transition' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (current_state = 'RESERVED' AND NEW."toState" IN ('PREPARING', 'STOP_REQUESTED', 'NEVER_DISPATCHED', 'UNKNOWN')) OR
    (current_state = 'PREPARING' AND NEW."toState" IN ('DISPATCH_PENDING', 'STOP_REQUESTED', 'STOPPED', 'NEVER_DISPATCHED', 'UNKNOWN')) OR
    (current_state = 'DISPATCH_PENDING' AND NEW."toState" IN ('ACTIVE', 'STOP_REQUESTED', 'UNKNOWN')) OR
    (current_state = 'ACTIVE' AND NEW."toState" IN ('CLEANUP_PENDING', 'STOP_REQUESTED', 'UNKNOWN')) OR
    (current_state = 'STOP_REQUESTED' AND NEW."toState" IN ('CLEANUP_PENDING', 'STOPPED', 'NEVER_DISPATCHED', 'UNKNOWN')) OR
    (current_state = 'CLEANUP_PENDING' AND NEW."toState" IN ('STOPPED', 'UNKNOWN')) OR
    (current_state = 'UNKNOWN' AND NEW."toState" IN ('STOPPED', 'NEVER_DISPATCHED'))
  ) THEN
    RAISE EXCEPTION 'physical transition is not permitted' USING ERRCODE = '23514';
  END IF;

  SELECT r."receiptType", r."operationId", r."attemptId", r."authorityEpochId", o."commandType"
    INTO receipt_type, receipt_operation_id, receipt_attempt_id, receipt_epoch_id, receipt_command_type
  FROM "ScanSupervisorReceipt" r
  JOIN "ScanDispatchOutbox" o ON o."id" = r."commandId"
  WHERE r."id" = NEW."supervisorReceiptId";
  IF receipt_type IS NULL THEN
    RAISE EXCEPTION 'physical transition requires an authenticated supervisor receipt' USING ERRCODE = '23514';
  END IF;
  IF receipt_operation_id <> NEW."operationId" OR receipt_attempt_id <> NEW."attemptId" THEN
    RAISE EXCEPTION 'physical transition receipt contradicts its attempt' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ScanPhysicalExecution"
    WHERE "attemptId" = NEW."attemptId" AND "authorityEpochId" = receipt_epoch_id
  ) THEN
    RAISE EXCEPTION 'physical transition receipt contradicts its authority epoch' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (NEW."toState" = 'PREPARING' AND receipt_type = 'COMMAND_ACCEPTED' AND receipt_command_type = 'PREPARE') OR
    (NEW."toState" = 'DISPATCH_PENDING' AND receipt_type = 'EXECUTOR_CREATE_INTENT' AND receipt_command_type IN ('START_PAID', 'START_UNMETERED')) OR
    (NEW."toState" = 'ACTIVE' AND receipt_type = 'EXECUTOR_STARTED' AND receipt_command_type IN ('START_PAID', 'START_UNMETERED')) OR
    (NEW."toState" = 'STOP_REQUESTED' AND receipt_type = 'COMMAND_ACCEPTED' AND receipt_command_type = 'STOP') OR
    (NEW."toState" = 'CLEANUP_PENDING' AND receipt_type IN ('EXECUTOR_EXITED', 'STOPPED')) OR
    (NEW."toState" = 'UNKNOWN' AND receipt_type = 'UNKNOWN') OR
    (NEW."toState" = 'STOPPED' AND receipt_type = 'STOPPED') OR
    (NEW."toState" = 'NEVER_DISPATCHED' AND receipt_type = 'NEVER_DISPATCHED')
  ) THEN
    RAISE EXCEPTION 'physical transition lacks matching supervisor evidence' USING ERRCODE = '23514';
  END IF;

  IF NEW."toState" = 'UNKNOWN' AND receipt_command_type NOT IN ('PREPARE', 'START_PAID', 'START_UNMETERED', 'STOP', 'RECONCILE') THEN
    RAISE EXCEPTION 'physical uncertainty requires a bound command' USING ERRCODE = '23514';
  END IF;

  IF NEW."toState" IN ('STOPPED', 'NEVER_DISPATCHED') THEN
    IF current_state = 'UNKNOWN' AND NOT EXISTS (
      SELECT 1 FROM "ScanDispatchOutbox"
      WHERE "operationId" = NEW."operationId"
        AND "attemptId" = NEW."attemptId"
        AND "commandType" = 'RECONCILE'
        AND "status" = 'COMPLETED'
    ) THEN
      RAISE EXCEPTION 'unknown physical execution reconciliation is unverified' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "ScanDispatchOutbox"
      WHERE "operationId" = NEW."operationId"
        AND "status" IN ('PENDING', 'LEASED', 'DELIVERED', 'ACCEPTED', 'UNKNOWN')
    ) THEN
      RAISE EXCEPTION 'terminal physical release requires every command resolved' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "ScanSupervisorReceipt"
      WHERE "id" = NEW."supervisorReceiptId"
        AND "receiptType" IN ('STOPPED', 'NEVER_DISPATCHED')
        AND "operationId" = NEW."operationId"
        AND "attemptId" = NEW."attemptId"
    ) THEN
      RAISE EXCEPTION 'terminal physical release requires an authenticated supervisor receipt' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ScanDispatchOutbox"
    WHERE "operationId" = NEW."operationId" AND "status" = 'UNKNOWN'
  ) AND NEW."toState" NOT IN ('UNKNOWN', 'STOPPED', 'NEVER_DISPATCHED') THEN
    RAISE EXCEPTION 'unknown command must quarantine physical execution' USING ERRCODE = '23514';
  END IF;

  UPDATE "ScanPhysicalExecution"
  SET "state" = NEW."toState", "revision" = NEW."revision",
      "unresolvedKey" = CASE
        WHEN NEW."toState" IN ('RESERVED', 'PREPARING', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING', 'UNKNOWN')
          THEN current_scan_id ELSE NULL END,
      "lastReceiptId" = NEW."supervisorReceiptId", "updatedAt" = CURRENT_TIMESTAMP
  WHERE "attemptId" = NEW."attemptId";
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_physical_execution_transition_guard
BEFORE INSERT ON "ScanPhysicalExecutionTransition"
FOR EACH ROW EXECUTE FUNCTION app.scan_physical_execution_transition_guard();

CREATE FUNCTION app.reject_scan_physical_execution_transition_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'physical execution journal is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_physical_execution_transition_immutable
BEFORE UPDATE OR DELETE ON "ScanPhysicalExecutionTransition"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_physical_execution_transition_mutation();

CREATE TABLE "ScanDispatchReleaseReceipt" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "authorityEpochId" TEXT NOT NULL,
  "physicalState" "ScanPhysicalExecutionState" NOT NULL,
  "supervisorReceiptId" TEXT NOT NULL,
  "releaseDigest" TEXT NOT NULL,
  "capacityDisposition" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanDispatchReleaseReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanDispatchReleaseReceipt_terminal_check"
    CHECK ("physicalState" IN ('STOPPED', 'NEVER_DISPATCHED')),
  CONSTRAINT "ScanDispatchReleaseReceipt_digest_check"
    CHECK ("releaseDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ScanDispatchReleaseReceipt_disposition_check"
    CHECK ("capacityDisposition" IN ('RELEASED', 'SETTLED', 'REVIEW_REQUIRED'))
);
CREATE UNIQUE INDEX "ScanDispatchReleaseReceipt_operationId_key"
  ON "ScanDispatchReleaseReceipt"("operationId");
CREATE UNIQUE INDEX "ScanDispatchReleaseReceipt_attemptId_key"
  ON "ScanDispatchReleaseReceipt"("attemptId");
CREATE UNIQUE INDEX "ScanDispatchReleaseReceipt_supervisorReceiptId_key"
  ON "ScanDispatchReleaseReceipt"("supervisorReceiptId");
CREATE INDEX "ScanDispatchReleaseReceipt_authorityEpochId_createdAt_idx"
  ON "ScanDispatchReleaseReceipt"("authorityEpochId", "createdAt");

ALTER TABLE "ScanDispatchReleaseReceipt"
  ADD CONSTRAINT "ScanDispatchReleaseReceipt_operationId_attemptId_fkey"
  FOREIGN KEY ("operationId", "attemptId") REFERENCES "ScanDispatchAttempt"("operationId", "attemptId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanDispatchReleaseReceipt"
  ADD CONSTRAINT "ScanDispatchReleaseReceipt_authorityEpochId_fkey"
  FOREIGN KEY ("authorityEpochId") REFERENCES "ScanAuthorityEpoch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScanDispatchReleaseReceipt"
  ADD CONSTRAINT "ScanDispatchReleaseReceipt_supervisorReceiptId_fkey"
  FOREIGN KEY ("supervisorReceiptId") REFERENCES "ScanSupervisorReceipt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_dispatch_release_receipt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ScanPhysicalExecution" p
    JOIN "ScanSupervisorReceipt" r ON r."id" = NEW."supervisorReceiptId"
    WHERE p."attemptId" = NEW."attemptId"
      AND p."operationId" = NEW."operationId"
      AND p."state" = NEW."physicalState"
      AND p."lastReceiptId" = NEW."supervisorReceiptId"
      AND r."receiptType" IN ('STOPPED', 'NEVER_DISPATCHED')
      AND r."operationId" = NEW."operationId"
      AND r."attemptId" = NEW."attemptId"
      AND r."authorityEpochId" = NEW."authorityEpochId"
  ) THEN
    RAISE EXCEPTION 'release receipt lacks terminal supervisor evidence' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ScanDispatchOutbox"
    WHERE "operationId" = NEW."operationId"
      AND "status" IN ('PENDING', 'LEASED', 'DELIVERED', 'ACCEPTED', 'UNKNOWN')
  ) THEN
    RAISE EXCEPTION 'release receipt requires every command resolved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_dispatch_release_receipt_guard
BEFORE INSERT ON "ScanDispatchReleaseReceipt"
FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_release_receipt_guard();

CREATE FUNCTION app.reject_scan_dispatch_release_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch release receipt is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_dispatch_release_receipt_immutable
BEFORE UPDATE OR DELETE ON "ScanDispatchReleaseReceipt"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_dispatch_release_receipt_mutation();


CREATE FUNCTION app.scan_worker_grant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ScanAuthorityEpoch"
      WHERE id = NEW."authorityEpochId" AND "isOpen"
    ) THEN
      RAISE EXCEPTION 'worker grants require an open authority epoch' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."authorityEpochId" <> OLD."authorityEpochId"
       OR NEW."instanceId" <> OLD."instanceId"
       OR NEW."credentialHash" <> OLD."credentialHash"
       OR NEW."issuedAt" <> OLD."issuedAt"
       OR NEW."expiresAt" <> OLD."expiresAt"
       OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'worker grant identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
      RAISE EXCEPTION 'worker grant revocation is irreversible' USING ERRCODE = '23514';
    END IF;
    -- The column is TIMESTAMP(3): a statement-time CURRENT_TIMESTAMP can round
    -- ahead of clock_timestamp() by up to half a millisecond at trigger time.
    IF NEW."revokedAt" IS NOT NULL
       AND NEW."revokedAt" > clock_timestamp() + interval '1 millisecond' THEN
      RAISE EXCEPTION 'worker grant revocation cannot be future-dated' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_worker_grant_guard
BEFORE INSERT OR UPDATE ON "ScanWorkerInstanceGrant"
FOR EACH ROW EXECUTE FUNCTION app.scan_worker_grant_guard();

CREATE FUNCTION app.reject_scan_worker_grant_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'worker grant history is retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_worker_grant_retained
BEFORE DELETE ON "ScanWorkerInstanceGrant"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_worker_grant_delete();

CREATE TABLE "ScanDispatchOperation" (
  "operationId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 3,
  "requestDigest" TEXT NOT NULL,
  "state" "ScanDispatchOperationState" NOT NULL DEFAULT 'QUEUED',
  "terminalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanDispatchOperation_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "ScanDispatchOperation_protocol_check" CHECK ("protocolVersion" = 3),
  CONSTRAINT "ScanDispatchOperation_request_digest_check"
    CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ScanDispatchOperation_terminal_reason_check"
    CHECK ("terminalReason" IS NULL OR length("terminalReason") BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX "ScanDispatchOperation_scanId_key" ON "ScanDispatchOperation"("scanId");
CREATE INDEX "ScanDispatchOperation_workspaceId_state_idx"
  ON "ScanDispatchOperation"("workspaceId", "state");
CREATE INDEX "ScanDispatchOperation_state_updatedAt_idx"
  ON "ScanDispatchOperation"("state", "updatedAt");

CREATE FUNCTION app.scan_dispatch_operation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Scan" s
      JOIN "Workspace" w ON w.id = s."workspaceId"
      WHERE s.id = NEW."scanId"
        AND s."workspaceId" = NEW."workspaceId"
        AND s."deletedAt" IS NULL
        AND w."deletedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'dispatch operation contradicts its live scan' USING ERRCODE = '23514';
    END IF;
    IF NEW."state" <> 'QUEUED' THEN
      RAISE EXCEPTION 'dispatch operation must begin queued' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."scanId" <> OLD."scanId"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."protocolVersion" <> OLD."protocolVersion"
     OR NEW."requestDigest" <> OLD."requestDigest"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'dispatch operation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."state" IN ('TERMINATED', 'REJECTED') AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'terminal dispatch operation cannot transition' USING ERRCODE = '23514';
  END IF;
  IF OLD."state" = 'UNKNOWN' AND NEW."state" NOT IN ('UNKNOWN', 'TERMINATED') THEN
    RAISE EXCEPTION 'UNKNOWN dispatch operation is sticky' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" <> OLD."state" AND NOT (
    (OLD."state" = 'QUEUED' AND NEW."state" IN ('WAITING_CAPACITY', 'PREPARING', 'REJECTED', 'UNKNOWN')) OR
    (OLD."state" = 'WAITING_CAPACITY' AND NEW."state" IN ('PREPARING', 'REJECTED', 'UNKNOWN')) OR
    (OLD."state" = 'PREPARING' AND NEW."state" IN ('PREPARED', 'STOPPING', 'UNKNOWN')) OR
    (OLD."state" = 'PREPARED' AND NEW."state" IN ('START_PENDING', 'STOPPING', 'UNKNOWN')) OR
    (OLD."state" = 'START_PENDING' AND NEW."state" IN ('ACTIVE', 'STOPPING', 'TERMINATED', 'UNKNOWN')) OR
    (OLD."state" = 'ACTIVE' AND NEW."state" IN ('STOPPING', 'TERMINATED', 'UNKNOWN')) OR
    (OLD."state" = 'STOPPING' AND NEW."state" IN ('TERMINATED', 'UNKNOWN')) OR
    (OLD."state" = 'UNKNOWN' AND NEW."state" = 'TERMINATED')
  ) THEN
    RAISE EXCEPTION 'invalid dispatch operation transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" IN ('TERMINATED', 'REJECTED') AND NEW."terminalReason" IS NULL THEN
    RAISE EXCEPTION 'terminal dispatch operation requires a reason' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_dispatch_operation_guard
BEFORE INSERT OR UPDATE ON "ScanDispatchOperation"
FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_operation_guard();

CREATE FUNCTION app.reject_scan_dispatch_operation_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch operation history is retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_dispatch_operation_retained
BEFORE DELETE ON "ScanDispatchOperation"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_dispatch_operation_delete();

CREATE TABLE "ScanQueueOutbox" (
  "id" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "state" "ScanQueueOutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanQueueOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanQueueOutbox_identity_check" CHECK ("jobId" = "scanId"),
  CONSTRAINT "ScanQueueOutbox_payload_digest_check"
    CHECK ("payloadDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ScanQueueOutbox_attempts_check" CHECK ("attempts" BETWEEN 0 AND 1000)
);
CREATE UNIQUE INDEX "ScanQueueOutbox_scanId_key" ON "ScanQueueOutbox"("scanId");
CREATE UNIQUE INDEX "ScanQueueOutbox_operationId_key" ON "ScanQueueOutbox"("operationId");
CREATE UNIQUE INDEX "ScanQueueOutbox_jobId_key" ON "ScanQueueOutbox"("jobId");
CREATE INDEX "ScanQueueOutbox_state_leaseExpiresAt_idx"
  ON "ScanQueueOutbox"("state", "leaseExpiresAt");

CREATE FUNCTION app.scan_queue_outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ScanDispatchOperation" o
      WHERE o."operationId" = NEW."operationId"
        AND o."scanId" = NEW."scanId"
    ) THEN
      RAISE EXCEPTION 'queue outbox contradicts its dispatch operation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."scanId" <> OLD."scanId"
     OR NEW."operationId" <> OLD."operationId"
     OR NEW."jobId" <> OLD."jobId"
     OR NEW."payloadDigest" <> OLD."payloadDigest"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'queue outbox identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'queue outbox attempt count cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" <> OLD."state" AND NOT (
    (OLD."state" = 'PENDING' AND NEW."state" IN ('LEASED', 'PUBLISHED', 'UNKNOWN')) OR
    (OLD."state" = 'LEASED' AND NEW."state" IN ('PENDING', 'PUBLISHED', 'UNKNOWN')) OR
    (OLD."state" = 'UNKNOWN' AND NEW."state" = 'PUBLISHED')
  ) THEN
    RAISE EXCEPTION 'invalid queue outbox transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" = 'PUBLISHED' AND NEW."publishedAt" IS NULL THEN
    RAISE EXCEPTION 'published queue outbox requires a timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_queue_outbox_guard
BEFORE INSERT OR UPDATE ON "ScanQueueOutbox"
FOR EACH ROW EXECUTE FUNCTION app.scan_queue_outbox_guard();

CREATE FUNCTION app.reject_scan_queue_outbox_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'queue outbox history is retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scan_queue_outbox_retained
BEFORE DELETE ON "ScanQueueOutbox"
FOR EACH ROW EXECUTE FUNCTION app.reject_scan_queue_outbox_delete();

ALTER TABLE "ScanDispatchAttempt"
  ADD CONSTRAINT "ScanDispatchAttempt_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "ScanDispatchOperation"("operationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_target_snapshot_digest(target_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'schemaVersion', 'scan-target-snapshot/1',
    'targetId', t."id",
    'type', t."type"::text,
    'name', coalesce(t."name", ''),
    'url', coalesce(t."url", ''),
    'repoProvider', coalesce(t."repoProvider", ''),
    'repoFullName', coalesce(t."repoFullName", ''),
    'branch', coalesce(t."branch", ''),
    'apiSpecUrl', coalesce(t."apiSpecUrl", ''),
    'environment', t."environment"::text,
    'installationId', coalesce(t."installationId", ''),
    'updatedAtMs', (extract(epoch FROM t."updatedAt") * 1000)::bigint
  )::text, 'UTF8'), 'sha256'), 'hex')
  FROM "Target" t
  WHERE t."id" = target_id AND t."deletedAt" IS NULL
$$;

CREATE FUNCTION app.scan_policy_digest(policy_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(digest(convert_to(
    CASE WHEN p."id" IS NULL THEN '{"schemaVersion":"scan-policy/none"}'::jsonb::text
    ELSE jsonb_build_object(
      'schemaVersion', 'scan-policy/1',
      'policyId', p."id",
      'name', p."name",
      'maxBudgetUsd', coalesce(p."maxBudgetUsd"::text, ''),
      'maxDurationMinutes', p."maxDurationMinutes",
      'networkEgressPolicy', p."networkEgressPolicy",
      'updatedAtMs', (extract(epoch FROM p."updatedAt") * 1000)::bigint
    )::text END, 'UTF8'), 'sha256'), 'hex')
  FROM (SELECT 1) seed
  LEFT JOIN "Policy" p ON p."id" = policy_id AND p."deletedAt" IS NULL
$$;

CREATE FUNCTION app.scan_dispatch_scope_digest(scan_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'schemaVersion', 'scan-dispatch-scope/1',
    'scanId', s."id",
    'workspaceId', s."workspaceId",
    'initiatingUserId', s."createdById",
    'sponsorAccountId', coalesce(s."sponsorAccountId", s."createdById"),
    'targetId', s."targetId",
    'targetSnapshotDigest', app.scan_target_snapshot_digest(s."targetId"),
    'executionPlanHash', s."executionPlanHash",
    'policyId', coalesce(s."policyId", ''),
    'policyDigest', app.scan_policy_digest(s."policyId"),
    'delegatedAuthorizationVersion', s."delegatedAuthorizationVersion",
    'attachmentIds', coalesce(s."executionPlan"->'attachmentIds', '[]'::jsonb),
    'mode', s."mode"::text,
    'goal', s."goal"::text,
    'maxBudgetUsd', (s."executionPlan" #>> '{limits,maxBudgetUsd}')::numeric::text,
    'maxRuntimeMs', (s."executionPlan" #>> '{limits,maxDurationMs}')::integer
  )::text, 'UTF8'), 'sha256'), 'hex')
  FROM "Scan" s
  WHERE s."id" = scan_id AND s."deletedAt" IS NULL
$$;

CREATE FUNCTION app.scan_dispatch_attempt_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_scope TEXT;
  expected_target TEXT;
  expected_policy TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ScanAuthorityEpoch"
    WHERE id = NEW."authorityEpochId" AND "isOpen"
  ) THEN
    RAISE EXCEPTION 'attempt requires an open authority epoch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ScanWorkerInstanceGrant"
    WHERE id = NEW."workerInstanceGrantId"
      AND "authorityEpochId" = NEW."authorityEpochId"
      AND "issuedAt" <= NEW."createdAt"
      AND "expiresAt" > NEW."createdAt"
      AND "revokedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'attempt requires a live worker grant in its epoch' USING ERRCODE = '23514';
  END IF;
  IF NEW."expiresAt" > (
    SELECT "expiresAt" FROM "ScanWorkerInstanceGrant"
    WHERE id = NEW."workerInstanceGrantId"
  ) THEN
    RAISE EXCEPTION 'attempt expiry exceeds worker grant' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ScanDispatchOperation" o
    WHERE o."operationId" = NEW."operationId"
      AND o."scanId" = NEW."scanId"
      AND o."workspaceId" = NEW."workspaceId"
      AND o."state" IN ('QUEUED', 'WAITING_CAPACITY', 'PREPARING')
  ) THEN
    RAISE EXCEPTION 'attempt requires its matching dispatch operation' USING ERRCODE = '23514';
  END IF;

  expected_scope := app.scan_dispatch_scope_digest(NEW."scanId");
  expected_target := app.scan_target_snapshot_digest(NEW."targetId");
  expected_policy := app.scan_policy_digest(NEW."policyId");
  IF NEW."scopeDigest" <> expected_scope
     OR NEW."targetSnapshotDigest" <> expected_target
     OR NEW."policyDigest" <> expected_policy
     OR NOT EXISTS (
       SELECT 1 FROM "ScanDispatchOperation"
       WHERE "operationId" = NEW."operationId" AND "requestDigest" = expected_scope
     ) THEN
    RAISE EXCEPTION 'attempt scope digest contradicts admitted authority' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Scan" s
    JOIN "Workspace" w ON w.id = s."workspaceId"
    JOIN "Target" t ON t.id = s."targetId" AND t."workspaceId" = s."workspaceId"
    JOIN "users" u ON u.id = s."createdById"
    JOIN "UserScanSlot" slot ON slot."scanId" = s."id"
      AND slot."userId" = s."createdById"
      AND slot."workspaceId" = s."workspaceId"
    JOIN "ScanCapacityReservation" reservation ON reservation."scanId" = s."id"
      AND reservation."userId" = s."createdById"
      AND reservation."workspaceId" = s."workspaceId"
      AND reservation."accountId" = coalesce(s."sponsorAccountId", s."createdById")
    WHERE s.id = NEW."scanId"
      AND s."workspaceId" = NEW."workspaceId"
      AND s."targetId" = NEW."targetId"
      AND s."deletedAt" IS NULL
      AND s."status" IN ('QUEUED', 'PREFLIGHT')
      AND s."accountingVersion" = 2
      AND s."executionPlanHash" = NEW."executionPlanHash"
      AND s."executionPlan" IS NOT NULL
      AND s."policyId" IS NOT DISTINCT FROM NEW."policyId"
      AND s."mode"::text = NEW."mode"::text
      AND s."goal"::text = NEW."goal"::text
      AND s."createdById" = NEW."initiatingUserId"
      AND coalesce(s."sponsorAccountId", s."createdById") = NEW."sponsorAccountId"
      AND s."delegatedAuthorizationVersion" IS NOT DISTINCT FROM NEW."delegatedAuthorizationVersion"
      AND w."deletedAt" IS NULL
      AND t."deletedAt" IS NULL
      AND (s."executionPlan" #>> '{limits,maxBudgetUsd}')::numeric = NEW."maxBudgetUsd"
      AND (s."executionPlan" #>> '{limits,maxDurationMs}')::integer = NEW."maxRuntimeMs"
      AND coalesce(s."executionPlan"->'attachmentIds', '[]'::jsonb) = to_jsonb(NEW."attachmentIds")
      AND reservation."state" IN ('WAITING', 'RESERVED')
  ) THEN
    RAISE EXCEPTION 'attempt contradicts live scan authority rows' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_dispatch_attempt_insert_guard
BEFORE INSERT ON "ScanDispatchAttempt"
FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_attempt_insert_guard();

CREATE FUNCTION app.scan_dispatch_outbox_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  IF NEW."status" = 'UNKNOWN' AND NOT EXISTS (
    SELECT 1
    FROM "ScanPhysicalExecution" p
    JOIN "ScanSupervisorReceipt" r ON r."id" = p."lastReceiptId"
    WHERE p."attemptId" = NEW."attemptId"
      AND p."operationId" = NEW."operationId"
      AND p."state" = 'UNKNOWN'
      AND r."commandId" = NEW."id"
      AND r."receiptType" = 'UNKNOWN'
  ) THEN
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
CREATE TRIGGER scan_dispatch_outbox_status_guard
BEFORE UPDATE ON "ScanDispatchOutbox"
FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_outbox_status_guard();

CREATE FUNCTION app.scan_physical_execution_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" <> 'RESERVED' OR NEW."revision" <> 1 OR NEW."unresolvedKey" <> NEW."scanId" THEN
    RAISE EXCEPTION 'physical execution must begin reserved with its scan quarantine' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ScanDispatchAttempt" a
    WHERE a."attemptId" = NEW."attemptId"
      AND a."operationId" = NEW."operationId"
      AND a."scanId" = NEW."scanId"
      AND a."workspaceId" = NEW."workspaceId"
      AND a."authorityEpochId" = NEW."authorityEpochId"
      AND a."workerInstanceGrantId" = NEW."workerInstanceGrantId"
  ) THEN
    RAISE EXCEPTION 'physical execution identity contradicts its attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_physical_execution_insert_guard
BEFORE INSERT ON "ScanPhysicalExecution"
FOR EACH ROW EXECUTE FUNCTION app.scan_physical_execution_insert_guard();

CREATE FUNCTION app.scan_physical_transition_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ScanPhysicalExecution"
    WHERE "attemptId" = NEW."attemptId" AND "operationId" = NEW."operationId"
  ) THEN
    RAISE EXCEPTION 'transition operation does not match physical execution' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_physical_transition_insert_guard
BEFORE INSERT ON "ScanPhysicalExecutionTransition"
FOR EACH ROW EXECUTE FUNCTION app.scan_physical_transition_insert_guard();


-- No tenant runtime policy is installed. The authority broker and supervisor
-- are future, separately reviewed services; this migration grants them nothing.
ALTER TABLE "ScanAuthorityEpoch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanAuthorityEpoch" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanWorkerInstanceGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanWorkerInstanceGrant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchOperation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanQueueOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanQueueOutbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchAttempt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchOutbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchStart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchStart" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanSupervisorReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanSupervisorReceipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecution" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecutionTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecutionTransition" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchReleaseReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchReleaseReceipt" FORCE ROW LEVEL SECURITY;

DO $dispatch_authority_lockdown$
DECLARE
  role_name TEXT;
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ScanAuthorityEpoch',
    'ScanWorkerInstanceGrant',
    'ScanDispatchOperation',
    'ScanQueueOutbox',
    'ScanDispatchAttempt',
    'ScanDispatchOutbox',
    'ScanDispatchStart',
    'ScanSupervisorReceipt',
    'ScanPhysicalExecution',
    'ScanPhysicalExecutionTransition',
    'ScanDispatchReleaseReceipt'
  ] LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['app_runtime_prod', 'app_system_prod', 'app_runtime_ci'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$dispatch_authority_lockdown$;
