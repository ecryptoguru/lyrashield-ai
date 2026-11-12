import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const hash = (s) => createHash("sha256").update(s).digest("hex")
const product = "a".repeat(40),
  engine = "b".repeat(40),
  digest = `sha256:${"c".repeat(64)}`
const url = "https://example.test/"
const script = await readFile(
  fileURLToPath(new URL("../cold-unpaid-canary-proof.mjs", import.meta.url)),
  "utf8"
)
const dir = await mkdtemp(join(tmpdir(), "lyra-canary-proof-test-"))
const mockPath = join(dir, "db.mjs")
const loaderPath = join(dir, "loader.mjs")
await writeFile(
  mockPath,
  `import {createHash} from "node:crypto";import {isDeepStrictEqual} from "node:util";
const f=JSON.parse(process.env.FIXTURE), tx={scan:{findFirst:async()=>f.scan},target:{findFirst:async()=>f.target},agentOperation:{findFirst:async()=>f.operation},apiKey:{findFirst:async()=>f.key},workspaceMember:{findFirst:async()=>f.member},scanCapacityReservation:{findUnique:async()=>f.reservation},scanEvent:{count:async()=>f.billableEvents},usageRecord:{count:async()=>f.billedUsage}};
export const prisma={$disconnect:async()=>{}}; export async function withWorkspaceRLS(ws,fn,opts){if(ws!=="workspace1" || (opts && opts.accountId!=="founder1"))throw Error();return fn(tx)};
export function verifyStoredScanExecutionPlan(plan,hash){return {ok:hash===f.planHash,plan}};
export function verifyStoredManifestChecksum(s){return createHash("sha256").update(s.checksumInput).digest("hex")===s.checksum&&isDeepStrictEqual(JSON.parse(s.checksumInput),s.manifest)?"MATCH":"MISMATCH"}`
)
await writeFile(
  loaderPath,
  `import {pathToFileURL} from "node:url";export async function resolve(s,c,n){if(s==="@lyrashield/db")return {url:pathToFileURL(${JSON.stringify(mockPath)}).href,shortCircuit:true};return n(s,c)}`
)
test.after(async () => rm(dir, { recursive: true, force: true }))

function fixture() {
  const plan = {
    targetType: "WEB_APP",
    workflow: "REVIEW_TARGET",
    limits: { maxBudgetUsd: 0, maxEngineMs: 0 },
    capabilities: ["url"],
  }
  const manifest = {
    target: { id: "target1", type: "WEB_APP", urlChecksum: hash(JSON.stringify(url)) },
    engineExecution: null,
    terminalOutcome: { status: "COMPLETED" },
    workerExecution: {
      productRevision: product,
      engineRevision: engine,
      workerImageDigest: digest,
    },
    coverage: [
      { controlId: "url", status: "COMPLETED" },
      { controlId: "engine", status: "NOT_APPLICABLE" },
    ],
  }
  return {
    scan: {
      id: "scan1",
      targetId: "target1",
      status: "COMPLETED",
      mode: "SAFE",
      goal: "TEST_APP",
      accountingVersion: 2,
      sponsorAccountId: "founder1",
      createdById: "founder1",
      executionPlan: plan,
      executionPlanHash: "planhash",
      llmRequestCount: 0,
      providerCostUsd: null,
      billedCostUsd: null,
      coverageReceipts: manifest.coverage,
      resultManifest: { manifest },
    },
    target: { id: "target1", type: "WEB_APP", status: "active", url },
    operation: {
      principalType: "API_KEY",
      principalId: "key1",
      operationName: "scan.create",
      idempotencyKey: `cold-canary:1234:${product}`,
      status: "COMPLETED",
      resultReference: "scan1",
    },
    key: { createdById: "founder1", scopes: ["write"], expiresAt: null },
    member: { role: "OWNER" },
    reservation: {
      accountId: "founder1",
      workspaceId: "workspace1",
      userId: "founder1",
      state: "RELEASED",
      stoppedAt: "2026-01-01",
      fundedMinutes: 0,
      poolMinutes: 0,
      packMinutes: 0,
      graceMinutes: 0,
      overageMinutes: 0,
      chargedMinutes: 0,
    },
    billableEvents: 0,
    billedUsage: 0,
    planHash: "planhash",
  }
}
function run(f, corrupt = false) {
  const m = f.scan.resultManifest
  m.checksumInput = JSON.stringify(m.manifest)
  m.checksum = hash(m.checksumInput)
  const p = {
    version: 1,
    workspaceId: "workspace1",
    targetId: "target1",
    targetUrl: url,
    scanId: "scan1",
    operationId: "operation1",
    idempotencyKey: `cold-canary:1234:${product}`,
    checksum: m.checksum,
    productRevision: product,
    engineRevision: engine,
    workerDigest: digest,
  }
  if (corrupt) m.checksumInput += " "
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loaderPath,
      "--input-type=module",
      "-",
      Buffer.from(JSON.stringify(p)).toString("base64url"),
    ],
    {
      input: script,
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE: JSON.stringify(f),
        LYRASHIELD_PRODUCT_REVISION: product,
        LYRASHIELD_ENGINE_REVISION: engine,
        LYRASHIELD_WORKER_IMAGE_DIGEST: digest,
      },
    }
  )
}

test("worker proof verifies the checksum, identity, owner and unmetered reservation", () => {
  const result = run(fixture())
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result, "MATCH")
})

test("worker proof rejects corrupt evidence and altered release provenance", () => {
  assert.notEqual(run(fixture(), true).status, 0)
  const f = fixture()
  f.scan.resultManifest.manifest.workerExecution.workerImageDigest = `sha256:${"0".repeat(64)}`
  assert.notEqual(run(f).status, 0)
})

test("worker proof rejects paid plans, billable claims and funded reservations", () => {
  for (const mutate of [
    (f) => {
      f.scan.executionPlan.capabilities.push("engine")
    },
    (f) => {
      f.billableEvents = 1
    },
    (f) => {
      f.billedUsage = 1
    },
    (f) => {
      f.reservation.fundedMinutes = 1
    },
    (f) => {
      f.reservation.state = "RUNNING"
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.notEqual(run(f).status, 0)
  }
})

test("worker proof rejects wrong sponsor, operation, and incomplete URL coverage", () => {
  for (const mutate of [
    (f) => {
      f.scan.sponsorAccountId = "other"
    },
    (f) => {
      f.operation.resultReference = "other"
    },
    (f) => {
      f.scan.resultManifest.manifest.coverage[0].status = "PARTIAL"
    },
    (f) => {
      f.key.scopes = ["read"]
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.notEqual(run(f).status, 0)
  }
})
