-- Additive durable-dispatch authority foundation. Runtime producers remain
-- unchanged; no broker or supervisor is enabled by this migration.

CREATE TYPE "ScanDispatchCommandType" AS ENUM ('QUEUE_PUBLISH', 'PREPARE', 'START_PAID', 'STOP', 'RECONCILE');
CREATE TYPE "ScanPhysicalExecutionState" AS ENUM (
  'RESERVED', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING',
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
  "policyVersion" TEXT NOT NULL,
  "delegatedAuthorizationVersion" INTEGER,
  "attachmentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
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
    CHECK ("targetSnapshotDigest" ~ '^[a-f0-9]{64}$' AND "executionPlanHash" ~ '^[a-f0-9]{64}$'),
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
  "commandDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScanDispatchOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanDispatchOutbox_digest_check" CHECK ("commandDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ScanDispatchOutbox_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'DELIVERED', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN')),
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
  "lastEvidenceReference" TEXT,
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
    CASE WHEN NEW."state" IN ('RESERVED', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING', 'UNKNOWN')
      THEN NEW."scanId" ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'physical execution quarantine key is inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'physical execution revision cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW."lastEvidenceReference" IS DISTINCT FROM OLD."lastEvidenceReference"
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
  "evidenceReference" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanPhysicalExecutionTransition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanPhysicalExecutionTransition_revision_check" CHECK ("revision" > 1),
  CONSTRAINT "ScanPhysicalExecutionTransition_state_change_check" CHECK ("fromState" <> "toState"),
  CONSTRAINT "ScanPhysicalExecutionTransition_evidence_check"
    CHECK (length("evidenceReference") BETWEEN 1 AND 256)
);
CREATE UNIQUE INDEX "ScanPhysicalExecutionTransition_attemptId_revision_key"
  ON "ScanPhysicalExecutionTransition"("attemptId", "revision");
CREATE INDEX "ScanPhysicalExecutionTransition_operationId_revision_idx"
  ON "ScanPhysicalExecutionTransition"("operationId", "revision");
CREATE INDEX "ScanPhysicalExecutionTransition_toState_createdAt_idx"
  ON "ScanPhysicalExecutionTransition"("toState", "createdAt");

ALTER TABLE "ScanPhysicalExecutionTransition"
  ADD CONSTRAINT "ScanPhysicalExecutionTransition_attemptId_operationId_fkey"
  FOREIGN KEY ("attemptId", "operationId") REFERENCES "ScanPhysicalExecution"("attemptId", "operationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION app.scan_physical_execution_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision INTEGER;
  current_state "ScanPhysicalExecutionState";
  current_scan_id TEXT;
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
    (current_state = 'RESERVED' AND NEW."toState" IN ('DISPATCH_PENDING', 'STOP_REQUESTED', 'UNKNOWN')) OR
    (current_state = 'DISPATCH_PENDING' AND NEW."toState" IN ('ACTIVE', 'STOP_REQUESTED', 'UNKNOWN')) OR
    (current_state = 'ACTIVE' AND NEW."toState" IN ('STOP_REQUESTED', 'CLEANUP_PENDING', 'UNKNOWN')) OR
    (current_state = 'STOP_REQUESTED' AND NEW."toState" IN ('CLEANUP_PENDING', 'STOPPED', 'NEVER_DISPATCHED', 'UNKNOWN')) OR
    (current_state = 'CLEANUP_PENDING' AND NEW."toState" IN ('STOPPED', 'UNKNOWN')) OR
    (current_state = 'UNKNOWN' AND NEW."toState" IN ('STOPPED', 'NEVER_DISPATCHED'))
  ) THEN
    RAISE EXCEPTION 'physical transition is not permitted' USING ERRCODE = '23514';
  END IF;

  IF NEW."toState" = 'UNKNOWN' THEN
    IF NEW."evidenceReference" !~ '^[a-f0-9]{64}$' OR NOT EXISTS (
      SELECT 1 FROM "ScanDispatchOutbox"
      WHERE "operationId" = NEW."operationId"
        AND "attemptId" = NEW."attemptId"
        AND "commandDigest" = NEW."evidenceReference"
        AND "status" IN ('PROCESSING', 'DELIVERED', 'UNKNOWN')
    ) THEN
      RAISE EXCEPTION 'physical uncertainty requires a bound command' USING ERRCODE = '23514';
    END IF;
  ELSIF current_state = 'UNKNOWN' THEN
    IF NEW."evidenceReference" !~ '^[a-f0-9]{64}$' OR NOT EXISTS (
      SELECT 1 FROM "ScanDispatchOutbox"
      WHERE "operationId" = NEW."operationId"
        AND "attemptId" = NEW."attemptId"
        AND "commandType" = 'RECONCILE'
        AND "status" = 'ACKNOWLEDGED'
        AND "commandDigest" = NEW."evidenceReference"
    ) THEN
      RAISE EXCEPTION 'unknown physical execution reconciliation is unverified' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."toState" IN ('STOPPED', 'NEVER_DISPATCHED') THEN
    IF NEW."evidenceReference" !~ '^[a-f0-9]{64}$' OR NOT EXISTS (
      SELECT 1 FROM "ScanDispatchOutbox"
      WHERE "operationId" = NEW."operationId"
        AND "attemptId" = NEW."attemptId"
        AND "commandType" = 'STOP'
        AND "status" = 'ACKNOWLEDGED'
        AND "commandDigest" = NEW."evidenceReference"
    ) THEN
      RAISE EXCEPTION 'terminal physical release requires acknowledged supervisor evidence' USING ERRCODE = '23514';
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
        WHEN NEW."toState" IN ('RESERVED', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING', 'UNKNOWN')
          THEN current_scan_id ELSE NULL END,
      "lastEvidenceReference" = NEW."evidenceReference", "updatedAt" = CURRENT_TIMESTAMP
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
    IF NEW."revokedAt" IS NOT NULL AND NEW."revokedAt" > clock_timestamp() THEN
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

CREATE FUNCTION app.scan_dispatch_attempt_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    SELECT 1
    FROM "Scan" s
    JOIN "Workspace" w ON w.id = s."workspaceId"
    JOIN "Target" t ON t.id = s."targetId" AND t."workspaceId" = s."workspaceId"
    JOIN "users" u ON u.id = s."createdById"
    WHERE s.id = NEW."scanId"
      AND s."workspaceId" = NEW."workspaceId"
      AND s."targetId" = NEW."targetId"
      AND s."deletedAt" IS NULL
      AND s."executionPlanHash" = NEW."executionPlanHash"
      AND s."mode"::text = NEW."mode"::text
      AND s."goal"::text = NEW."goal"::text
      AND s."createdById" = NEW."initiatingUserId"
      AND COALESCE(s."sponsorAccountId", s."createdById") = NEW."sponsorAccountId"
      AND s."delegatedAuthorizationVersion" IS NOT DISTINCT FROM NEW."delegatedAuthorizationVersion"
      AND w."deletedAt" IS NULL
      AND t."deletedAt" IS NULL
      AND s."executionPlan" IS NOT NULL
      AND (s."executionPlan" #>> '{limits,maxBudgetUsd}')::numeric = NEW."maxBudgetUsd"
      AND (s."executionPlan" #>> '{limits,maxDurationMs}')::integer = NEW."maxRuntimeMs"
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
  IF NEW."operationId" <> OLD."operationId"
     OR NEW."attemptId" <> OLD."attemptId"
     OR NEW."commandType" <> OLD."commandType"
     OR NEW."commandDigest" <> OLD."commandDigest"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'scan dispatch command is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PROCESSING', 'DELIVERED', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'PROCESSING' AND NEW."status" IN ('DELIVERED', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'DELIVERED' AND NEW."status" IN ('ACKNOWLEDGED', 'REJECTED', 'UNKNOWN')) OR
    (OLD."status" = 'UNKNOWN' AND NEW."status" IN ('ACKNOWLEDGED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid outbox status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'outbox attempt count cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('DELIVERED', 'ACKNOWLEDGED', 'REJECTED')
     AND NEW."deliveredAt" IS NULL THEN
    RAISE EXCEPTION 'delivered or terminal outbox status requires delivery timestamp' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'UNKNOWN' AND NOT EXISTS (
    SELECT 1 FROM "ScanPhysicalExecution" p
    WHERE p."attemptId" = NEW."attemptId"
      AND p."operationId" = NEW."operationId"
      AND p."state" = 'UNKNOWN'
      AND p."lastEvidenceReference" = NEW."commandDigest"
  ) THEN
    RAISE EXCEPTION 'unknown command lacks physical quarantine' USING ERRCODE = '23514';
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
ALTER TABLE "ScanDispatchAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchAttempt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchOutbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecution" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecutionTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanPhysicalExecutionTransition" FORCE ROW LEVEL SECURITY;

DO $dispatch_authority_lockdown$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod') THEN
    REVOKE ALL PRIVILEGES ON TABLE "ScanAuthorityEpoch" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "ScanWorkerInstanceGrant" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "ScanDispatchAttempt" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "ScanDispatchOutbox" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "ScanPhysicalExecution" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "ScanPhysicalExecutionTransition" FROM app_runtime_prod;
  END IF;
END
$dispatch_authority_lockdown$;
