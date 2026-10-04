import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import {
  EXPECTED_EMPTY_MIGRATIONS,
  hashDatabaseIdentity,
} from "../webhook-empty-state-contract.mjs"
import { runEmptyStateMigration } from "../webhook-empty-state-migration.mjs"

const databaseUrl = process.env.DATABASE_DIRECT_URL
if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
  throw new Error("Refusing destructive rehearsal without an explicitly disposable PostgreSQL service")
}
if (typeof databaseUrl !== "string" || databaseUrl !== process.env.DATABASE_URL) {
  throw new Error("Rehearsal requires identical direct and Prisma database URLs")
}
const parsedUrl = new URL(databaseUrl)
if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname) || parsedUrl.pathname !== "/postgres") {
  throw new Error("Rehearsal URL must be the isolated loopback postgres database")
}

const projectRef = "localtestprojectref1"
const identity = { provider: "supabase", projectRef, database: "postgres", schema: "public" }
const databaseIdentitySha256 = hashDatabaseIdentity(identity)
const sourceSha = process.env.GITHUB_SHA
if (!/^[a-f0-9]{40}$/.test(sourceSha || "")) throw new Error("Workflow source SHA must be exact")
const runId = process.env.GITHUB_RUN_ID || "37200000001"
const stableNonce = randomBytes(24).toString("base64url")
const receipt = {
  schemaVersion: "webhook-empty-state-maintenance/v1",
  mode: "empty-state",
  sourceSha,
  runId,
  owner: runId + ":1",
  stableNonce,
  databaseIdentitySha256,
  migrationDatabaseIdentitySha256: databaseIdentitySha256,
  appDatabaseIdentitySha256: databaseIdentitySha256,
  workerDatabaseUrlIdentitySha256: databaseIdentitySha256,
  workerDatabaseSystemUrlIdentitySha256: databaseIdentitySha256,
  rootReceiptSha256: "a".repeat(64),
  workerStopReceiptSha256: "b".repeat(64),
  admissionStopValueSha256: "c".repeat(64),
  redisIdentitySha256: "d".repeat(64),
  queueSnapshotSha256: "e".repeat(64),
  queueCounts: {
    scan: { wait: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, paused: 0 },
    webhookTrackRetry: { wait: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, paused: 0 },
    fixGenerate: { wait: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, paused: 0 },
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
  issuedAt: new Date().toISOString(),
  nonterminalScans: 0,
  pendingQueueJobs: 0,
  activeWriterRevisions: 0,
  inFlightHandlers: 0,
  writersStopped: true,
  admissionHeld: true,
  fallbackVerified: true,
  redisContinuityVerified: true,
  appConnectionReadbackVerified: true,
}
const env = {
  ...process.env,
  WEBHOOK_EMPTY_STATE_REHEARSAL: "true",
  WEBHOOK_EMPTY_STATE_TEST_PROJECT_REF: projectRef,
  LYRASHIELD_TEST_DB_DISPOSABLE: "1",
  DATABASE_DIRECT_URL: databaseUrl,
  DATABASE_URL: databaseUrl,
  WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256: databaseIdentitySha256,
  WEBHOOK_EMPTY_STATE_STABLE_NONCE: stableNonce,
  WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64: Buffer.from(JSON.stringify(receipt)).toString("base64"),
  DEPLOY_SHA: sourceSha,
  GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: "1",
}

const client = new Client({ connectionString: databaseUrl, application_name: "lyrashield-empty-state-rehearsal-fixture" })
await client.connect()
try {
  await client.query('DROP TABLE IF EXISTS public."WebhookEventTrack", public."WebhookEvent", public."_prisma_migrations" CASCADE')
  await client.query(
    "CREATE TABLE public._prisma_migrations (" +
    "id varchar(36) PRIMARY KEY NOT NULL, checksum varchar(64) NOT NULL, finished_at timestamptz, " +
    "migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, " +
    "started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)",
  )
  await client.query(
    'CREATE TABLE public."WebhookEvent" (id text PRIMARY KEY, processed boolean NOT NULL DEFAULT false, "deletedAt" timestamp(3))',
  )
  await client.query(
    'CREATE TABLE public."WebhookEventTrack" (' +
    "id text PRIMARY KEY, \"webhookEventId\" text NOT NULL, track text NOT NULL, " +
    "status text NOT NULL DEFAULT 'pending', \"nextAttemptAt\" timestamp(3), \"leaseExpiresAt\" timestamp(3))",
  )

  const migrationRoot = resolve(fileURLToPath(new URL("../../prisma/migrations/", import.meta.url)))
  const emptyNames = new Set(EXPECTED_EMPTY_MIGRATIONS.map((migration) => migration.name))
  const migrationDirectories = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const name of migrationDirectories) {
    if (emptyNames.has(name)) continue
    const contents = readFileSync(resolve(migrationRoot, name, "migration.sql"))
    const checksum = createHash("sha256").update(contents).digest("hex")
    await client.query(
      'INSERT INTO public."_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',
      [randomUUID(), checksum, name],
    )
  }

  const first = await runEmptyStateMigration({ env })
  assert.equal(first.status, "complete")
  const result = await client.query(
    "SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS notnull, " +
    "pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a " +
    "LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum " +
    "WHERE a.attrelid='public.\"WebhookEventTrack\"'::regclass AND a.attnum>0 AND NOT a.attisdropped",
  )
  const columns = new Map(result.rows.map((row) => [row.name, row]))
  assert.equal(columns.get("nextAttemptAtUtc").type, "timestamp(3) with time zone")
  assert.match(columns.get("nextAttemptAtUtc").default, /CURRENT_TIMESTAMP/i)
  for (const name of ["historicalAttempts", "operatorRecoveryCount"]) {
    assert.equal(columns.get(name).type, "integer")
    assert.equal(columns.get(name).notnull, true)
    assert.match(columns.get(name).default, /0/)
  }
  const index = await client.query(
    "SELECT i.indisvalid AS valid, i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS definition " +
    "FROM pg_index i WHERE i.indexrelid=to_regclass('public.\"WebhookEventTrack_status_nextAttemptAtUtc_idx\"')",
  )
  assert.equal(index.rows[0].valid, true)
  assert.equal(index.rows[0].ready, true)
  assert.match(index.rows[0].definition, /USING btree \(status, \"nextAttemptAtUtc\"\)$/)
  const markerRow = await client.query(
    "SELECT col_description('public.\"WebhookEventTrack\"'::regclass,a.attnum) AS marker " +
    "FROM pg_attribute a WHERE a.attrelid='public.\"WebhookEventTrack\"'::regclass AND a.attname='nextAttemptAtUtc'",
  )
  const marker = JSON.parse(markerRow.rows[0].marker.slice("lyrashield:webhook-empty-state/v1:".length))
  assert.equal(marker.state, "complete")
  assert.equal(marker.sourceSha, sourceSha)
  assert.equal(marker.databaseIdentitySha256, databaseIdentitySha256)
  for (const migration of EXPECTED_EMPTY_MIGRATIONS) {
    const row = await client.query("SELECT checksum,finished_at FROM public._prisma_migrations WHERE migration_name=$1", [migration.name])
    assert.equal(row.rows[0].checksum, migration.sha256)
    assert.ok(row.rows[0].finished_at)
  }

  await client.query('INSERT INTO public."WebhookEvent"(id,processed) VALUES ($1,true)', ["event-after-cutover"])
  await client.query(
    'INSERT INTO public."WebhookEventTrack"(id,"webhookEventId",track,status,"nextAttemptAt") VALUES ($1,$2,$3,$4,now())',
    ["track-after-cutover", "event-after-cutover", "billing", "pending"],
  )
  const retry = await runEmptyStateMigration({ env })
  assert.equal(retry.status, "complete")
  const retained = await client.query('SELECT count(*)::integer AS count FROM public."WebhookEventTrack"')
  assert.equal(retained.rows[0].count, 1, "Completed rerun must preserve legitimate post-cutover work")
} finally {
  await client.end()
}

process.stdout.write("PostgreSQL 17 empty-state migration rehearsal passed\n")
