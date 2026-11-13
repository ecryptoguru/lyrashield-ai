import test from "node:test"
import assert from "node:assert/strict"
import {
  advanceV26CutoverReceipt,
  assertV26CutoverReceipt,
  createV26CutoverReceipt,
} from "../v26-cutover-receipt.mjs"

const identity = {
  runId: "123",
  attempt: 1,
  owner: "123:1",
  sourceRevision: "a".repeat(40),
  engineRevision: "b".repeat(40),
  workerDigest: `sha256:${"c".repeat(64)}`,
  webDigest: `sha256:${"d".repeat(64)}`,
  databaseIdentity: "e".repeat(64),
  redisIdentity: "f".repeat(64),
}

const proofs = {
  CLAIMED: { ownedStop: true },
  QUIESCED: {
    ownedStop: true,
    writersStopped: true,
    workerStopped: true,
    stopProvenance: true,
    queuesEmpty: true,
  },
  INVENTORIED: {
    ownedStop: true,
    writersStopped: true,
    workerStopped: true,
    queuesEmpty: true,
    accountingClear: true,
  },
  MIGRATED: {
    ownedStop: true,
    writersStopped: true,
    workerStopped: true,
    migrationVerified: true,
    rolesVerified: true,
    seedsVerified: true,
  },
  VERIFIED: {
    ownedStop: true,
    candidateVerified: true,
    runtimeReady: true,
    accountingVerified: true,
    repairForwardOnly: true,
  },
  RELEASED: { verifiedStopRemoval: true },
  COMPLETE: { releaseDurable: true },
}

test("requires each phase and all of its evidence before advancing", () => {
  let receipt = createV26CutoverReceipt(identity)
  for (const [phase, evidence] of Object.entries(proofs)) {
    for (const key of Object.keys(evidence)) {
      assert.throws(
        () => advanceV26CutoverReceipt(receipt, identity, phase, { ...evidence, [key]: false }),
        /evidence incomplete|recovery policy missing/
      )
    }
    receipt = advanceV26CutoverReceipt(receipt, identity, phase, evidence)
  }
  assert.equal(receipt.phase, "COMPLETE")
  assert.equal(receipt.recoveryPolicy, "REPAIR_FORWARD_ONLY")
  assert.throws(
    () => advanceV26CutoverReceipt(receipt, identity, "COMPLETE", proofs.COMPLETE),
    /invalid transition/
  )
})

test("requires a qualified rollback or an explicit repair-forward-only policy", () => {
  let receipt = createV26CutoverReceipt(identity)
  for (const phase of ["CLAIMED", "QUIESCED", "INVENTORIED", "MIGRATED"])
    receipt = advanceV26CutoverReceipt(receipt, identity, phase, proofs[phase])
  const candidate = { ...proofs.VERIFIED, repairForwardOnly: false }
  assert.throws(
    () => advanceV26CutoverReceipt(receipt, identity, "VERIFIED", candidate),
    /recovery policy missing/
  )
  assert.equal(
    advanceV26CutoverReceipt(receipt, identity, "VERIFIED", {
      ...candidate,
      rollbackQualified: true,
    }).phase,
    "VERIFIED"
  )
})

test("rejects skipped phases and forged, stale or foreign stop identities", () => {
  const receipt = createV26CutoverReceipt(identity)
  assert.throws(
    () => advanceV26CutoverReceipt(receipt, identity, "QUIESCED", proofs.QUIESCED),
    /invalid transition/
  )
  for (const field of [
    "runId",
    "attempt",
    "owner",
    "sourceRevision",
    "engineRevision",
    "workerDigest",
    "webDigest",
    "databaseIdentity",
    "redisIdentity",
  ]) {
    assert.throws(
      () =>
        assertV26CutoverReceipt(receipt, {
          ...identity,
          [field]: field === "attempt" ? 2 : "invalid",
        }),
      /identity/
    )
  }
  assert.throws(
    () => assertV26CutoverReceipt({ ...receipt, kind: "webhook-claims-cutover" }, identity),
    /identity mismatch/
  )
  assert.throws(
    () => assertV26CutoverReceipt({ ...receipt, stop: "{}" }, identity),
    /identity mismatch/
  )
})

test("does not serialize unexpected sensitive identity fields into the durable receipt", () => {
  const receipt = createV26CutoverReceipt({ ...identity, databaseUrl: "secret-fixture" })
  assert.equal(JSON.stringify(receipt).includes("secret-fixture"), false)
  assert.equal(JSON.parse(receipt.stop).reason, "v26-accounting-cutover")
})
