import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import {
  assertMigrationUrlBinding,
  canonicalSupabaseDatabaseIdentity,
  EXPECTED_EMPTY_MIGRATIONS,
  hashDatabaseIdentity,
  normalizeDefault,
  parsePostgresConnectionTarget,
  validateEmptyStateAuthorization,
  verifySignedEmptyStateReceipt,
} from "./webhook-empty-state-contract.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TABLE = 'public."WebhookEventTrack"'
const EVENT_TABLE = 'public."WebhookEvent"'
const LOCK = [1987654321, 2026100204]
const MARKER_PREFIX = "lyrashield:webhook-empty-state/v1:"
const EMPTY_STATE_PRODUCTION_PATH_ENABLED = false
const DEFAULT_ADVISORY_LOCK_WAIT_MS = 10_000
const DEFAULT_ADVISORY_LOCK_POLL_MS = 100
let contextUrl = ""

function fail(message) { throw new Error(message) }
function equal(actual, expected, message) { if (actual !== expected) fail(message) }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }

function migrationSql(migration) {
  const bytes = readFileSync(resolve(packageRoot, "prisma/migrations", migration.name, "migration.sql"))
  equal(sha256(bytes), migration.sha256, "Preserved migration bytes differ: " + migration.name)
  return bytes.toString("utf8")
}

function decodeSignedReceipt(env) {
  const encoded = env.WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64 || ""
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 32_768) {
    fail("Root-owned empty-state maintenance receipt is missing or invalid")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (!bytes.length || bytes.toString("base64") !== encoded) fail("Empty-state receipt encoding is not canonical")
  const serialized = bytes.toString("utf8")
  let receipt
  try { receipt = JSON.parse(serialized) }
  catch { fail("Root-owned empty-state maintenance receipt is missing or invalid") }
  if (JSON.stringify(receipt) !== serialized) fail("Empty-state receipt JSON is not canonical")
  const publicKeyPem = env.WEBHOOK_EMPTY_STATE_RECEIPT_PUBLIC_KEY_PEM || ""
  verifySignedEmptyStateReceipt(receipt, publicKeyPem)
  return { receipt, publicKeyPem }
}

function authorizationFor(context, env, now = Date.now()) {
  verifySignedEmptyStateReceipt(context.receipt, context.publicKeyPem)
  return validateEmptyStateAuthorization(context.receipt, {
    sourceSha: context.sourceSha,
    runId: context.runId,
    stableNonce: context.stableNonce,
    databaseIdentitySha256: context.identityHash,
    runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
    now,
  })
}

function requiredContext(env, now = Date.now()) {
  const rehearsal = env.WEBHOOK_EMPTY_STATE_REHEARSAL === "true"
  if (rehearsal) {
    if (env.WEBHOOK_EMPTY_STATE_CUTOVER !== undefined) fail("Local rehearsal and production cutover modes cannot be combined")
    if (env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") fail("Local rehearsal requires an explicitly disposable database")
  } else {
    if (env.WEBHOOK_EMPTY_STATE_CUTOVER !== "true") fail("Empty-state mode was not explicitly enabled")
    if (!EMPTY_STATE_PRODUCTION_PATH_ENABLED) {
      fail("Production empty-state migration is disabled until the trusted root-owned caller is integrated")
    }
  }
  const databaseUrl = assertMigrationUrlBinding(env)
  const target = parsePostgresConnectionTarget(databaseUrl, "migration database URL")
  if (target.port !== "5432") fail("Migration runner requires a direct or session-mode PostgreSQL connection on port 5432")
  let identity
  if (rehearsal) {
    if (!["localhost", "127.0.0.1", "::1"].includes(target.host) || target.database !== "postgres" || target.schema !== "public") {
      fail("Local rehearsal is restricted to loopback PostgreSQL")
    }
    identity = {
      provider: "supabase",
      projectRef: env.WEBHOOK_EMPTY_STATE_TEST_PROJECT_REF,
      database: "postgres",
      schema: "public",
    }
  } else identity = canonicalSupabaseDatabaseIdentity([databaseUrl])
  const identityHash = hashDatabaseIdentity(identity)
  equal(env.WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256, identityHash, "Migration database identity differs from the approved identity")
  const sourceSha = env.DEPLOY_SHA || ""
  const runId = env.GITHUB_RUN_ID || ""
  const stableNonce = env.WEBHOOK_EMPTY_STATE_STABLE_NONCE || ""
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail("Exact product source SHA is required")
  if (!/^\d+$/.test(runId)) fail("GitHub workflow run ID is required")
  const { receipt, publicKeyPem } = decodeSignedReceipt(env)
  const context = { databaseUrl, identity, identityHash, sourceSha, runId, stableNonce, receipt, publicKeyPem }
  context.authorization = authorizationFor(context, env, now)
  return context
}

function markerFor(context, state) {
  return MARKER_PREFIX + JSON.stringify({
    version: 1,
    mode: "empty-state",
    state,
    sourceSha: context.sourceSha,
    runId: context.runId,
    owner: context.authorization.owner,
    nonceSha256: sha256(context.stableNonce),
    databaseIdentitySha256: context.identityHash,
    rootReceiptSha256: context.authorization.rootReceiptSha256,
    workerStopReceiptSha256: context.authorization.workerStopReceiptSha256,
    admissionStopValueSha256: context.authorization.admissionStopValueSha256,
    zeroTrackRows: 0,
    zeroUnresolvedWebhookEvents: 0,
  })
}

async function setMarker(client, context, state, authorize) {
  authorize()
  const result = await client.query(
    "SELECT format('COMMENT ON COLUMN public.\"WebhookEventTrack\".\"nextAttemptAtUtc\" IS %L', $1::text) AS statement",
    [markerFor(context, state)],
  )
  authorize()
  await client.query(result.rows[0].statement)
}

async function readMarker(client) {
  const result = await client.query(
    "SELECT col_description('public.\"WebhookEventTrack\"'::regclass, a.attnum) AS marker " +
    "FROM pg_attribute a WHERE a.attrelid = 'public.\"WebhookEventTrack\"'::regclass " +
    "AND a.attname = 'nextAttemptAtUtc' AND NOT a.attisdropped",
  )
  const value = result.rows[0] && result.rows[0].marker
  if (typeof value !== "string" || !value.startsWith(MARKER_PREFIX)) return null
  try { return JSON.parse(value.slice(MARKER_PREFIX.length)) } catch { fail("Database progress marker is malformed; refusing recovery") }
}

function assertMarker(marker, context) {
  if (!marker) return
  const expected = {
    version: 1, mode: "empty-state", sourceSha: context.sourceSha, runId: context.runId,
    owner: context.authorization.owner, nonceSha256: sha256(context.stableNonce),
    databaseIdentitySha256: context.identityHash,
    rootReceiptSha256: context.authorization.rootReceiptSha256,
    workerStopReceiptSha256: context.authorization.workerStopReceiptSha256,
    admissionStopValueSha256: context.authorization.admissionStopValueSha256,
    zeroTrackRows: 0, zeroUnresolvedWebhookEvents: 0,
  }
  for (const [key, value] of Object.entries(expected)) equal(marker[key], value, "Database marker does not match this run: " + key)
  if (!["core-committed", "index-intent", "index-ready", "operator-columns", "complete"].includes(marker.state)) {
    fail("Database progress marker has an unknown state; refusing recovery")
  }
}

async function beginLocked(client, timeout, authorize) {
  authorize()
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
  await client.query("SET LOCAL lock_timeout = '10s'")
  await client.query("SET LOCAL statement_timeout = '" + (timeout || "5min") + "'")
  await client.query("SET LOCAL row_security = off")
  await client.query("SET LOCAL search_path = public, pg_temp")
  await client.query("LOCK TABLE " + EVENT_TABLE + " IN ACCESS EXCLUSIVE MODE")
  await client.query("LOCK TABLE " + TABLE + " IN ACCESS EXCLUSIVE MODE")
  authorize()
}

async function rollback(client) { try { await client.query("ROLLBACK") } catch {} }
async function transaction(client, work) {
  try { await work(); await client.query("COMMIT") }
  catch (error) { await rollback(client); throw error }
}

async function schema(client) {
  const result = await client.query(
    "SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS notnull, " +
    "pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a " +
    "LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum " +
    "WHERE a.attrelid='public.\"WebhookEventTrack\"'::regclass AND a.attnum>0 AND NOT a.attisdropped",
  )
  return new Map(result.rows.map((row) => [row.name, row]))
}

const BASELINE_COLUMNS = Object.freeze({
  id: ["text", true, null],
  webhookEventId: ["text", true, null],
  workspaceId: ["text", false, null],
  track: ["text", true, null],
  status: ["text", true, "'pending'::text"],
  attempts: ["integer", true, "0"],
  lastError: ["text", false, null],
  completedAt: ["timestamp(3) without time zone", false, null],
  createdAt: ["timestamp(3) without time zone", true, "CURRENT_TIMESTAMP"],
  updatedAt: ["timestamp(3) without time zone", true, null],
  generation: ["integer", true, "0"],
  nextAttemptAt: ["timestamp(3) without time zone", false, null],
  claimToken: ["text", false, null],
  leaseExpiresAt: ["timestamp(3) without time zone", false, null],
})

function expectedColumns(stage) {
  const expected = Object.fromEntries(Object.entries(BASELINE_COLUMNS).map(([name, value]) => [name, value.slice()]))
  if (stage !== "baseline") expected.nextAttemptAt = ["timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"]
  if (stage === "core" || stage === "complete") {
    expected.nextAttemptAtUtc = ["timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"]
    expected.leaseExpiresAtUtc = ["timestamp(3) with time zone", false, null]
  }
  if (stage === "complete") {
    expected.historicalAttempts = ["integer", true, "0"]
    expected.operatorRecoveryCount = ["integer", true, "0"]
  }
  return expected
}

async function assertColumnStage(client, stage) {
  const actual = await schema(client)
  const expected = expectedColumns(stage)
  if ([...actual.keys()].sort().join("\0") !== Object.keys(expected).sort().join("\0")) {
    fail("WebhookEventTrack column set differs from the exact " + stage + " schema")
  }
  for (const [name, [type, notnull, defaultValue]] of Object.entries(expected)) {
    const column = actual.get(name)
    if (!column || column.type !== type || column.notnull !== notnull || normalizeDefault(column.default) !== normalizeDefault(defaultValue)) {
      fail("WebhookEventTrack column contract differs at " + stage + ": " + name)
    }
  }
  return actual
}

async function assertEmpty(client) {
  const result = await client.query(
    "SELECT (SELECT count(*)::bigint FROM " + TABLE + ") AS tracks, " +
    "(SELECT count(*)::bigint FROM " + EVENT_TABLE + " WHERE processed=false) AS unresolved",
  )
  equal(String(result.rows[0].tracks), "0", "WebhookEventTrack contains rows; empty-state migration is ineligible")
  equal(String(result.rows[0].unresolved), "0", "Unresolved webhook events exist, including soft-deleted events")
}

async function history(client) {
  const check = await client.query("SELECT to_regclass('public._prisma_migrations') AS t")
  if (!check.rows[0].t) return new Map()
  const result = await client.query(
    "SELECT migration_name AS name, checksum, finished_at, rolled_back_at, started_at " +
    "FROM public.\"_prisma_migrations\" WHERE migration_name = ANY($1::text[])",
    [EXPECTED_EMPTY_MIGRATIONS.map((entry) => entry.name)],
  )
  return new Map(result.rows.map((row) => [row.name, row]))
}

async function resolveApplied(client, migration, authorize) {
  authorize()
  const existing = (await history(client)).get(migration.name)
  if (existing) {
    equal(existing.checksum, migration.sha256, "Prisma migration checksum differs: " + migration.name)
    if (!existing.finished_at || existing.rolled_back_at) fail("Prisma migration is partial or rolled back: " + migration.name)
    return
  }
  authorize()
  const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "resolve", "--applied", migration.name], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_DIRECT_URL: contextUrl, DATABASE_URL: contextUrl },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) fail("Prisma could not resolve applied migration " + migration.name)
  const row = (await history(client)).get(migration.name)
  if (!row || row.checksum !== migration.sha256 || !row.finished_at || row.rolled_back_at) {
    fail("Prisma migration history did not verify after resolve: " + migration.name)
  }
}

async function verifyUtc(client) {
  const columns = await schema(client)
  const legacy = columns.get("nextAttemptAt")
  const due = columns.get("nextAttemptAtUtc")
  const lease = columns.get("leaseExpiresAtUtc")
  if (!legacy || legacy.type !== "timestamp(3) without time zone" || normalizeDefault(legacy.default) !== "CURRENT_TIMESTAMP") {
    fail("Legacy due-time column does not have the exact PostgreSQL current-time default")
  }
  if (!due || due.type !== "timestamp(3) with time zone" || due.notnull || normalizeDefault(due.default) !== "CURRENT_TIMESTAMP") {
    fail("UTC due-time column differs from the exact timestamp/default contract")
  }
  if (!lease || lease.type !== "timestamp(3) with time zone" || lease.notnull || normalizeDefault(lease.default) !== null) {
    fail("UTC lease-expiry column differs from the exact timestamp/default contract")
  }
}

async function verifyIndex(client) {
  const result = await client.query(
    "SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique, am.amname AS method, " +
    "pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indpred,i.indrelid) AS predicate, " +
    "pg_get_expr(i.indexprs,i.indrelid) AS expression FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid " +
    "JOIN pg_am am ON am.oid=idx.relam WHERE idx.oid=to_regclass('public.\"WebhookEventTrack_status_nextAttemptAtUtc_idx\"')",
  )
  if (!result.rows.length) return false
  const index = result.rows[0]
  if (!index.valid || !index.ready) fail("Existing webhook UTC index is invalid; reviewed repair is required")
  if (index.unique || index.method !== "btree" || index.predicate || index.expression ||
      !/^CREATE INDEX .* ON public\.\"WebhookEventTrack\" USING btree \(status, \"nextAttemptAtUtc\"\)$/.test(index.definition)) {
    fail("Existing webhook UTC index does not match the required definition")
  }
  return true
}

async function createIndexConcurrently(client, authorize) {
  if (await verifyIndex(client)) return
  const active = await client.query(
    "SELECT 1 FROM pg_stat_progress_create_index p JOIN pg_class t ON t.oid=p.relid " +
    "WHERE t.oid='public.\"WebhookEventTrack\"'::regclass LIMIT 1",
  )
  if (active.rows.length) fail("An unknown webhook index build is active")
  await client.query("SET lock_timeout='10s'")
  await client.query("SET statement_timeout='10min'")
  authorize()
  await client.query("CREATE INDEX CONCURRENTLY \"WebhookEventTrack_status_nextAttemptAtUtc_idx\" ON " + TABLE + " (status, \"nextAttemptAtUtc\")")
  if (!(await verifyIndex(client))) fail("Concurrent index build returned without a verified index")
}

async function verifyHistory(client) {
  const rows = await history(client)
  for (const migration of EXPECTED_EMPTY_MIGRATIONS) {
    const row = rows.get(migration.name)
    if (!row || row.checksum !== migration.sha256 || !row.finished_at || row.rolled_back_at) {
      fail("Final Prisma migration history is incomplete: " + migration.name)
    }
  }
}

function verifyNoPendingMigrations() {
  const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "status"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_DIRECT_URL: contextUrl, DATABASE_URL: contextUrl },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) fail("Prisma reports pending, failed, or divergent migrations")
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function acquireAdvisoryLock(client, authorize, waitMs, pollMs) {
  const started = performance.now()
  while (true) {
    authorize()
    const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", LOCK)
    if (result.rows[0]?.acquired === true) return
    const elapsed = performance.now() - started
    if (elapsed >= waitMs) fail("Timed out waiting for the empty-state advisory lock")
    await delay(Math.min(pollMs, Math.max(1, waitMs - elapsed)))
  }
}

async function afterPhase(faultInjector, phase, client) {
  if (faultInjector) await faultInjector(phase, client)
}

export async function runEmptyStateMigration({
  env = process.env,
  ClientClass,
  clock = Date.now,
  faultInjector,
  advisoryLockWaitMs = DEFAULT_ADVISORY_LOCK_WAIT_MS,
  advisoryLockPollMs = DEFAULT_ADVISORY_LOCK_POLL_MS,
} = {}) {
  const context = requiredContext(env, clock())
  contextUrl = context.databaseUrl
  const authorize = () => { context.authorization = authorizationFor(context, env, clock()) }
  const statements = new Map(EXPECTED_EMPTY_MIGRATIONS.map((migration) => [migration.name, migrationSql(migration)]))
  const PgClient = ClientClass || (await import("pg")).Client
  const client = new PgClient({ connectionString: context.databaseUrl, application_name: "lyrashield-empty-state-migration", connectionTimeoutMillis: 10000 })
  let connected = false
  let lockHeld = false
  try {
    await client.connect()
    connected = true
    authorize()
    await acquireAdvisoryLock(client, authorize, advisoryLockWaitMs, advisoryLockPollMs)
    lockHeld = true
    authorize()
    const actual = await client.query("SELECT current_database() AS database, current_schema() AS schema")
    equal(actual.rows[0].database, context.identity.database, "Connected database differs from the validated identity")
    equal(actual.rows[0].schema, context.identity.schema, "Connected schema differs from the validated identity")
    let marker = await readMarker(client)
    assertMarker(marker, context)
    if (!marker) {
      const rows = await history(client)
      if ([...rows.values()].some((row) => row.finished_at || row.started_at)) fail("Prisma history exists without an owned empty-state marker")
      await assertColumnStage(client, "baseline")
      await transaction(client, async () => {
        await beginLocked(client, undefined, authorize)
        await assertColumnStage(client, "baseline")
        await assertEmpty(client)
        authorize()
        await client.query(statements.get(EXPECTED_EMPTY_MIGRATIONS[0].name))
        await assertColumnStage(client, "due")
        authorize()
        await client.query(statements.get(EXPECTED_EMPTY_MIGRATIONS[1].name))
        await assertColumnStage(client, "core")
        await verifyUtc(client)
        await setMarker(client, context, "core-committed", authorize)
      })
      await afterPhase(faultInjector, "core-committed", client)
      marker = await readMarker(client)
    }
    assertMarker(marker, context)
    const schemaStage = marker.state === "operator-columns" || marker.state === "complete" ? "complete" : "core"
    await assertColumnStage(client, schemaStage)
    await verifyUtc(client)
    if (marker.state === "complete") await verifyHistory(client)
    await assertColumnStage(client, schemaStage)
    await resolveApplied(client, EXPECTED_EMPTY_MIGRATIONS[0], authorize)
    await assertColumnStage(client, schemaStage)
    await resolveApplied(client, EXPECTED_EMPTY_MIGRATIONS[1], authorize)

    if (!["index-ready", "operator-columns", "complete"].includes(marker.state)) {
      if (marker.state !== "index-intent") {
        await transaction(client, async () => {
          await beginLocked(client, undefined, authorize)
          await assertEmpty(client)
          await assertColumnStage(client, "core")
          await setMarker(client, context, "index-intent", authorize)
        })
        marker = await readMarker(client)
        await afterPhase(faultInjector, "index-intent", client)
      }
      await assertColumnStage(client, "core")
      await verifyUtc(client)
      await createIndexConcurrently(client, authorize)
      await afterPhase(faultInjector, "index-created", client)
      await transaction(client, async () => {
        await beginLocked(client, undefined, authorize)
        await assertEmpty(client)
        await assertColumnStage(client, "core")
        if (!(await verifyIndex(client))) fail("Concurrent UTC index is missing")
        await setMarker(client, context, "index-ready", authorize)
      })
      marker = await readMarker(client)
      await afterPhase(faultInjector, "index-ready", client)
    } else if (!(await verifyIndex(client))) fail("Owned progress marker claims an index that is absent")
    await assertColumnStage(client, marker.state === "operator-columns" || marker.state === "complete" ? "complete" : "core")
    if (!(await verifyIndex(client))) fail("UTC index is not verified before migration reconciliation")
    await resolveApplied(client, EXPECTED_EMPTY_MIGRATIONS[2], authorize)

    if (!["operator-columns", "complete"].includes(marker.state)) {
      await transaction(client, async () => {
        await beginLocked(client, undefined, authorize)
        await assertEmpty(client)
        await assertColumnStage(client, "core")
        authorize()
        await client.query(statements.get(EXPECTED_EMPTY_MIGRATIONS[3].name))
        await assertColumnStage(client, "complete")
        await setMarker(client, context, "operator-columns", authorize)
      })
      marker = await readMarker(client)
      await afterPhase(faultInjector, "operator-columns", client)
    }
    await assertColumnStage(client, "complete")
    await verifyUtc(client)
    if (!(await verifyIndex(client))) fail("UTC index is not verified before migration reconciliation")
    await resolveApplied(client, EXPECTED_EMPTY_MIGRATIONS[3], authorize)
    await transaction(client, async () => {
      await beginLocked(client, undefined, authorize)
      await assertColumnStage(client, "complete")
      await verifyUtc(client)
      if (!(await verifyIndex(client))) fail("Final UTC index is absent")
      if (marker.state !== "complete") await assertEmpty(client)
      await verifyHistory(client)
      if (marker.state !== "complete") await setMarker(client, context, "complete", authorize)
    })
    if (marker.state !== "complete") await afterPhase(faultInjector, "complete", client)
    verifyNoPendingMigrations()
    return { status: "complete", databaseIdentitySha256: context.identityHash, migrationNames: EXPECTED_EMPTY_MIGRATIONS.map((entry) => entry.name) }
  } finally {
    if (lockHeld) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", LOCK) } catch {}
    }
    if (connected) await client.end()
    contextUrl = ""
  }
}

function safeError(error) {
  return String(error && error.message || error || "unknown error")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL redacted]")
    .slice(0, 500)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEmptyStateMigration().then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n")
  }).catch((error) => {
    process.stderr.write("Empty-state migration stopped: " + safeError(error) + "\n")
    process.exitCode = 1
  })
}
