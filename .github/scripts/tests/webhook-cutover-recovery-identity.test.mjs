import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  appendWebhookRecoveryCandidate,
  assertWebhookCutoverWorkerIdentity,
} from "../../../ops/worker/webhook-cutover-recovery.mjs"

const ownerRunId = "123456789"
const owner = `${ownerRunId}:1`
const sourceRevision = "a".repeat(40)
const recoverySource = "b".repeat(40)
const engineRevision = "c".repeat(40)
const originalImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${sourceRevision}@sha256:${"d".repeat(64)}`
const recoveryImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${recoverySource}@sha256:${"e".repeat(64)}`
const env = {
  DATABASE_URL: "postgresql://worker@db.example/lyra",
  DATABASE_SYSTEM_URL: "postgresql://system@db.example/lyra",
  REDIS_URL: "rediss://cache.example/0",
}
const hash = (value) => createHash("sha256").update(value).digest("hex")

function originalReceipt() {
  return {
    owner,
    runId: ownerRunId,
    productRevision: sourceRevision,
    admissionStopValue: JSON.stringify({
      operator: "github-actions",
      reason: "webhook-claims-cutover",
      owner,
      runId: ownerRunId,
      productRevision: sourceRevision,
    }),
    phase: "claimed",
    attempts: [1, 2],
    lastAttempt: 2,
    previousWorkerImage: originalImage,
    candidateWorkerImage: originalImage,
    candidateProductRevision: sourceRevision,
    candidateEngineRevision: engineRevision,
    candidateWebhookTrackClaimProtocol: "durable-claims/2",
    databaseUrlSha256: hash(env.DATABASE_URL),
    databaseSystemUrlSha256: hash(env.DATABASE_SYSTEM_URL),
    redisUrlSha256: hash(env.REDIS_URL),
  }
}

function recoveryCandidate(overrides = {}) {
  return {
    recoveryRunId: "987654321",
    recoveryAttempt: 1,
    sourceRevision: recoverySource,
    engineRevision,
    workerImage: recoveryImage,
    protocol: "durable-claims/2",
    ...overrides,
  }
}

test("recovery candidate is appended without rewriting original owner, source, token, or attempt history", () => {
  const receipt = originalReceipt()
  const immutable = {
    owner: receipt.owner,
    runId: receipt.runId,
    productRevision: receipt.productRevision,
    admissionStopValue: receipt.admissionStopValue,
    attempts: [...receipt.attempts],
    lastAttempt: receipt.lastAttempt,
  }

  const updated = appendWebhookRecoveryCandidate(receipt, recoveryCandidate())

  assert.deepEqual(
    {
      owner: updated.owner,
      runId: updated.runId,
      productRevision: updated.productRevision,
      admissionStopValue: updated.admissionStopValue,
      attempts: updated.attempts,
      lastAttempt: updated.lastAttempt,
    },
    immutable,
  )
  assert.deepEqual(updated.recoveryCandidates, [recoveryCandidate()])
  assert.deepEqual(receipt.recoveryCandidates, undefined)
})

test("recovery candidate append is idempotent only for the same run attempt and exact digest", () => {
  const withCandidate = appendWebhookRecoveryCandidate(originalReceipt(), recoveryCandidate())
  const repeated = appendWebhookRecoveryCandidate(withCandidate, recoveryCandidate())
  assert.equal(repeated, withCandidate)

  assert.throws(
    () =>
      appendWebhookRecoveryCandidate(
        withCandidate,
        recoveryCandidate({ workerImage: `${recoveryImage.slice(0, -64)}${"f".repeat(64)}` }),
      ),
    /cannot be changed/,
  )
})

test("a superseded recovery invocation cannot be reactivated", () => {
  const first = recoveryCandidate()
  const second = recoveryCandidate({
    recoveryRunId: "987654322",
    workerImage: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${recoverySource}@sha256:${"f".repeat(64)}`,
  })
  const receipt = appendWebhookRecoveryCandidate(
    appendWebhookRecoveryCandidate(originalReceipt(), first),
    second,
  )
  assert.throws(() => appendWebhookRecoveryCandidate(receipt, first), /superseded/)
  assert.throws(
    () =>
      appendWebhookRecoveryCandidate(
        receipt,
        { ...first, recoveryAttempt: first.recoveryAttempt + 1 },
      ),
    /superseded/,
  )
})

test("worker identity requires exact recovery source, engine, digest, protocol, and connection hashes", () => {
  const receipt = appendWebhookRecoveryCandidate(originalReceipt(), recoveryCandidate())
  const identity = {
    receipt,
    workerImage: recoveryImage,
    productRevision: recoverySource,
    engineRevision,
    workerDigest: `sha256:${"e".repeat(64)}`,
    protocol: "durable-claims/2",
    environment: env,
  }

  assert.equal(assertWebhookCutoverWorkerIdentity(identity), true)
  assert.throws(
    () => assertWebhookCutoverWorkerIdentity({ ...identity, productRevision: sourceRevision }),
    /recovery candidate/,
  )
  assert.throws(
    () => assertWebhookCutoverWorkerIdentity({ ...identity, engineRevision: "f".repeat(40) }),
    /recovery candidate/,
  )
  assert.throws(
    () => assertWebhookCutoverWorkerIdentity({ ...identity, workerDigest: `sha256:${"f".repeat(64)}` }),
    /digest or protocol/,
  )
  assert.throws(
    () => assertWebhookCutoverWorkerIdentity({ ...identity, protocol: "durable-claims/1" }),
    /recovery candidate/,
  )
  assert.throws(
    () => assertWebhookCutoverWorkerIdentity({ ...identity, environment: { ...env, REDIS_URL: "redis://other/0" } }),
    /identity changed/,
  )
})

test("normal first-cutover worker still binds to the original source and candidate digest", () => {
  assert.equal(
    assertWebhookCutoverWorkerIdentity({
      receipt: originalReceipt(),
      workerImage: originalImage,
      productRevision: sourceRevision,
      engineRevision,
      workerDigest: `sha256:${"d".repeat(64)}`,
      protocol: "durable-claims/2",
      environment: env,
    }),
    true,
  )
  assert.throws(
    () =>
      assertWebhookCutoverWorkerIdentity({
        receipt: originalReceipt(),
        workerImage: originalImage,
        productRevision: recoverySource,
        engineRevision,
        workerDigest: `sha256:${"d".repeat(64)}`,
        protocol: "durable-claims/2",
        environment: env,
      }),
    /original cutover candidate/,
  )
})

test("recovery identity rejects malformed or altered primary receipt and bounds history", () => {
  const wrongOwner = originalReceipt()
  wrongOwner.owner = "987654321:1"
  assert.throws(() => appendWebhookRecoveryCandidate(wrongOwner, recoveryCandidate()))

  const wrongToken = originalReceipt()
  wrongToken.admissionStopValue = JSON.stringify({ owner: "foreign" })
  assert.throws(() => appendWebhookRecoveryCandidate(wrongToken, recoveryCandidate()))

  let receipt = originalReceipt()
  for (let i = 0; i < 8; i += 1) {
    receipt = appendWebhookRecoveryCandidate(
      receipt,
      recoveryCandidate({ recoveryRunId: String(987654321 + i) }),
    )
  }
  assert.throws(
    () =>
      appendWebhookRecoveryCandidate(
        receipt,
        recoveryCandidate({ recoveryRunId: "987654329" }),
      ),
    /history is full/,
  )
})
