import test from "node:test"
import assert from "node:assert/strict"
import { readCanaryConfig, preflight, runCanary } from "../cold-unpaid-canary.mjs"

const product = "a".repeat(40)
const engine = "b".repeat(40)
const digest = `sha256:${"c".repeat(64)}`
const checksum = "d".repeat(64)
const env = {
  LYRASHIELD_CANARY_API_KEY: `lsk_${"x".repeat(43)}`,
  LYRASHIELD_CANARY_WORKSPACE_ID: "workspace1",
  LYRASHIELD_CANARY_TARGET_ID: "target1",
  LYRASHIELD_CANARY_TARGET_URL: "https://example.test/",
  LYRASHIELD_CANARY_RUN_ID: "1234",
  LYRASHIELD_CANARY_PRODUCT_REVISION: product,
  LYRASHIELD_CANARY_ENGINE_REVISION: engine,
  LYRASHIELD_CANARY_WORKER_DIGEST: digest,
  LYRASHIELD_CANARY_PROOF_COMMAND: "/usr/bin/true",
}
const config = readCanaryConfig(env)
const target = { id: "target1", type: "WEB_APP", status: "active", url: "https://example.test/" }
const ok = (data) => ({ ok: true, json: async () => ({ success: true, data }) })
function fixture({ changedTarget = target, postFails = false, status = "COMPLETED" } = {}) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes("/targets?")) return ok({ items: [changedTarget], nextCursor: null })
    if (url.includes("/eligibility?")) return ok({ allowed: true })
    if (opts.method === "POST") {
      if (postFails) throw new Error("network ambiguity")
      return ok({ id: "scan1", operationId: "operation1" })
    }
    return ok({ id: "scan1", workspaceId: "workspace1", status, resultManifest: { checksum } })
  }
  const proof = async (_config, p) => ({
    version: 1,
    result: "MATCH",
    scanId: p.scanId,
    operationId: p.operationId,
    checksum: p.checksum,
    productRevision: p.productRevision,
    engineRevision: p.engineRevision,
    workerDigest: p.workerDigest,
  })
  return { fetchImpl, proof, calls }
}

test("admits one authenticated SAFE scan and binds proof to its release", async () => {
  const f = fixture()
  const result = await runCanary(config, f)
  assert.equal(result.workspaceId, "workspace1")
  assert.equal(result.proofPayload.idempotencyKey, `cold-canary:1234:${product}`)
  const posts = f.calls.filter((x) => x.opts.method === "POST")
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].opts.body), {
    workspaceId: "workspace1",
    targetId: "target1",
    goal: "TEST_APP",
    mode: "SAFE",
  })
  assert.equal(posts[0].opts.headers["Idempotency-Key"], result.proofPayload.idempotencyKey)
  assert.ok(
    f.calls.every(
      (x) => x.url.startsWith("https://app.lyrashieldai.com/") && x.opts.redirect === "error"
    )
  )
})

test("rejects an unapproved target before submitting", async () => {
  const f = fixture({ changedTarget: { ...target, type: "REPO" } })
  await assert.rejects(() => runCanary(config, f), /CANARY_TARGET_MISMATCH/)
  assert.equal(f.calls.filter((x) => x.opts.method === "POST").length, 0)
})

test("unknown POST outcome never retries", async () => {
  const f = fixture({ postFails: true })
  await assert.rejects(() => runCanary(config, f), /OUTCOME_UNKNOWN/)
  assert.equal(f.calls.filter((x) => x.opts.method === "POST").length, 1)
})

test("failed terminal result and wrong worker receipt fail closed", async () => {
  const failed = fixture({ status: "FAILED" })
  await assert.rejects(() => runCanary(config, failed), /CANARY_SCAN_NOT_COMPLETED/)
  const wrong = fixture()
  wrong.proof = async (_c, p) => ({
    version: 1,
    result: "MATCH",
    scanId: p.scanId,
    operationId: p.operationId,
    checksum: p.checksum,
    productRevision: p.productRevision,
    engineRevision: p.engineRevision,
    workerDigest: `sha256:${"0".repeat(64)}`,
  })
  await assert.rejects(() => runCanary(config, wrong), /CANARY_PROOF_MISMATCH/)
})

test("only read-only proof is retried while accounting finalizes", async () => {
  const f = fixture()
  const real = f.proof
  let attempts = 0
  f.proof = async (...args) => {
    if (++attempts === 1) throw new Error("not ready")
    return real(...args)
  }
  f.wait = async () => {}
  await runCanary(config, f)
  assert.equal(attempts, 2)
  assert.equal(f.calls.filter((x) => x.opts.method === "POST").length, 1)
})

test("configuration and paginated target lookup fail closed", async () => {
  assert.throws(
    () =>
      readCanaryConfig({
        ...env,
        LYRASHIELD_CANARY_TARGET_URL: "https://name:secret@example.test/",
      }),
    /CANARY_TARGET_URL_INVALID/
  )
  assert.throws(
    () => readCanaryConfig({ ...env, LYRASHIELD_CANARY_PROOF_COMMAND: "sh -c nope" }),
    /CANARY_PROOF_COMMAND_MISSING/
  )
  let n = 0
  await assert.rejects(
    () =>
      preflight(config, async () => {
        n++
        return ok({ items: [], nextCursor: "same" })
      }),
    /CANARY_TARGET_CURSOR_INVALID/
  )
  assert.equal(n, 2)
})
