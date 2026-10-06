import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  assertMigrationUrlBinding,
  createDisposablePostgresClient,
  canonicalSupabaseDatabaseIdentity,
  EXPECTED_EMPTY_MIGRATIONS,
  hashDatabaseIdentity,
  parseSupabaseDatabasePrincipal,
  assertSupabaseDatabasePrincipal,
  parsePostgresConnectionTarget,
  normalizeDefault,
  validateEmptyStateAuthorization,
  verifySignedEmptyStateReceipt,
} from "../webhook-empty-state-contract.mjs"
import { runEmptyStateMigration } from "../webhook-empty-state-migration.mjs"

const projectRef = "localprojectfixture1"
const direct = "postgresql://postgres:masked@db." + projectRef + ".supabase.co:5432/postgres?schema=public"
const pooler = "postgresql://postgres." + projectRef + ":masked@fixture.pooler.supabase.com:5432/postgres?schema=public"
const testProjectRef = "localtestprojectref1"
const testDatabaseUrl = "postgresql://postgres:masked@127.0.0.1:5432/postgres?schema=public"
const now = Date.parse("2026-10-04T12:00:00.000Z")
const sourceSha = "3f4916bc707a6e36495d2b77146160a67d821311"
const stableNonce = "0123456789abcdefghijklmnopqrstuvwx_ABC"
const identityHash = hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([direct]))
const testIdentityHash = hashDatabaseIdentity({ provider: "supabase", projectRef: testProjectRef, database: "postgres", schema: "public" })
const signingKeys = generateKeyPairSync("ed25519")
const publicKeyPem = signingKeys.publicKey.export({ type: "spki", format: "pem" })
const untrustedKeys = generateKeyPairSync("ed25519")
const untrustedPublicKeyPem = untrustedKeys.publicKey.export({ type: "spki", format: "pem" })

function signReceipt(receipt) {
  const unsigned = { ...receipt }
  delete unsigned.signature
  const signature = signBytes(null, Buffer.from(JSON.stringify(unsigned)), signingKeys.privateKey).toString("base64")
  return { ...unsigned, signature }
}

function validReceipt(overrides = {}) {
  return {
    schemaVersion: "webhook-empty-state-maintenance/v1",
    mode: "empty-state",
    sourceSha,
    runId: "37200000001",
    owner: "37200000001:1",
    stableNonce,
    databaseIdentitySha256: identityHash,
    migrationDatabaseIdentitySha256: identityHash,
    appDatabaseIdentitySha256: identityHash,
    workerDatabaseUrlIdentitySha256: identityHash,
    workerDatabaseSystemUrlIdentitySha256: identityHash,
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
    fallbackProtocol: "durable-claims/2",
    fallbackEvidenceSha256: "f".repeat(64),
    issuedAt: new Date(now - 60_000).toISOString(),
    nonterminalScans: 0,
    pendingQueueJobs: 0,
    activeWriterRevisions: 0,
    inFlightHandlers: 0,
    writersStopped: true,
    admissionHeld: true,
    fallbackVerified: true,
    redisContinuityVerified: true,
    appConnectionReadbackVerified: true,
    ...overrides,
  }
}

function validEnvironment(overrides = {}) {
  const receipt = signReceipt(validReceipt({
    databaseIdentitySha256: testIdentityHash,
    migrationDatabaseIdentitySha256: testIdentityHash,
    appDatabaseIdentitySha256: testIdentityHash,
    workerDatabaseUrlIdentitySha256: testIdentityHash,
    workerDatabaseSystemUrlIdentitySha256: testIdentityHash,
  }))
  return {
    WEBHOOK_EMPTY_STATE_REHEARSAL: "true",
    LYRASHIELD_TEST_DB_DISPOSABLE: "1",
    WEBHOOK_EMPTY_STATE_TEST_PROJECT_REF: testProjectRef,
    DATABASE_DIRECT_URL: testDatabaseUrl,
    DATABASE_URL: testDatabaseUrl,
    WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256: testIdentityHash,
    WEBHOOK_EMPTY_STATE_STABLE_NONCE: stableNonce,
    WEBHOOK_EMPTY_STATE_MAINTENANCE_RECEIPT_BASE64: Buffer.from(JSON.stringify(receipt)).toString("base64"),
    WEBHOOK_EMPTY_STATE_RECEIPT_PUBLIC_KEY_PEM: publicKeyPem,
    DEPLOY_SHA: sourceSha,
    GITHUB_RUN_ID: "37200000001",
    ...overrides,
  }
}

test("direct and project-bound Supavisor URLs canonicalize to one logical database", () => {
  assert.deepEqual(canonicalSupabaseDatabaseIdentity([direct, pooler]), {
    provider: "supabase", projectRef, database: "postgres", schema: "public",
  })
  const workerPooler = pooler.replace("postgres.", "worker_runtime.")
  assert.equal(parseSupabaseDatabasePrincipal(workerPooler), "worker_runtime")
  assert.equal(hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([direct])),
    hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([workerPooler])))
  assert.throws(() => assertSupabaseDatabasePrincipal(workerPooler, "postgres"), /principal differs/)
  assert.equal(assertSupabaseDatabasePrincipal(workerPooler, "worker_runtime"), "worker_runtime")
})

test("column default normalization preserves case inside SQL string literals", () => {
  assert.equal(normalizeDefault("('pending'::text)"), normalizeDefault("'pending'::TEXT"))
  assert.notEqual(normalizeDefault("'PENDING'::text"), normalizeDefault("'pending'::text"))
})

test("effective node-postgres target rejects query endpoint, credential, duplicate, and encoded-key overrides", () => {
  const attacks = [
    "host=other.invalid",
    "user=attacker",
    "port=6543",
    "password=attacker",
    "database=other",
    "%68ost=other.invalid",
    "%75ser=attacker",
    "options=-c%20search_path=private",
    "schema=public&schema=public",
    "sslmode=require&sslmode=verify-full",
    "uselibpqcompat=1",
    "%75selibpqcompat=1",
  ]
  for (const attack of attacks) {
    assert.throws(() => parsePostgresConnectionTarget(direct + "&" + attack), /unsupported|duplicate/, attack)
  }
  assert.equal(parsePostgresConnectionTarget(direct.replace("postgres:masked", "%70ostgres:masked")).user, "postgres")
})

test("migration endpoint never accepts a transaction-mode Supavisor port", async () => {
  let constructed = false
  class NeverConnect { constructor() { constructed = true } }
  const transactionPooler = pooler.replace(":5432/", ":6543/")
  await assert.rejects(runEmptyStateMigration({
    env: validEnvironment({
      DATABASE_DIRECT_URL: transactionPooler,
      DATABASE_URL: transactionPooler,
    }),
    ClientClass: NeverConnect,
  }), /port 5432/)
  assert.equal(constructed, false)
})

test("disposable rehearsal rejects effective host overrides before constructing an admin client", async () => {
  let constructed = false
  class NeverConnect { constructor() { constructed = true } }
  const hostile = "postgresql://postgres:masked@127.0.0.1:5432/postgres?schema=public&host=remote.invalid"
  assert.throws(() => createDisposablePostgresClient(hostile, NeverConnect), /unsupported or unsafe query parameter/)
  assert.equal(constructed, false)
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "webhook-empty-state-postgres-rehearsal.mjs"), "utf8")
  assert.ok(source.indexOf("createDisposablePostgresClient(databaseUrl") < source.indexOf("await admin.connect()"))
  assert.ok(source.indexOf("createDisposablePostgresClient(databaseUrl") < source.indexOf("DROP TABLE"))
})

test("signed maintenance receipt rejects tampering and an untrusted key", () => {
  const receipt = signReceipt(validReceipt())
  assert.equal(verifySignedEmptyStateReceipt(receipt, publicKeyPem), true)
  assert.throws(() => verifySignedEmptyStateReceipt({ ...receipt, admissionHeld: false }, publicKeyPem), /not trusted/)
  assert.throws(() => verifySignedEmptyStateReceipt(receipt, untrustedPublicKeyPem), /not trusted/)
})

test("Supavisor identity requires project ref in its username", () => {
  const unbound = "postgresql://postgres:masked@fixture.pooler.supabase.com:5432/postgres?schema=public"
  assert.throws(() => canonicalSupabaseDatabaseIdentity([unbound]), /username must bind/)
})

test("signed principal policy names independent expected roles", async () => {
  const { validateDatabasePrincipalPolicy } = await import("../webhook-empty-state-contract.mjs")
  const valid = {
    app: "worker_runtime",
    scanner: "scanner_runtime",
    worker: "worker_runtime",
    system: "system_admin",
    migration: "postgres",
  }
  assert.equal(validateDatabasePrincipalPolicy(valid), true)
  for (const changed of [
    { ...valid, worker: "system_admin" },
    { ...valid, system: "scanner_runtime" },
    { ...valid, migration: "invalid principal" },
    { ...valid, backup: "postgres" },
    { ...valid, system: valid.worker },
  ])
    assert.throws(() => validateDatabasePrincipalPolicy(changed))
})

test("rejects direct and pooler URLs bound to different projects", () => {
  const other = "postgresql://postgres.testprojectfixture99:masked@fixture.pooler.supabase.com:5432/postgres?schema=public"
  assert.throws(() => canonicalSupabaseDatabaseIdentity([direct, other]), /different Supabase projects/)
})

test("rejects a non-production database or schema", () => {
  assert.throws(() => canonicalSupabaseDatabaseIdentity([direct.replace("/postgres?", "/postgres_shadow?")]), /postgres\/public/)
  assert.throws(() => canonicalSupabaseDatabaseIdentity([direct.replace("schema=public", "schema=private")]), /postgres\/public/)
})

test("Prisma children require both URL variables to be the identical validated endpoint", () => {
  assert.equal(assertMigrationUrlBinding({ DATABASE_DIRECT_URL: direct, DATABASE_URL: direct }), direct)
  assert.throws(() => assertMigrationUrlBinding({ DATABASE_DIRECT_URL: direct, DATABASE_URL: pooler }), /must be the same/)
  assert.throws(() => assertMigrationUrlBinding({ DATABASE_URL: direct }), /must be the same/)
})

test("accepts only a fresh, matching, drained, stopped, image-bound maintenance receipt", () => {
  const result = validateEmptyStateAuthorization(validReceipt(), {
    sourceSha, runId: "37200000001", stableNonce, databaseIdentitySha256: identityHash, now,
  })
  assert.equal(result.mode, "empty-state")
  for (const change of [
    { mode: "historical" },
    { sourceSha: "0".repeat(40) },
    { runId: "37200000002" },
    { owner: "37200000001:2" },
    { stableNonce: "different_nonce_value_0123456789" },
    { databaseIdentitySha256: "d".repeat(64) },
    { appDatabaseIdentitySha256: "d".repeat(64) },
    { workerDatabaseSystemUrlIdentitySha256: "d".repeat(64) },
    { nonterminalScans: 1 },
    { pendingQueueJobs: 1 },
    { queueSchedulerCount: 1 },
    { repeatableJobCount: 1 },
    { activeWriterRevisions: 1 },
    { inFlightHandlers: 1 },
    { queueCounts: { ...validReceipt().queueCounts, scan: { ...validReceipt().queueCounts.scan, wait: 1 } } },
    { queueCounts: { ...validReceipt().queueCounts, scan: { ...validReceipt().queueCounts.scan, "waiting-children": 1 } } },
    { queueCounts: { scan: validReceipt().queueCounts.scan } },
    { writersStopped: false },
    { admissionHeld: false },
    { fallbackVerified: false },
    { redisContinuityVerified: false },
    { appConnectionReadbackVerified: false },
    { fallbackProtocol: "durable-claims/1" },
    { issuedAt: new Date(now - 31 * 60_000).toISOString() },
    { workerStopReceiptSha256: "bad" },
  ]) {
    assert.throws(() => validateEmptyStateAuthorization(validReceipt(change), {
      sourceSha, runId: "37200000001", stableNonce, databaseIdentitySha256: identityHash, now,
    }))
  }
})

test("migration runner refuses missing explicit mode and mismatched identity before connecting", async () => {
  let constructed = false
  class NeverConnect {
    constructor() { constructed = true }
  }
  await assert.rejects(runEmptyStateMigration({
    env: validEnvironment({ WEBHOOK_EMPTY_STATE_REHEARSAL: undefined, WEBHOOK_EMPTY_STATE_CUTOVER: "false" }),
    ClientClass: NeverConnect,
  }), /not explicitly enabled/)
  await assert.rejects(runEmptyStateMigration({
    env: validEnvironment({ WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256: "e".repeat(64) }),
    ClientClass: NeverConnect,
  }), /differs from the approved identity/)
  await assert.rejects(runEmptyStateMigration({
    env: validEnvironment({
      WEBHOOK_EMPTY_STATE_REHEARSAL: "true",
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      DATABASE_DIRECT_URL: direct,
      DATABASE_URL: direct,
    }),
    ClientClass: NeverConnect,
  }), /restricted to loopback PostgreSQL/)
  assert.equal(constructed, false)
})

test("production mode remains disabled until the trusted root-owned caller is integrated", async () => {
  let constructed = false
  class NeverConnect { constructor() { constructed = true } }
  await assert.rejects(runEmptyStateMigration({
    env: validEnvironment({ WEBHOOK_EMPTY_STATE_REHEARSAL: undefined, WEBHOOK_EMPTY_STATE_CUTOVER: "true" }),
    ClientClass: NeverConnect,
  }), /disabled until the trusted root-owned caller is integrated/)
  assert.equal(constructed, false)
})

test("receipt expiry while waiting for the advisory lock prevents all migration writes", async () => {
  let clockNow = now
  const seenQueries = []
  class WaitingClient {
    on() { return this }
    async connect() {}
    async query(sql) {
      seenQueries.push(sql)
      if (sql.includes("pg_try_advisory_lock")) {
        clockNow = now + 32 * 60_000
        return { rows: [{ acquired: false }] }
      }
      return { rows: [] }
    }
    async end() {}
  }
  await assert.rejects(runEmptyStateMigration({
    env: validEnvironment(),
    ClientClass: WaitingClient,
    clock: () => clockNow,
    advisoryLockWaitMs: 1000,
    advisoryLockPollMs: 1,
  }), /outside its 30-minute validity window/)
  assert.equal(seenQueries.some((query) => /ALTER TABLE|CREATE INDEX|COMMENT ON|pg_advisory_lock\(/i.test(query)), false)
})

test("all four historical Prisma migration files remain byte-for-byte pinned", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations")
  const { createHash } = await import("node:crypto")
  for (const migration of EXPECTED_EMPTY_MIGRATIONS) {
    const contents = await readFile(resolve(root, migration.name, "migration.sql"))
    assert.equal(createHash("sha256").update(contents).digest("hex"), migration.sha256, migration.name)
  }
})

test("runner uses exclusive locks and concurrent index creation; it does not delete data or indexes", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../webhook-empty-state-migration.mjs"), "utf8")
  assert.match(source, /BEGIN ISOLATION LEVEL READ COMMITTED/)
  assert.match(source, /row_security = off/)
  assert.match(source, /LOCK TABLE .*ACCESS EXCLUSIVE MODE/)
  assert.match(source, /CREATE INDEX CONCURRENTLY/)
  assert.doesNotMatch(source, /\\bDELETE\\s+FROM\\b|DROP\\s+INDEX/i)
  assert.doesNotMatch(source, /UPDATE\\s+public\\."?_prisma_migrations/i)
})
