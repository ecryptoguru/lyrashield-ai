// Enables only a copied runner in a disposable directory. Root storage,
// attestation and external cloud commands are explicit mocked boundaries;
// authorization, same-connection DB continuity, SQL and Prisma are real.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "pg"
import { fixture } from "./webhook-empty-state-v2-fixture.mjs"
import {
  createDisposablePostgresClient,
  EXPECTED_EMPTY_MIGRATIONS,
  hashDatabaseIdentity,
} from "../webhook-empty-state-contract.mjs"
import { canonical, sha256 } from "../webhook-empty-state-receipt-v2.mjs"

const disposableUrl = process.env.DATABASE_DIRECT_URL
assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
assert.equal(disposableUrl, process.env.DATABASE_URL)
// This check runs before any destructive query or copied production guard.
const admin = createDisposablePostgresClient(disposableUrl, Client)
const trustedUrl = process.env.LYRASHIELD_TRUSTED_FIXTURE_DATABASE_URL
const target = new URL(trustedUrl)
assert.equal(target.hostname, "db.yejmvtgsxniatmjbwplk.supabase.co")
assert.equal(target.port, "5432")
assert.equal(target.username, "postgres")
assert.equal(target.pathname, "/postgres")
assert.equal(target.password, "disposable-only")
assert.equal(process.env.LYRASHIELD_TRUSTED_FIXTURE_NETWORK, "isolated-docker-only")
assert.ok(process.env.LYRASHIELD_TRUSTED_FIXTURE_WRONG_CA_PATH)
const tlsProbe = new Client({ connectionString: trustedUrl })
await tlsProbe.connect()
const tlsState = await tlsProbe.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
assert.equal(tlsState.rows[0]?.ssl, true, "trusted Supabase-alias connection must negotiate verified TLS")
await tlsProbe.end()
const rejectsTls = async (connectionString) => {
  const client = new Client({ connectionString })
  try {
    await assert.rejects(client.connect())
  } finally {
    await client.end().catch(() => {})
  }
}
await rejectsTls(trustedUrl.replace(target.hostname, "wrong.invalid"))
const wrongCaProbe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import { Client } from "pg"
const client = new Client({
  connectionString: process.env.LYRASHIELD_TRUSTED_FIXTURE_DATABASE_URL,
})
try {
  await client.connect()
  await client.end()
  process.exitCode = 19
} catch {
  await client.end().catch(() => {})
  process.exitCode = 0
}`,
  ],
  {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: process.env.LYRASHIELD_TRUSTED_FIXTURE_WRONG_CA_PATH,
      PGSSLROOTCERT: process.env.LYRASHIELD_TRUSTED_FIXTURE_WRONG_CA_PATH,
      SSL_CERT_FILE: process.env.LYRASHIELD_TRUSTED_FIXTURE_WRONG_CA_PATH,
    },
  }
)
assert.equal(wrongCaProbe.error, undefined, wrongCaProbe.error?.message)
assert.equal(wrongCaProbe.status, 0, "wrong CA must reject the verified TLS connection")
const root = mkdtempSync(join(tmpdir(), "trusted-v2-disposable-"))
const db = join(root, "packages/db"),
  scripts = join(db, "scripts")
const originalDb = resolve(new URL("../..", import.meta.url).pathname)
const now = Date.parse("2026-10-05T09:01:00Z")
const { receipt, policy } = fixture()
const identity = hashDatabaseIdentity({
  provider: "supabase",
  projectRef: "yejmvtgsxniatmjbwplk",
  database: "postgres",
  schema: "public",
})
policy.databaseIdentitySha256 = identity
for (const name of Object.keys(receipt.evidence.database))
  receipt.evidence.database[name].identitySha256 = identity
policy.backup.databaseIdentitySha256 = identity
receipt.evidence.backup.databaseIdentitySha256 = identity
policy.restore.backupSha256 = sha256(canonical(policy.backup))
receipt.evidence.restore.backupSha256 = policy.restore.backupSha256
let externalFailed = false
try {
  mkdirSync(scripts, { recursive: true })
  cpSync(join(originalDb, "scripts"), scripts, { recursive: true })
  cpSync(join(originalDb, "prisma"), join(db, "prisma"), { recursive: true })
  for (const file of ["package.json", "prisma.config.ts"])
    cpSync(join(originalDb, file), join(db, file))
  symlinkSync(
    resolve(process.env.LYRASHIELD_FIXTURE_NODE_MODULES || join(originalDb, "node_modules")),
    join(db, "node_modules"),
    "dir"
  )
  writeFileSync(
    join(scripts, "fixture-root-store.mjs"),
    `export const ROOT=${JSON.stringify(root)}; export function readPolicy(){return globalThis.fixturePolicy} export function readRootFile(){return globalThis.fixtureReceipt}`
  )
  writeFileSync(
    join(scripts, "fixture-attestation.mjs"),
    `export function verifyAttestation(){globalThis.fixtureAttestationCalls++}`
  )
  writeFileSync(
    join(scripts, "fixture-process.mjs"),
    `import {spawnSync as actual} from 'node:child_process'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export function spawnSync(program,args,options){ if(program==='/usr/bin/node'){if(args[1]!=='continuity-external')throw Error('unsafe external mode');globalThis.fixtureExternalCalls++;return globalThis.fixtureExternalFailed?{status:1,stdout:''}:{status:0,stdout:'EMPTY_STATE_LIVE_CONTINUITY_MATCH\\n'}} if(program==='pnpm'){return actual(process.execPath,[require.resolve('prisma/build/index.js'),...args.slice(2)],options)}throw Error('Unexpected disposable boundary') }`
  )
  const runnerPath = join(scripts, "webhook-empty-state-migration.mjs")
  const runnerSource = readFileSync(runnerPath, "utf8")
    .replace(
      "const EMPTY_STATE_PRODUCTION_PATH_ENABLED = false",
      "const EMPTY_STATE_PRODUCTION_PATH_ENABLED = true"
    )
    .replace('from "./webhook-empty-state-root-store.mjs"', 'from "./fixture-root-store.mjs"')
    .replace('from "./webhook-empty-state-attestation.mjs"', 'from "./fixture-attestation.mjs"')
    .replace('from "node:child_process"', 'from "./fixture-process.mjs"')
  writeFileSync(runnerPath, runnerSource)
  globalThis.fixturePolicy = policy
  globalThis.fixtureReceipt = receipt
  globalThis.fixtureExternalCalls = 0
  globalThis.fixtureAttestationCalls = 0
  const { runEmptyStateMigration } = await import(pathToFileURL(runnerPath))
  const env = {
    DATABASE_DIRECT_URL: trustedUrl,
    DATABASE_URL: trustedUrl,
    WEBHOOK_EMPTY_STATE_CUTOVER: "true",
    WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256: identity,
    DEPLOY_SHA: policy.sourceSha,
    GITHUB_RUN_ID: policy.runId,
    WEBHOOK_EMPTY_STATE_STABLE_NONCE: policy.nonce,
  }
  await admin.connect()
  await admin.query(
    'DROP TABLE IF EXISTS public."Scan", public."WebhookEventTrack", public."WebhookEvent", public."_prisma_migrations" CASCADE'
  )
  await admin.query(
    'CREATE TABLE public."Scan" (id text PRIMARY KEY, status text NOT NULL, "deletedAt" timestamp(3))'
  )
  await admin.query(
    'CREATE TABLE public."WebhookEvent" (id text PRIMARY KEY, processed boolean NOT NULL DEFAULT false, "deletedAt" timestamp(3))'
  )
  await admin.query(
    `CREATE TABLE public."WebhookEventTrack" (id text PRIMARY KEY, "webhookEventId" text NOT NULL REFERENCES public."WebhookEvent"(id) ON DELETE CASCADE ON UPDATE CASCADE, "workspaceId" text, track text NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, "lastError" text, "completedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL, generation integer NOT NULL DEFAULT 0, "nextAttemptAt" timestamp(3), "claimToken" text, "leaseExpiresAt" timestamp(3), UNIQUE("webhookEventId",track), CONSTRAINT "WebhookEventTrack_generation_nonnegative" CHECK(generation>=0))`
  )
  for (const [name, columns] of [
    ["WebhookEventTrack_status_idx", "status"],
    ["WebhookEventTrack_track_status_idx", "track,status"],
    ["WebhookEventTrack_status_nextAttemptAt_idx", 'status,"nextAttemptAt"'],
  ])
    await admin.query(`CREATE INDEX "${name}" ON public."WebhookEventTrack" (${columns})`)
  await admin.query(
    'CREATE TABLE public."_prisma_migrations" (id varchar(36) PRIMARY KEY NOT NULL, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)'
  )
  for (const entry of readdirSync(join(db, "prisma/migrations"), { withFileTypes: true }).filter(
    (entry) => entry.isDirectory()
  )) {
    if (EXPECTED_EMPTY_MIGRATIONS.some((m) => m.name === entry.name)) continue
    const checksum = createHash("sha256")
      .update(readFileSync(join(db, "prisma/migrations", entry.name, "migration.sql")))
      .digest("hex")
    await admin.query(
      'INSERT INTO public."_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',
      [randomUUID(), checksum, entry.name]
    )
  }
  await admin.end()
  const result = await runEmptyStateMigration({ env, clock: () => now })
  assert.equal(result.status, "complete")
  assert.equal(result.completion.authorizationSha256, sha256(canonical(receipt.authorization)))
  assert.ok(
    globalThis.fixtureExternalCalls > 20,
    "Actual production authorization checks executed across SQL phases"
  )
  assert.equal((await runEmptyStateMigration({ env, clock: () => now })).status, "complete")
  policy.revoked = true
  await assert.rejects(runEmptyStateMigration({ env, clock: () => now }), /revoked|disabled/i)
  policy.revoked = false
  globalThis.fixtureExternalFailed = true
  await assert.rejects(
    runEmptyStateMigration({ env, clock: () => now }),
    /continuity observation failed/
  )
  globalThis.fixtureExternalFailed = false
  const writer = new Client({ connectionString: disposableUrl })
  await writer.connect()
  await assert.rejects(runEmptyStateMigration({ env, clock: () => now }), /writers/)
  await writer.query('INSERT INTO public."Scan" (id,status,"deletedAt") VALUES ($1,$2,now())', [
    "hidden-live",
    "RUNNING",
  ])
  await writer.end()
  await assert.rejects(runEmptyStateMigration({ env, clock: () => now }), /scans/)
  assert.ok(globalThis.fixtureAttestationCalls >= 4)
  process.stdout.write(
    "Enabled copied trusted-v2 runner passed real PG17/Prisma fresh + retry + lock continuity + revoked/external/writer/soft-delete negatives; cloud/root/attestation boundaries mocked, no production access\n"
  )
} finally {
  await admin.end().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
