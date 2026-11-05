#!/usr/bin/env bash
# Owns a disposable network-none PostgreSQL fixture; never accepts a DB URL.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$repo_root"
if [[ -n "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]]; then
  echo 'Docker environment overrides are not allowed' >&2; exit 1
fi
context=$(docker context show)
case "$context" in default|desktop-linux) ;; *) echo 'Requires local Docker context' >&2; exit 1;; esac
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
case "$endpoint" in unix:///*) ;; *) echo 'Requires local Unix Docker socket' >&2; exit 1;; esac
image=$(docker image inspect postgres:17-alpine --format '{{.Id}}')
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Local PostgreSQL image required' >&2; exit 1; }
identity=$(openssl rand -hex 24)
admin_password=$(openssl rand -hex 24)
container=''
relay_pid=''
umask 077
dir=$(mktemp -d "${TMPDIR:-/tmp}/lyra-dispatch-authority.XXXXXXXX")
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=lyrashield_test\n' "$admin_password" > "$dir/postgres.env"
cleanup() {
  local status=$? observed
  trap - EXIT
  if [[ -n "$relay_pid" ]]; then : > "$dir/stop-relay"; wait "$relay_pid" 2>/dev/null || true; fi
  if [[ -n "$container" ]]; then
    observed=$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null) || observed=''
    if [[ "$observed" == "$container|$image|$identity|none" ]]; then
      docker rm -f -v "$container" >/dev/null || status=1
    else
      echo 'Refusing to remove unverified fixture container' >&2; status=1
    fi
  fi
  rm -rf "$dir"
  exit "$status"
}
trap cleanup EXIT
container=$(docker create --pull=never --network none --label "lyrashield.dispatch-authority-fixture=$identity" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m --env-file "$dir/postgres.env" "$image")
[[ "$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$container")" == "$container|$image|$identity|none" ]] || exit 1
docker start "$container" >/dev/null
ready=false
for _ in {1..60}; do
  if docker logs "$container" 2>&1 | grep 'PostgreSQL init process complete' >/dev/null && \
    docker exec "$container" pg_isready -U postgres -d lyrashield_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.2
done
if [[ "$ready" != true ]]; then docker logs "$container" >&2 || true; exit 1; fi
python3 "$repo_root/ops/prototypes/dispatch-plan-test/relay.py" "$container" "$dir/port" "$dir/stop-relay" >"$dir/relay.out" 2>"$dir/relay.err" &
relay_pid=$!
for _ in {1..100}; do
  [[ -s "$dir/port" ]] && break
  kill -0 "$relay_pid" 2>/dev/null || { echo 'Fixture relay failed' >&2; exit 1; }
  sleep 0.05
done
port=$(cat "$dir/port")
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'Fixture relay unavailable' >&2; exit 1; }
pnpm db:generate
DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
  pnpm --filter @lyrashield/db exec prisma migrate deploy
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test \
  -c 'CREATE DATABASE lyrashield_authority_shadow' >/dev/null
diff_status=0
DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
SHADOW_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_authority_shadow" \
  pnpm --filter @lyrashield/db exec prisma migrate diff --exit-code \
    --from-migrations prisma/migrations --to-schema prisma/schema.prisma >"$dir/schema.diff" 2>"$dir/schema.diff.err" || diff_status=$?
if [[ "$diff_status" -ne 0 ]]; then
  cat "$dir/schema.diff" "$dir/schema.diff.err" >&2
  exit 1
fi
docker exec -i "$container" psql -X -U postgres -d lyrashield_test -v ON_ERROR_STOP=1 <<'SQL'
-- Closed baseline and monotonic epoch.
DO $test$
DECLARE
  closed_count integer;
BEGIN
  SELECT count(*) INTO closed_count FROM "ScanAuthorityEpoch"
  WHERE NOT "isOpen" AND "closedAt" IS NOT NULL;
  IF closed_count < 1 THEN
    RAISE EXCEPTION 'closed authority baseline missing';
  END IF;

  BEGIN
    INSERT INTO "ScanAuthorityEpoch"
      ("id", "epoch", "isOpen", "openedAt", "closedAt", "createdAt", "updatedAt")
    VALUES
      ('test-lower-epoch', 1, false, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'non-monotonic authority epoch was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE "ScanAuthorityEpoch" SET "isOpen" = true WHERE id = 'scan-authority-baseline';
    RAISE EXCEPTION 'closed authority epoch was reopened';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;

-- No authority can be issued from the closed migration baseline.
DO $test$
BEGIN
  BEGIN
    INSERT INTO "ScanWorkerInstanceGrant"
      ("id", "authorityEpochId", "instanceId", "credentialHash", "issuedAt", "expiresAt", "createdAt", "updatedAt")
    VALUES
      ('closed-worker', 'scan-authority-baseline', 'closed-instance', repeat('0', 64),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'worker grant was issued from a closed epoch';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
INSERT INTO "ScanAuthorityEpoch"
  ("id", "epoch", "isOpen", "openKey", "openedAt", "closedAt", "createdAt", "updatedAt")
VALUES
  ('test-open-epoch', 2, true, 'open', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Live product rows are the source of the attempt identity.
INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt")
VALUES ('user-1', 'Fixture user', 'fixture@example.invalid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Workspace"
  ("id", "name", "slug", "mode", "plan", "deploymentType", "retentionDays",
   "telemetryEnabled", "createdAt", "updatedAt")
VALUES
  ('workspace-1', 'Fixture workspace', 'fixture-workspace', 'VIBE', 'FREE', 'saas', 30,
   false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Target"
  ("id", "workspaceId", "type", "name", "environment", "status", "createdAt", "updatedAt")
VALUES
  ('target-1', 'workspace-1', 'REPO', 'Fixture target', 'STAGING', 'active',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Scan" (
  "id", "workspaceId", "targetId", "goal", "mode", "status", "triggerType",
  "accountingVersion", "determinismMode", "executionPlan", "executionPlanHash",
  "createdById", "sponsorAccountId", "createdAt", "updatedAt"
) VALUES
  ('scan-1', 'workspace-1', 'target-1', 'TEST_APP', 'SAFE', 'QUEUED', 'manual',
   2, 'default', '{"limits":{"maxBudgetUsd":0,"maxDurationMs":60000}}'::jsonb,
   repeat('c', 64), 'user-1', 'user-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('scan-2', 'workspace-1', 'target-1', 'TEST_APP', 'SAFE', 'QUEUED', 'manual',
   2, 'default', '{"limits":{"maxBudgetUsd":0,"maxDurationMs":60000}}'::jsonb,
   repeat('c', 64), 'user-1', 'user-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Hash-only worker instance grant and immutable attempt identity.
INSERT INTO "ScanWorkerInstanceGrant"
  ("id", "authorityEpochId", "instanceId", "credentialHash", "issuedAt", "expiresAt", "createdAt", "updatedAt")
VALUES
  ('worker-grant-1', 'test-open-epoch', 'worker-instance-1',
   repeat('a', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "ScanDispatchAttempt" (
  "operationId", "attemptId", "scanId", "workspaceId", "initiatingUserId", "sponsorAccountId",
  "targetId", "targetSnapshotDigest", "executionPlanHash", "policyVersion",
  "delegatedAuthorizationVersion", "attachmentIds", "mode", "goal", "maxBudgetUsd",
  "maxRuntimeMs", "authorityEpochId", "workerInstanceGrantId", "expiresAt"
) VALUES (
  'operation-1', 'attempt-1', 'scan-1', 'workspace-1', 'user-1', 'user-1',
  'target-1', repeat('b', 64), repeat('c', 64), 'policy-1',
  NULL, ARRAY['attachment-1']::TEXT[], 'SAFE', 'TEST_APP', 0,
  60000, 'test-open-epoch', 'worker-grant-1', CURRENT_TIMESTAMP + interval '10 minutes'
);
DO $test$
BEGIN
  BEGIN
    UPDATE "ScanDispatchAttempt" SET "maxBudgetUsd" = 1 WHERE "operationId" = 'operation-1';
    RAISE EXCEPTION 'attempt identity was mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM "ScanDispatchAttempt" WHERE "operationId" = 'operation-1';
    RAISE EXCEPTION 'attempt deletion was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;

-- One unresolved physical attempt per scan.
INSERT INTO "ScanPhysicalExecution" (
  "attemptId", "operationId", "scanId", "workspaceId", "authorityEpochId",
  "workerInstanceGrantId", "state", "unresolvedKey", "revision", "createdAt", "updatedAt"
) VALUES (
  'attempt-1', 'operation-1', 'scan-1', 'workspace-1', 'test-open-epoch',
  'worker-grant-1', 'RESERVED', 'scan-1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO "ScanDispatchAttempt" (
  "operationId", "attemptId", "scanId", "workspaceId", "initiatingUserId", "sponsorAccountId",
  "targetId", "targetSnapshotDigest", "executionPlanHash", "policyVersion",
  "delegatedAuthorizationVersion", "attachmentIds", "mode", "goal", "maxBudgetUsd",
  "maxRuntimeMs", "authorityEpochId", "workerInstanceGrantId", "expiresAt"
) VALUES (
  'operation-2', 'attempt-2', 'scan-1', 'workspace-1', 'user-1', 'user-1',
  'target-1', repeat('b', 64), repeat('c', 64), 'policy-1',
  NULL, ARRAY[]::TEXT[], 'SAFE', 'TEST_APP', 0,
  60000, 'test-open-epoch', 'worker-grant-1', CURRENT_TIMESTAMP + interval '10 minutes'
);
DO $test$
BEGIN
  BEGIN
    INSERT INTO "ScanPhysicalExecution" (
      "attemptId", "operationId", "scanId", "workspaceId", "authorityEpochId",
      "workerInstanceGrantId", "state", "unresolvedKey", "revision", "createdAt", "updatedAt"
    ) VALUES (
      'attempt-2', 'operation-2', 'scan-1', 'workspace-1', 'test-open-epoch',
      'worker-grant-1', 'RESERVED', 'scan-1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'overlapping unresolved physical attempt was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$test$;

-- Unique operation + command in the digest-only outbox.
INSERT INTO "ScanDispatchOutbox" (
  "id", "operationId", "attemptId", "commandType", "commandDigest", "status", "attempts",
  "availableAt", "createdAt", "updatedAt"
) VALUES (
  'outbox-1', 'operation-1', 'attempt-1', 'PREPARE', repeat('d', 64), 'PENDING', 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
DO $test$
BEGIN
  BEGIN
    INSERT INTO "ScanDispatchOutbox" (
      "id", "operationId", "attemptId", "commandType", "commandDigest", "status", "attempts",
      "availableAt", "createdAt", "updatedAt"
    ) VALUES (
      'outbox-2', 'operation-1', 'attempt-1', 'PREPARE', repeat('d', 64), 'PENDING', 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'duplicate operation command was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$test$;

-- Terminal release and ambiguity cannot bypass bound supervisor evidence.
INSERT INTO "ScanDispatchAttempt" (
  "operationId", "attemptId", "scanId", "workspaceId", "initiatingUserId", "sponsorAccountId",
  "targetId", "targetSnapshotDigest", "executionPlanHash", "policyVersion",
  "delegatedAuthorizationVersion", "attachmentIds", "mode", "goal", "maxBudgetUsd",
  "maxRuntimeMs", "authorityEpochId", "workerInstanceGrantId", "expiresAt"
) VALUES (
  'operation-3', 'attempt-3', 'scan-2', 'workspace-1', 'user-1', 'user-1',
  'target-1', repeat('b', 64), repeat('c', 64), 'policy-1',
  NULL, ARRAY[]::TEXT[], 'SAFE', 'TEST_APP', 0,
  60000, 'test-open-epoch', 'worker-grant-1', CURRENT_TIMESTAMP + interval '10 minutes'
);
INSERT INTO "ScanPhysicalExecution" (
  "attemptId", "operationId", "scanId", "workspaceId", "authorityEpochId",
  "workerInstanceGrantId", "state", "unresolvedKey", "revision", "createdAt", "updatedAt"
) VALUES (
  'attempt-3', 'operation-3', 'scan-2', 'workspace-1', 'test-open-epoch',
  'worker-grant-1', 'RESERVED', 'scan-2', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
DO $test$
BEGIN
  BEGIN
    INSERT INTO "ScanPhysicalExecutionTransition" (
      "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
    ) VALUES (
      'transition-invalid-terminal', 'attempt-3', 'operation-3', 2, 'RESERVED', 'NEVER_DISPATCHED',
      'free-text', CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'unverified terminal transition was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO "ScanPhysicalExecutionTransition" (
    "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
  ) VALUES (
    'transition-stop-request', 'attempt-3', 'operation-3', 2, 'RESERVED', 'STOP_REQUESTED',
    'stop-requested', CURRENT_TIMESTAMP
  );
  BEGIN
    INSERT INTO "ScanPhysicalExecutionTransition" (
      "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
    ) VALUES (
      'transition-unbound-stop', 'attempt-3', 'operation-3', 3, 'STOP_REQUESTED', 'STOPPED',
      repeat('9', 64), CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'terminal transition without stop receipt was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
INSERT INTO "ScanDispatchOutbox" (
  "id", "operationId", "attemptId", "commandType", "commandDigest", "status", "attempts",
  "availableAt", "createdAt", "updatedAt"
) VALUES (
  'outbox-unknown-3', 'operation-3', 'attempt-3', 'PREPARE', repeat('f', 64), 'PROCESSING', 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO "ScanPhysicalExecutionTransition" (
  "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
) VALUES (
  'transition-unknown-2', 'attempt-3', 'operation-3', 3, 'STOP_REQUESTED', 'UNKNOWN',
  repeat('f', 64), CURRENT_TIMESTAMP
);
UPDATE "ScanDispatchOutbox" SET "status" = 'UNKNOWN', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'outbox-unknown-3';
INSERT INTO "ScanDispatchOutbox" (
  "id", "operationId", "attemptId", "commandType", "commandDigest", "status", "attempts",
  "availableAt", "createdAt", "updatedAt"
) VALUES (
  'outbox-stop-3', 'operation-3', 'attempt-3', 'STOP', repeat('8', 64), 'PENDING', 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
DO $test$
BEGIN
  BEGIN
    UPDATE "ScanDispatchOutbox" SET "status" = 'UNKNOWN', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'outbox-stop-3';
    RAISE EXCEPTION 'unknown command without matching physical quarantine was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "ScanPhysicalExecution" SET "lastEvidenceReference" = 'direct-evidence'
    WHERE "attemptId" = 'attempt-3';
    RAISE EXCEPTION 'physical evidence was mutable outside the journal';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "ScanDispatchOutbox" SET "id" = 'outbox-renamed'
    WHERE "id" = 'outbox-stop-3';
    RAISE EXCEPTION 'outbox identity was mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;

-- Monotonic transition revision and verified UNKNOWN reconciliation.
DO $test$
BEGIN
  BEGIN
    INSERT INTO "ScanPhysicalExecutionTransition" (
      "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
    ) VALUES (
      'transition-skip', 'attempt-1', 'operation-1', 4, 'RESERVED', 'ACTIVE', 'evidence-skip', CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'nonconsecutive physical revision was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
INSERT INTO "ScanPhysicalExecutionTransition" (
  "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
) VALUES (
  'transition-dispatch', 'attempt-1', 'operation-1', 2, 'RESERVED', 'DISPATCH_PENDING', repeat('d', 64), CURRENT_TIMESTAMP
);
INSERT INTO "ScanPhysicalExecutionTransition" (
  "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
) VALUES (
  'transition-active', 'attempt-1', 'operation-1', 3, 'DISPATCH_PENDING', 'ACTIVE', repeat('d', 64), CURRENT_TIMESTAMP
);
UPDATE "ScanDispatchOutbox"
SET "status" = 'PROCESSING', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'outbox-1';
INSERT INTO "ScanPhysicalExecutionTransition" (
  "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
) VALUES (
  'transition-unknown', 'attempt-1', 'operation-1', 4, 'ACTIVE', 'UNKNOWN', repeat('d', 64), CURRENT_TIMESTAMP
);
DO $test$
DECLARE
  retained_state text;
  retained_revision integer;
BEGIN
  SELECT "state", "revision" INTO retained_state, retained_revision
  FROM "ScanPhysicalExecution" WHERE "attemptId" = 'attempt-1';
  IF retained_state <> 'UNKNOWN' OR retained_revision <> 4 THEN
    RAISE EXCEPTION 'physical projection did not follow the journal';
  END IF;

  BEGIN
    INSERT INTO "ScanPhysicalExecutionTransition" (
      "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
    ) VALUES (
      'transition-after-unknown', 'attempt-1', 'operation-1', 5, 'UNKNOWN', 'STOPPED',
      repeat('e', 64), CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'UNKNOWN physical execution was replaced without reconciliation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE "ScanPhysicalExecution" SET "state" = 'STOPPED' WHERE "attemptId" = 'attempt-1';
    RAISE EXCEPTION 'UNKNOWN physical execution was cleared directly';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
INSERT INTO "ScanDispatchOutbox" (
  "id", "operationId", "attemptId", "commandType", "commandDigest", "status", "attempts",
  "availableAt", "createdAt", "updatedAt"
) VALUES (
  'outbox-reconcile', 'operation-1', 'attempt-1', 'RECONCILE', repeat('e', 64), 'PENDING', 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
UPDATE "ScanDispatchOutbox" SET "status" = 'ACKNOWLEDGED', "deliveredAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'outbox-reconcile';
INSERT INTO "ScanPhysicalExecutionTransition" (
  "id", "attemptId", "operationId", "revision", "fromState", "toState", "evidenceReference", "createdAt"
) VALUES (
  'transition-reconciled', 'attempt-1', 'operation-1', 5, 'UNKNOWN', 'STOPPED',
  repeat('e', 64), CURRENT_TIMESTAMP
);
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ScanPhysicalExecution"
    WHERE "attemptId" = 'attempt-1' AND "state" = 'STOPPED' AND "revision" = 5
  ) THEN
    RAISE EXCEPTION 'verified reconciliation did not update the physical projection';
  END IF;
END
$test$;

-- The authority surface has no raw credential/token/secret/payload columns.
DO $test$
DECLARE
  raw_columns integer;
BEGIN
  SELECT count(*) INTO raw_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN (
      'ScanAuthorityEpoch', 'ScanWorkerInstanceGrant', 'ScanDispatchAttempt',
      'ScanDispatchOutbox', 'ScanPhysicalExecution', 'ScanPhysicalExecutionTransition'
    )
    AND column_name ~ '(credential$|^token$|^secret$|^payload$)';
  IF raw_columns <> 0 THEN
    RAISE EXCEPTION 'raw credential material column found';
  END IF;
END
$test$;
SQL
