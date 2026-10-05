import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buildSyntheticReceipt } from "../../../approval-fixtures/disposable-attestation.mjs"
import { validateReceipt } from "../../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"

const now = Date.parse("2026-10-05T05:00:00Z")
const metadata = {
  sourceSha: "b".repeat(40),
  workflowSha: "c".repeat(40),
  runId: "9988776655",
  originalAttempt: 2,
  actorId: "42",
  workflowBytes: readFileSync(
    new URL("../../workflows/webhook-empty-state-trusted-attestation.yml", import.meta.url),
    "utf8"
  ),
}

test("synthetic issuance receipt satisfies full v2 contract with exact fresh ownership", () => {
  const { receipt, policy } = buildSyntheticReceipt(metadata, now)
  assert.equal(Object.hasOwn(receipt.authorization, "workflowFileSha256"), false)
  assert.equal(receipt.authorization.owner, "9988776655:2")
  assert.equal(receipt.evidence.redis.owner, receipt.authorization.owner)
  assert.equal(receipt.evidence.worker.stopOwner, receipt.authorization.owner)
  assert.equal(receipt.evidence.observedAt, receipt.authorization.issuedAt)
  assert.equal(Object.keys(receipt.authorization).length, 12)
  assert.doesNotThrow(() => validateReceipt(receipt, policy, now + 1000))
  assert.throws(() => validateReceipt(receipt, policy, now + 600000), /Expired/)
})

test("full contract rejects stale or foreign synthetic observations before issuance", () => {
  for (const mutate of [
    (r) => {
      r.evidence.observedAt = new Date(now - 1000).toISOString()
    },
    (r) => {
      r.evidence.redis.owner = "123:1"
    },
    (r) => {
      r.evidence.worker.stopOwner = "123:1"
    },
    (r) => {
      r.authorization.workflowFileSha256 = "a".repeat(64)
    },
  ]) {
    const { receipt, policy } = buildSyntheticReceipt(metadata, now)
    mutate(receipt)
    assert.throws(() => validateReceipt(receipt, policy, now))
  }
})
