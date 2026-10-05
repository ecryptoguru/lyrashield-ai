import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signBytes } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { Client } from "pg"
import { createDisposablePostgresClient, EXPECTED_EMPTY_MIGRATIONS, hashDatabaseIdentity } from "../webhook-empty-state-contract.mjs"
import { runEmptyStateMigration } from "../webhook-empty-state-migration.mjs"

const databaseUrl = process.env.DATABASE_DIRECT_URL
if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") throw new Error("Refusing destructive rehearsal without an explicitly disposable PostgreSQL service")
if (typeof databaseUrl !== "string" || databaseUrl !== process.env.DATABASE_URL) throw new Error("Rehearsal requires identical direct and Prisma database URLs")
const projectRef = "localtestprojectref1"
const identity = { provider: "supabase", projectRef, database: "postgres", schema: "public" }
const identitySha = hashDatabaseIdentity(identity)
const sourceSha = process.env.GITHUB_SHA
if (!/^[a-f0-9]{40}$/.test(sourceSha || "")) throw new Error("Workflow source SHA must be exact")
const runId = process.env.GITHUB_RUN_ID || "37200000001"
const signingKeys = generateKeyPairSync("ed25519")
const publicKeyPem = signingKeys.publicKey.export({ type: "spki", format: "pem" })
const roleName = "empty_state_rehearsal_" + randomBytes(6).toString("hex")
const rolePassword = randomBytes(24).toString("hex")
const runnerUrl = new URL(databaseUrl)
runnerUrl.username = roleName
runnerUrl.password = rolePassword
const runnerDatabaseUrl = runnerUrl.toString()
const admin = createDisposablePostgresClient(databaseUrl, Client, { application_name: "lyrashield-empty-state-rehearsal-admin" })
await admin.connect()
await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`)
await admin.query(`GRANT CONNECT ON DATABASE postgres TO ${roleName}`)
await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${roleName}`)

const migrationRoot = resolve(fileURLToPath(new URL("../../prisma/migrations/", import.meta.url)))
const emptyNames = new Set(EXPECTED_EMPTY_MIGRATIONS.map((migration) => migration.name))
const migrationDirectories = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

function signReceipt(receipt) {
  const unsigned = { ...receipt }
  delete unsigned.signature
  return { ...unsigned, signature: signBytes(null, Buffer.from(JSON.stringify(unsigned)), signingKeys.privateKey).toString("base64") }
}

function makeEnvironment({ issuedAt = new Date().toISOString() } = {}) {
  const stableNonce = randomBytes(24).toString("base64url")
  const receipt = signReceipt({
    schemaVersion: "webhook-empty-state-maintenance/v1",
    mode: "empty-state",
    sourceSha,
    runId,
    owner: runId + ":1",
    stableNonce,
    databaseIdentitySha256: identitySha,
    migrationDatabaseIdentitySha256: identitySha,
    appDatabaseIdentitySha256: identitySha,
    workerDatabaseUrlIdentitySha256: identitySha,
    workerDatabaseSystemUrlIdentitySha256: identitySha,
    rootReceiptSha256: "a".repeat(64),
    workerStopReceiptSha256: "b".repeat(64),
    admissionStopValueSha256: "c".repeat(64),
    redisIdentitySha256: "d".repeat(64),
    queueSnapshotSha256: "e".repeat(64),
    queueCounts: {
      scan: { wait: 0, active: 0, delayed: 0, prioritized: 0, "waiting-children": 0, paused: 0 },
      webhookTrackRetry: { wait: 0, active: 0, delayed: 0, prioritized: 0, "waiting-children": 0, paused: 0 },
      fixGenerate: { wait: 0, active: 0, delayed: 0, prioritized: 0, "waiting-children": 0, paused: 0 },
    },
    queueSchedulerCount: 0,
    repeatableJobCount: 0,
    workerStopImageDigest: "sha256:" + "1".repeat(64),
    workerStopSourceSha: "2".repeat(40),
    fallbackWorkerImageDigest: "sha256:" + "3".repeat(64),
    fallbackSourceSha: "4".repeat(40),
    fallbackEngineRevision: "5".repeat(40),
    fallbackProtocol: "durable-claims/1",
    fallbackEvidenceSha256: "f".repeat(64),
    issuedAt,
    nonterminalScans: 0,
    pendingQueueJobs: 0,
    activeWriterRevisions: 0,
    inFlightHandlers: 0,
    writersStopped: true,
    admissionHeld: true,
    fallbackVerified: true,
    redisContinuityVerified: true,
    appConnectionReadbackVerified: true,
  })
  return {
    ...process.env,
    WEBHOOK_EMPTY_STATE_REHEARSAL: "true",
    WEBHOOK_EMPTY_STATE_TEST_PROJECT_REF: projectRef,
    LYRASHIELD_TEST_DB_DISPOSABLE: "1",
    DATABASE_DIRECT_URL: runnerDatabaseUrl,
    DATABASE_URL: runnerDatabaseUrl,
    WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256: identitySha,
    WEBHOOK_EMPTY_STATE_STABLE_NONCE: stableNonce,
    WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64: Buffer.from(JSON.stringify(receipt)).toString("base64"),
    WEBHOOK_EMPTY_STATE_RECEIPT_PUBLIC_KEY_PEM: publicKeyPem,
    DEPLOY_SHA: sourceSha,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: "1",
  }
}

function refreshEnvironment(env) {
  const receipt = JSON.parse(Buffer.from(env.WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64, "base64").toString("utf8"))
  delete receipt.signature
  receipt.issuedAt = new Date().toISOString()
  const refreshed = signReceipt(receipt)
  return { ...env, WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64: Buffer.from(JSON.stringify(refreshed)).toString("base64") }
}

async function prepareBaseline({ processedEvents = false, hiddenRows = false, foreignHistory = false } = {}) {
  await admin.query('DROP TABLE IF EXISTS public."WebhookEventTrack", public."WebhookEvent", public."_prisma_migrations" CASCADE')
  await admin.query(
    'CREATE TABLE public."_prisma_migrations" (' +
    'id varchar(36) PRIMARY KEY NOT NULL, checksum varchar(64) NOT NULL, finished_at timestamptz, ' +
    'migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, ' +
    'started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)',
  )
  await admin.query('CREATE TABLE public."WebhookEvent" (id text PRIMARY KEY, processed boolean NOT NULL DEFAULT false, "deletedAt" timestamp(3))')
  await admin.query(
    'CREATE TABLE public."WebhookEventTrack" (' +
    'id text PRIMARY KEY, "webhookEventId" text NOT NULL REFERENCES public."WebhookEvent"(id) ON DELETE CASCADE ON UPDATE CASCADE, ' +
    '"workspaceId" text, track text NOT NULL, status text NOT NULL DEFAULT \'pending\', attempts integer NOT NULL DEFAULT 0, ' +
    '"lastError" text, "completedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    '"updatedAt" timestamp(3) NOT NULL, generation integer NOT NULL DEFAULT 0, "nextAttemptAt" timestamp(3), ' +
    '"claimToken" text, "leaseExpiresAt" timestamp(3), UNIQUE("webhookEventId",track), CONSTRAINT "WebhookEventTrack_generation_nonnegative" CHECK (generation >= 0))',
  )
  await admin.query('CREATE INDEX "WebhookEventTrack_status_idx" ON public."WebhookEventTrack" (status)')
  await admin.query('CREATE INDEX "WebhookEventTrack_track_status_idx" ON public."WebhookEventTrack" (track,status)')
  await admin.query('CREATE INDEX "WebhookEventTrack_status_nextAttemptAt_idx" ON public."WebhookEventTrack" (status,"nextAttemptAt")')
  for (const name of migrationDirectories) {
    if (emptyNames.has(name)) continue
    const bytes = readFileSync(resolve(migrationRoot, name, "migration.sql"))
    const checksum = createHash("sha256").update(bytes).digest("hex")
    await admin.query(
      'INSERT INTO public."_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',
      [randomUUID(), checksum, name],
    )
  }
  if (foreignHistory) {
    await admin.query(
      'INSERT INTO public."_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',
      [randomUUID(), EXPECTED_EMPTY_MIGRATIONS[0].sha256, EXPECTED_EMPTY_MIGRATIONS[0].name],
    )
  }
  await admin.query(`ALTER TABLE public."_prisma_migrations" OWNER TO ${roleName}`)
  await admin.query(`ALTER TABLE public."WebhookEvent" OWNER TO ${roleName}`)
  await admin.query(`ALTER TABLE public."WebhookEventTrack" OWNER TO ${roleName}`)
  if (processedEvents) {
    await admin.query('INSERT INTO public."WebhookEvent"(id,processed,"deletedAt") VALUES ($1,true,NULL),($2,true,now())', ["processed-receipt-one", "processed-receipt-two"])
  }
  if (hiddenRows) {
    await admin.query('INSERT INTO public."WebhookEvent"(id,processed) VALUES ($1,true)', ["rls-hidden-parent"])
    await admin.query(
      'INSERT INTO public."WebhookEventTrack"(id,"webhookEventId",track,status,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      ["rls-hidden-track", "rls-hidden-parent", "billing", "pending"],
    )
    await admin.query('CREATE POLICY rehearsal_allow_track_rows ON public."WebhookEventTrack" AS PERMISSIVE FOR SELECT USING (true)')
    await admin.query('CREATE POLICY rehearsal_hide_track_rows ON public."WebhookEventTrack" AS RESTRICTIVE FOR SELECT USING (false)')
    await admin.query('ALTER TABLE public."WebhookEventTrack" ENABLE ROW LEVEL SECURITY')
    await admin.query('ALTER TABLE public."WebhookEventTrack" FORCE ROW LEVEL SECURITY')
    const state = await admin.query(
      'SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, ' +
      'pg_get_userbyid(c.relowner) = $1 AS runner_owns_table, r.rolsuper AS runner_superuser, ' +
      'r.rolbypassrls AS runner_bypasses_rls FROM pg_class c JOIN pg_roles r ON r.rolname = $1 ' +
      'WHERE c.oid = \'public."WebhookEventTrack"\'::regclass',
      [roleName],
    )
    assert.deepEqual(state.rows[0], {
      enabled: true,
      forced: true,
      runner_owns_table: true,
      runner_superuser: false,
      runner_bypasses_rls: false,
    }, "RLS fixture must enable FORCE RLS for a non-bypass table-owner role")
  }
}

async function assertRunnerRoleRlsBoundary() {
  const probe = new Client({ connectionString: runnerDatabaseUrl, application_name: "lyrashield-empty-state-rls-probe" })
  await probe.connect()
  try {
    const visible = await probe.query('SELECT count(*)::integer AS count FROM public."WebhookEventTrack" WHERE id=$1', ["rls-hidden-track"])
    assert.equal(visible.rows[0].count, 0, "the rehearsal runner role must not see the policy-hidden fixture row")
    await probe.query("SET row_security = off")
    await assert.rejects(
      probe.query('SELECT count(*) FROM public."WebhookEventTrack" WHERE id=$1', ["rls-hidden-track"]),
      (error) => error?.code === "42501" && /row-level security/i.test(error.message),
      "row_security=off must reject a query whose results RLS would filter",
    )
  } finally {
    await probe.end()
  }
}

async function marker() {
  const result = await admin.query(
    'SELECT col_description(\'public."WebhookEventTrack"\'::regclass,a.attnum) AS marker FROM pg_attribute a ' +
    'WHERE a.attrelid=\'public."WebhookEventTrack"\'::regclass AND a.attname=\'nextAttemptAtUtc\' AND NOT a.attisdropped',
  )
  const text = result.rows[0]?.marker
  return typeof text === "string" && text.startsWith("lyrashield:webhook-empty-state/v1:")
    ? JSON.parse(text.slice("lyrashield:webhook-empty-state/v1:".length)) : null
}

async function hasColumn(name) {
  const result = await admin.query(
    'SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=\'public."WebhookEventTrack"\'::regclass AND attname=$1 AND attnum>0 AND NOT attisdropped) AS present',
    [name],
  )
  return result.rows[0].present
}

async function expectFailure(env, pattern, options = {}) {
  await assert.rejects(runEmptyStateMigration({ env, ...options }), pattern)
}

function crashAt(phase) {
  return async (seen) => { if (seen === phase) throw new Error("simulated process crash after " + phase) }
}

async function waitForActivity(applicationName, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await admin.query(
      "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE application_name=$1",
      [applicationName],
    )
    if (result.rows.length && predicate(result.rows[0])) return result.rows[0]
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  assert.fail("Timed out waiting for PostgreSQL activity: " + applicationName)
}

const env = makeEnvironment()
await prepareBaseline({ processedEvents: true })
const first = await runEmptyStateMigration({ env })
assert.equal(first.status, "complete")
for (const name of ["nextAttemptAt", "nextAttemptAtUtc", "leaseExpiresAtUtc", "historicalAttempts", "operatorRecoveryCount"]) assert.equal(await hasColumn(name), true)
const processed = await admin.query('SELECT id,processed FROM public."WebhookEvent" ORDER BY id')
assert.deepEqual(processed.rows, [
  { id: "processed-receipt-one", processed: true },
  { id: "processed-receipt-two", processed: true },
])
const finalMarker = await marker()
assert.equal(finalMarker.state, "complete")
for (const migration of EXPECTED_EMPTY_MIGRATIONS) {
  const result = await admin.query('SELECT checksum,finished_at FROM public."_prisma_migrations" WHERE migration_name=$1', [migration.name])
  assert.equal(result.rows[0].checksum, migration.sha256)
  assert.ok(result.rows[0].finished_at)
}
await admin.query('INSERT INTO public."WebhookEventTrack"(id,"webhookEventId",track,status,"nextAttemptAt","updatedAt") VALUES ($1,$2,$3,$4,now(),now()),($5,$6,$7,$8,now(),now())', [
  "post-cutover-track-one", "processed-receipt-one", "billing", "pending",
  "post-cutover-track-two", "processed-receipt-two", "license", "pending",
])
const retry = await runEmptyStateMigration({ env })
assert.equal(retry.status, "complete")
const retained = await admin.query('SELECT count(*)::integer AS count FROM public."WebhookEventTrack"')
assert.equal(retained.rows[0].count, 2, "completed no-op retry must preserve post-cutover work")

for (const phase of ["core-committed", "index-intent", "index-created", "operator-columns"]) {
  await prepareBaseline()
  const phaseEnv = makeEnvironment()
  await expectFailure(phaseEnv, new RegExp("simulated process crash after " + phase), { faultInjector: crashAt(phase) })
  const saved = await marker()
  assert.ok(saved, "phase marker must survive process interruption at " + phase)
  const resumed = await runEmptyStateMigration({ env: phaseEnv })
  assert.equal(resumed.status, "complete", "retry must recover after " + phase)
  assert.equal((await marker()).state, "complete")
}

await prepareBaseline()
const raceWriter = new Client({ connectionString: runnerDatabaseUrl, application_name: "lyrashield-empty-state-concurrent-writer" })
await raceWriter.connect()
await raceWriter.query("BEGIN")
await raceWriter.query('INSERT INTO public."WebhookEvent"(id,processed) VALUES ($1,false)', ["race-parent"])
await raceWriter.query(
  'INSERT INTO public."WebhookEventTrack"(id,"webhookEventId",track,status,"updatedAt") VALUES ($1,$2,$3,$4,now())',
  ["race-track", "race-parent", "billing", "pending"],
)
const raceEnvironment = makeEnvironment()
const raceMigration = runEmptyStateMigration({ env: raceEnvironment })
await waitForActivity("lyrashield-empty-state-migration", (activity) => activity.wait_event_type === "Lock")
await raceWriter.query("COMMIT")
await raceWriter.end()
await assert.rejects(raceMigration, /WebhookEventTrack contains rows/)
assert.equal(await hasColumn("nextAttemptAtUtc"), false, "a writer that wins the lock race must block all migration DDL")
const racedRow = await admin.query('SELECT count(*)::integer AS count FROM public."WebhookEventTrack" WHERE id=$1', ["race-track"])
assert.equal(racedRow.rows[0].count, 1, "the concurrent writer's committed work must remain intact")
const raceHistory = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name = ANY($1::text[])', [EXPECTED_EMPTY_MIGRATIONS.map((migration) => migration.name)])
assert.equal(raceHistory.rows[0].count, 0, "the runner must not reconcile migration history after losing the empty-state race")

await prepareBaseline()
const killedEnvironment = makeEnvironment()
let killedCoreBackend = false
await assert.rejects(
  runEmptyStateMigration({
    env: killedEnvironment,
    faultInjector: async (phase, client) => {
      if (phase !== "core-transaction-after-sql") return
      const backend = await client.query("SELECT pg_backend_pid() AS pid")
      const termination = await admin.query("SELECT pg_terminate_backend($1) AS terminated", [backend.rows[0].pid])
      assert.equal(termination.rows[0].terminated, true, "the rehearsal must terminate the migration backend inside the open transaction")
      killedCoreBackend = true
    },
  }),
  /terminat|connection.*closed|connection.*terminated/i,
)
assert.equal(killedCoreBackend, true, "backend termination must happen inside the core migration transaction")
assert.equal(await hasColumn("nextAttemptAtUtc"), false, "terminating the backend inside the core transaction must roll back its DDL")
const killedHistory = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name = ANY($1::text[])', [EXPECTED_EMPTY_MIGRATIONS.map((migration) => migration.name)])
assert.equal(killedHistory.rows[0].count, 0, "a killed core transaction must not create Prisma history")
assert.equal(await marker(), null, "a killed core transaction must not persist its progress marker")

for (const migration of EXPECTED_EMPTY_MIGRATIONS) {
  await prepareBaseline()
  const resolveEnvironment = makeEnvironment()
  let interrupted = false
  await assert.rejects(
    runEmptyStateMigration({
      env: resolveEnvironment,
      prismaResolve: (command, args, options, resolvedMigration) => {
        const result = spawnSync(command, args, options)
        if (!interrupted && resolvedMigration === migration.name && !result.error && result.status === 0) {
          interrupted = true
          return { ...result, status: 1, error: new Error("simulated lost acknowledgement after Prisma resolve " + migration.name) }
        }
        return result
      },
    }),
    new RegExp("simulated lost acknowledgement after Prisma resolve " + migration.name),
  )
  assert.equal(interrupted, true, "the test must interrupt immediately after the selected Prisma resolve")
  const persisted = await admin.query('SELECT checksum,finished_at FROM public."_prisma_migrations" WHERE migration_name=$1', [migration.name])
  assert.equal(persisted.rows.length, 1, "Prisma's applied record must have committed before the acknowledgement is lost")
  assert.equal(persisted.rows[0].checksum, migration.sha256)
  assert.ok(persisted.rows[0].finished_at)
  const recovered = await runEmptyStateMigration({ env: resolveEnvironment })
  assert.equal(recovered.status, "complete", "retry must recognize the already applied migration " + migration.name)
  const duplicateCheck = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name=$1', [migration.name])
  assert.equal(duplicateCheck.rows[0].count, 1, "retry must not create a duplicate history row for " + migration.name)
}

await prepareBaseline()
const expiringEnv = makeEnvironment()
let fakeNow = Date.parse(JSON.parse(Buffer.from(expiringEnv.WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64, "base64").toString("utf8")).issuedAt)
await expectFailure(expiringEnv, /outside its 30-minute validity window/, {
  clock: () => fakeNow,
  faultInjector: async (phase) => { if (phase === "core-committed") fakeNow += 31 * 60_000 },
})
assert.equal((await marker()).state, "core-committed")
const preResolveRows = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name = ANY($1::text[])', [EXPECTED_EMPTY_MIGRATIONS.map((migration) => migration.name)])
assert.equal(preResolveRows.rows[0].count, 0, "expired receipt must stop before Prisma history reconciliation")
const refreshed = refreshEnvironment(expiringEnv)
assert.equal((await runEmptyStateMigration({ env: refreshed })).status, "complete")

for (const [phase, expectedMarker, expectedIndex, unresolvedMigration] of [
  ["index-intent", "index-intent", false, EXPECTED_EMPTY_MIGRATIONS[2]],
  ["index-created", "index-intent", true, EXPECTED_EMPTY_MIGRATIONS[2]],
  ["index-ready", "index-ready", true, EXPECTED_EMPTY_MIGRATIONS[2]],
  ["operator-columns", "operator-columns", true, EXPECTED_EMPTY_MIGRATIONS[3]],
]) {
  await prepareBaseline()
  const phaseEnv = makeEnvironment()
  let phaseClock = Date.parse(JSON.parse(Buffer.from(phaseEnv.WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64, "base64").toString("utf8")).issuedAt)
  await expectFailure(phaseEnv, /outside its 30-minute validity window/, {
    clock: () => phaseClock,
    faultInjector: async (seen) => { if (seen === phase) phaseClock += 31 * 60_000 },
  })
  assert.equal((await marker()).state, expectedMarker, "phase marker must remain at the last committed boundary")
  const index = await admin.query('SELECT to_regclass(\'public."WebhookEventTrack_status_nextAttemptAtUtc_idx"\') IS NOT NULL AS present')
  assert.equal(index.rows[0].present, expectedIndex, "index side effect must match the committed phase")
  const unresolved = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name=$1', [unresolvedMigration.name])
  assert.equal(unresolved.rows[0].count, 0, "expired receipt must stop before reconciling the next migration")
}

await prepareBaseline()
const lockHolder = new Client({ connectionString: databaseUrl, application_name: "lyrashield-empty-state-lock-fixture" })
await lockHolder.connect()
await lockHolder.query("SELECT pg_advisory_lock($1,$2)", [1987654321, 2026100204])
await expectFailure(makeEnvironment(), /Timed out waiting for the empty-state advisory lock/, { advisoryLockWaitMs: 80, advisoryLockPollMs: 10 })
await lockHolder.query("SELECT pg_advisory_unlock($1,$2)", [1987654321, 2026100204])
await lockHolder.end()
assert.equal(await hasColumn("nextAttemptAtUtc"), false, "lock timeout must occur before schema writes")

await prepareBaseline()
const expiryEnv = makeEnvironment()
const issuedAt = Date.parse(JSON.parse(Buffer.from(expiryEnv.WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64, "base64").toString("utf8")).issuedAt)
const expiringLock = new Client({ connectionString: databaseUrl, application_name: "lyrashield-empty-state-expiry-lock-fixture" })
await expiringLock.connect()
await expiringLock.query("SELECT pg_advisory_lock($1,$2)", [1987654321, 2026100204])
let lockClock = issuedAt
const waitingRun = runEmptyStateMigration({ env: expiryEnv, clock: () => lockClock, advisoryLockWaitMs: 1500, advisoryLockPollMs: 10 })
setTimeout(() => { lockClock = issuedAt + 31 * 60_000 }, 80)
await assert.rejects(waitingRun, /outside its 30-minute validity window/)
await expiringLock.query("SELECT pg_advisory_unlock($1,$2)", [1987654321, 2026100204])
await expiringLock.end()
assert.equal(await hasColumn("nextAttemptAtUtc"), false, "expired receipt while waiting must cause no DDL")

await prepareBaseline()
await admin.query('INSERT INTO public."WebhookEvent"(id,processed,"deletedAt") VALUES ($1,false,now())', ["soft-deleted-unresolved"])
await expectFailure(makeEnvironment(), /Unresolved webhook events exist, including soft-deleted events/)
assert.equal(await hasColumn("nextAttemptAtUtc"), false)

await prepareBaseline({ hiddenRows: true })
await assertRunnerRoleRlsBoundary()
await expectFailure(makeEnvironment(), /row-level security/i)
const hidden = await admin.query('SELECT count(*)::integer AS count FROM public."WebhookEventTrack" WHERE id=$1', ["rls-hidden-track"])
assert.equal(hidden.rows[0].count, 1, "the runner must reject a fixture row hidden from its non-privileged connection")
assert.equal(await hasColumn("nextAttemptAtUtc"), false, "RLS-hidden rows must abort before DDL")

await prepareBaseline({ foreignHistory: true })
await expectFailure(makeEnvironment(), /Prisma history exists without an owned empty-state marker/)
assert.equal(await hasColumn("nextAttemptAtUtc"), false)

await prepareBaseline()
const foreignMarkerEnv = makeEnvironment()
await expectFailure(foreignMarkerEnv, /simulated process crash after core-committed/, { faultInjector: crashAt("core-committed") })
const foreignMarker = await admin.query(
  "SELECT format('COMMENT ON COLUMN public.\"WebhookEventTrack\".\"nextAttemptAtUtc\" IS %L', $1::text) AS statement",
  ["lyrashield:webhook-empty-state/v1:" + JSON.stringify({ version: 1, mode: "empty-state", state: "core-committed", sourceSha: "0".repeat(40) })],
)
await admin.query(foreignMarker.rows[0].statement)
await expectFailure(foreignMarkerEnv, /does not match this run/)

  await prepareBaseline()
  const malformedIndexEnv = makeEnvironment()
  await expectFailure(malformedIndexEnv, /simulated process crash after index-intent/, { faultInjector: crashAt("index-intent") })
  await admin.query('CREATE INDEX "WebhookEventTrack_status_nextAttemptAtUtc_idx" ON public."WebhookEventTrack" (track)')
  await expectFailure(malformedIndexEnv, /does not match the required definition/)
  const indexHistory = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name=$1', [EXPECTED_EMPTY_MIGRATIONS[2].name])
  assert.equal(indexHistory.rows[0].count, 0, "malformed index must stop before migration-history reconciliation")

await prepareBaseline()
const invalidIndexEnv = makeEnvironment()
await expectFailure(invalidIndexEnv, /simulated process crash after index-intent/, { faultInjector: crashAt("index-intent") })
await admin.query('INSERT INTO public."WebhookEvent"(id,processed) VALUES ($1,true),($2,true)', ["duplicate-index-parent-a", "duplicate-index-parent-b"])
await admin.query(
  'INSERT INTO public."WebhookEventTrack"(id,"webhookEventId",track,status,"nextAttemptAtUtc","updatedAt") VALUES ' +
  '($1,$2,$3,$4,$5::timestamptz,now()),($6,$7,$8,$9,$5::timestamptz,now())',
  ["duplicate-index-track-a", "duplicate-index-parent-a", "billing", "pending", "2026-10-01T00:00:00.000Z", "duplicate-index-track-b", "duplicate-index-parent-b", "license", "pending"],
)
await assert.rejects(
  admin.query('CREATE UNIQUE INDEX CONCURRENTLY "WebhookEventTrack_status_nextAttemptAtUtc_idx" ON public."WebhookEventTrack" (status, "nextAttemptAtUtc")'),
  /could not create unique index|duplicate key value/i,
)
const invalidIndex = await admin.query(
  'SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique FROM pg_class idx ' +
  'JOIN pg_index i ON i.indexrelid=idx.oid WHERE idx.oid=to_regclass($1)',
  ['public."WebhookEventTrack_status_nextAttemptAtUtc_idx"'],
)
assert.equal(invalidIndex.rows[0]?.valid, false, "failed concurrent uniqueness validation must leave an invalid index")
assert.equal(invalidIndex.rows[0]?.unique, true, "the invalid index fixture must preserve its unique build definition")
await expectFailure(invalidIndexEnv, /Existing webhook UTC index is invalid; reviewed repair is required/)
const invalidIndexHistory = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name=$1', [EXPECTED_EMPTY_MIGRATIONS[2].name])
assert.equal(invalidIndexHistory.rows[0].count, 0, "invalid index must stop before Prisma records the index migration")
const duplicateRows = await admin.query('SELECT count(*)::integer AS count FROM public."WebhookEventTrack" WHERE id LIKE $1', ["duplicate-index-track-%"])
assert.equal(duplicateRows.rows[0].count, 2, "invalid-index handling must retain all work for operator review")
await admin.query('DROP INDEX CONCURRENTLY public."WebhookEventTrack_status_nextAttemptAtUtc_idx"')
await admin.query('DELETE FROM public."WebhookEventTrack" WHERE id LIKE $1', ["duplicate-index-track-%"])
await admin.query('DELETE FROM public."WebhookEvent" WHERE id LIKE $1', ["duplicate-index-parent-%"])
assert.equal((await runEmptyStateMigration({ env: invalidIndexEnv })).status, "complete", "an operator-repaired index may be safely rebuilt and reconciled")
const repairedIndex = await admin.query(
  'SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique FROM pg_class idx ' +
  'JOIN pg_index i ON i.indexrelid=idx.oid WHERE idx.oid=to_regclass($1)',
  ['public."WebhookEventTrack_status_nextAttemptAtUtc_idx"'],
)
assert.deepEqual(repairedIndex.rows[0], { valid: true, ready: true, unique: false }, "recovery must produce the exact nonunique concurrent index")

await prepareBaseline()
const legacyDriftEnv = makeEnvironment()
await expectFailure(legacyDriftEnv, /simulated process crash after core-committed/, { faultInjector: crashAt("core-committed") })
await admin.query('ALTER TABLE public."WebhookEventTrack" ALTER COLUMN "nextAttemptAt" SET DEFAULT (CURRENT_TIMESTAMP + interval \'1 day\')')
await expectFailure(legacyDriftEnv, /column contract differs at core: nextAttemptAt/)
const legacyHistory = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name=$1', [EXPECTED_EMPTY_MIGRATIONS[0].name])
assert.equal(legacyHistory.rows[0].count, 0, "legacy default drift must stop before migration-history reconciliation")

for (const alter of [
  'ALTER TABLE public."WebhookEventTrack" ALTER COLUMN "historicalAttempts" TYPE text USING "historicalAttempts"::text',
  'ALTER TABLE public."WebhookEventTrack" ALTER COLUMN "operatorRecoveryCount" DROP NOT NULL',
  'ALTER TABLE public."WebhookEventTrack" ALTER COLUMN "operatorRecoveryCount" SET DEFAULT 100',
]) {
  await prepareBaseline()
  const driftEnv = makeEnvironment()
  await expectFailure(driftEnv, /simulated process crash after operator-columns/, { faultInjector: crashAt("operator-columns") })
  await admin.query(alter)
  await expectFailure(driftEnv, /column contract differs at complete/)
  const unresolved = await admin.query('SELECT count(*)::integer AS count FROM public."_prisma_migrations" WHERE migration_name=$1', [EXPECTED_EMPTY_MIGRATIONS[3].name])
  assert.equal(unresolved.rows[0].count, 0, "schema drift must stop before migration-history reconciliation")
}

await admin.query('DROP TABLE IF EXISTS public."WebhookEventTrack", public."WebhookEvent", public."_prisma_migrations" CASCADE')
await admin.query(`REVOKE CONNECT ON DATABASE postgres FROM ${roleName}`)
await admin.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM ${roleName}`)
await admin.query(`DROP ROLE IF EXISTS ${roleName}`)
await admin.end()
process.stdout.write("PostgreSQL 17 empty-state migration rehearsal passed, including crash recovery, lock expiry, RLS, marker/history, soft-delete, and schema-drift gates\n")
