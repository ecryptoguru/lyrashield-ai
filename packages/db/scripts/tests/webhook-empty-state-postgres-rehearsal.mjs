import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signBytes } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { EXPECTED_EMPTY_MIGRATIONS, hashDatabaseIdentity } from "../webhook-empty-state-contract.mjs"
import { runEmptyStateMigration } from "../webhook-empty-state-migration.mjs"

const databaseUrl = process.env.DATABASE_DIRECT_URL
if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") throw new Error("Refusing destructive rehearsal without an explicitly disposable PostgreSQL service")
if (typeof databaseUrl !== "string" || databaseUrl !== process.env.DATABASE_URL) throw new Error("Rehearsal requires identical direct and Prisma database URLs")
const adminUrl = new URL(databaseUrl)
if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname) || adminUrl.pathname !== "/postgres" || (adminUrl.port && adminUrl.port !== "5432")) {
  throw new Error("Rehearsal URL must be the isolated loopback postgres database on session port 5432")
}

const projectRef = "localtestprojectref1"
const identity = { provider: "supabase", projectRef, database: "postgres", schema: "public" }
const identitySha = hashDatabaseIdentity(identity)
const sourceSha = process.env.GITHUB_SHA
if (!/^[a-f0-9]{40}$/.test(sourceSha || "")) throw new Error("Workflow source SHA must be exact")
const runId = process.env.GITHUB_RUN_ID || "37200000001"
const signingKeys = generateKeyPairSync("ed25519")
const publicKeyPem = signingKeys.publicKey.export({ type: "spki", format: "pem" })
const roleName = "empty_state_rehearsal"
const rolePassword = randomBytes(24).toString("hex")
const runnerUrl = new URL(databaseUrl)
runnerUrl.username = roleName
runnerUrl.password = rolePassword
const runnerDatabaseUrl = runnerUrl.toString()
const admin = new Client({ connectionString: databaseUrl, application_name: "lyrashield-empty-state-rehearsal-admin" })
await admin.connect()
await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
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
    await admin.query('CREATE POLICY rehearsal_hide_track_rows ON public."WebhookEventTrack" FOR SELECT USING (false)')
    await admin.query('ALTER TABLE public."WebhookEventTrack" FORCE ROW LEVEL SECURITY')
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
await admin.query('INSERT INTO public."WebhookEventTrack"(id,"webhookEventId",track,status,"nextAttemptAt") VALUES ($1,$2,$3,$4,now()),($5,$6,$7,$8,now())', [
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
await expectFailure(makeEnvironment(), /row-level security/i)
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
await expectFailure(makeEnvironment(), /simulated process crash after index-intent/, { faultInjector: crashAt("index-intent") })
await admin.query('CREATE INDEX "WebhookEventTrack_status_nextAttemptAtUtc_idx" ON public."WebhookEventTrack" (track)')
await expectFailure(makeEnvironment(), /does not match the required definition/)

await prepareBaseline()
await expectFailure(makeEnvironment(), /simulated process crash after core-committed/, { faultInjector: crashAt("core-committed") })
await admin.query('ALTER TABLE public."WebhookEventTrack" ALTER COLUMN "nextAttemptAt" SET DEFAULT (CURRENT_TIMESTAMP + interval \'1 day\')')
await expectFailure(makeEnvironment(), /column contract differs at core: nextAttemptAt/)

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
await admin.query(`DROP ROLE IF EXISTS ${roleName}`)
await admin.end()
process.stdout.write("PostgreSQL 17 empty-state migration rehearsal passed, including crash recovery, lock expiry, RLS, marker/history, soft-delete, and schema-drift gates\n")
