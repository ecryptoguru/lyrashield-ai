import test from "node:test"
import assert from "node:assert/strict"
import {
  connectionObservation,
  redisObservation,
  schedulingObservation,
} from "./webhook-empty-state-observer.mjs"
import {
  validateProducerRequest,
  PRODUCTION_CUTOVER_ENABLED,
} from "./webhook-empty-state-producer.mjs"
import { advancePhase, PHASES } from "./webhook-empty-state-phases.mjs"
import { canonical, STATES } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const sourceSha = "a".repeat(40),
  policy = { runId: "1", originalAttempt: 1, sourceSha, nonce: "n".repeat(40) }
test("production producer remains hard-disabled and rejects JSON, counts or paths", () => {
  assert.equal(PRODUCTION_CUTOVER_ENABLED, false)
  assert.equal(
    validateProducerRequest(["collect", "1", "1", sourceSha, policy.nonce], policy).phase,
    "collect"
  )
  for (const extra of ['{"verified":true}', "/tmp/key.pem", "0"])
    assert.throws(() =>
      validateProducerRequest(["collect", "1", "1", sourceSha, policy.nonce, extra], policy)
    )
  for (const phase of ["rollback", "delete-queue", "replay-payments", "arbitrary-command"])
    assert.throws(() => validateProducerRequest([phase, "1", "1", sourceSha, policy.nonce], policy))
})
test("runtime connection observations reject endpoint overrides and transaction migration", () => {
  const url =
    "postgresql://postgres.yejmvtgsxniatmjbwplk:placeholder@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require"
  assert.match(
    connectionObservation(url, "worker", "2026-10-05T09:00:00Z").identitySha256,
    /^[a-f0-9]{64}$/
  )
  assert.throws(() =>
    connectionObservation(url + "&host=db.other.supabase.co", "worker", "2026-10-05T09:00:00Z")
  )
  assert.throws(() =>
    connectionObservation(url.replace(":5432", ":6543"), "migration", "2026-10-05T09:00:00Z", true)
  )
})
test("Redis observation binds exact owned admission and rejects foreign stop", () => {
  const stop = {
    operator: "github-actions",
    reason: "webhook-empty-state",
    owner: "1:1",
    runId: "1",
  }
  assert.equal(
    redisObservation("rediss://placeholder@example.test:6379/0", canonical(stop), "1:1").owner,
    "1:1"
  )
  assert.throws(() =>
    redisObservation("rediss://placeholder@example.test:6379/0", canonical(stop), "2:1")
  )
})
test("raw SQL sees soft-deleted scheduling state and collects all three queues/six states", async () => {
  let sql
  const client = {
    query: async (query) => {
      sql = query
      return { rows: [{ scans: "0", handlers: "0", tracks: "0", parents: "1" }] }
    },
  }
  const queues = Object.fromEntries(
    ["scan", "webhookTrackRetry", "fixGenerate"].map((name) => [
      name,
      {
        getJobCounts: async (...states) => {
          assert.deepEqual(states, STATES)
          return Object.fromEntries(STATES.map((state) => [state, 0]))
        },
        getJobSchedulersCount: async () => 0,
        getRepeatableJobs: async () => [],
      },
    ])
  )
  const observed = await schedulingObservation(client, queues)
  assert.equal(observed.unresolvedParents, 1)
  assert.equal(Object.keys(observed.queues).length, 3)
  assert.doesNotMatch(sql, /deletedAt|DELETE|UPDATE/)
})
test("dangling or valid symlink fence fails closed", async () => {
  const { mkdtempSync, symlinkSync, rmSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { fencePresent } = await import("./webhook-empty-state-startup-fence.mjs")
  const directory = mkdtempSync(join(tmpdir(), "empty-state-fence-"))
  try {
    const path = join(directory, "fence.json")
    symlinkSync(join(directory, "absent"), path)
    assert.throws(() => fencePresent(path), /symlink/)
    rmSync(path)
    writeFileSync(path, "{}")
    assert.equal(fencePresent(path), true)
    rmSync(path)
    assert.equal(fencePresent(path), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})
test("phase progression preserves immutable authorization and rejects skips or rollback", () => {
  const now = Date.parse("2026-10-05T09:00:00Z"),
    H = "a".repeat(64)
  const authorization = {
    ...policy,
    owner: "1:1",
    issuedAt: "2026-10-05T09:00:00Z",
    expiresAt: "2026-10-05T09:30:00Z",
    repositoryId: "1286618458",
    ownerId: "116722580",
    policySha256: H,
    producerSha256: H,
    workflowSha: sourceSha,
  }
  const approved = { ...authorization, enabled: true, revoked: false }
  let state
  for (const phase of PHASES) {
    state = advancePhase(state, phase, authorization, approved, now)
    assert.equal(
      advancePhase(state, phase, authorization, approved, now).authorizationSha256,
      state.authorizationSha256
    )
  }
  assert.throws(
    () => advancePhase(state, "preflight", authorization, approved, now),
    /skipped|rollback/
  )
  assert.throws(() => advancePhase(undefined, "migrate", authorization, approved, now))
  assert.throws(() =>
    advancePhase(state, "resume", authorization, { ...approved, revoked: true }, now)
  )
  assert.throws(() =>
    advancePhase(state, "resume", { ...authorization, nonce: "x".repeat(40) }, approved, now)
  )
})
