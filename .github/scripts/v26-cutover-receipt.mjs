// A typed state contract for the first reservation-aware production cutover.
// The caller must obtain every proof from its owning service; passing values
// to this module is not itself a production attestation.

const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const RUN = /^[1-9][0-9]{0,19}$/
const STATES = [
  "INTENT",
  "CLAIMED",
  "QUIESCED",
  "INVENTORIED",
  "MIGRATED",
  "VERIFIED",
  "RELEASED",
  "COMPLETE",
]

function fail(message) {
  throw new Error(`v26 cutover: ${message}`)
}

function validIdentity(identity) {
  return Boolean(
    identity &&
    RUN.test(identity.runId ?? "") &&
    Number.isSafeInteger(identity.attempt) &&
    identity.attempt > 0 &&
    identity.owner === `${identity.runId}:${identity.attempt}` &&
    SHA.test(identity.sourceRevision ?? "") &&
    SHA.test(identity.engineRevision ?? "") &&
    DIGEST.test(identity.workerDigest ?? "") &&
    DIGEST.test(identity.webDigest ?? "") &&
    HASH.test(identity.databaseIdentity ?? "") &&
    HASH.test(identity.redisIdentity ?? "")
  )
}

export function createV26CutoverReceipt(identity) {
  if (!validIdentity(identity)) fail("invalid identity")
  const fixed = {
    runId: identity.runId,
    attempt: identity.attempt,
    owner: identity.owner,
    sourceRevision: identity.sourceRevision,
    engineRevision: identity.engineRevision,
    workerDigest: identity.workerDigest,
    webDigest: identity.webDigest,
    databaseIdentity: identity.databaseIdentity,
    redisIdentity: identity.redisIdentity,
  }
  const stop = JSON.stringify({
    operator: "github-actions",
    reason: "v26-accounting-cutover",
    owner: fixed.owner,
    runId: fixed.runId,
    productRevision: fixed.sourceRevision,
  })
  return { version: 1, kind: "v26-accounting-cutover", identity: fixed, stop, phase: "INTENT" }
}

export function assertV26CutoverReceipt(receipt, identity) {
  if (!validIdentity(identity)) fail("invalid identity")
  const expected = createV26CutoverReceipt(identity)
  if (
    !receipt ||
    receipt.version !== expected.version ||
    receipt.kind !== expected.kind ||
    JSON.stringify(receipt.identity) !== JSON.stringify(expected.identity) ||
    receipt.stop !== expected.stop ||
    !STATES.includes(receipt.phase) ||
    (STATES.indexOf(receipt.phase) < STATES.indexOf("VERIFIED")
      ? receipt.recoveryPolicy !== undefined
      : !["REPAIR_FORWARD_ONLY", "COMPATIBLE_ROLLBACK"].includes(receipt.recoveryPolicy))
  )
    fail("receipt identity mismatch")
  return receipt
}

/** Advance only with affirmative evidence from the phase's authoritative checks. */
export function advanceV26CutoverReceipt(receipt, identity, next, evidence) {
  assertV26CutoverReceipt(receipt, identity)
  if (STATES.indexOf(next) !== STATES.indexOf(receipt.phase) + 1) fail("invalid transition")
  const requirements = {
    CLAIMED: ["ownedStop"],
    QUIESCED: ["ownedStop", "writersStopped", "workerStopped", "stopProvenance", "queuesEmpty"],
    INVENTORIED: ["ownedStop", "writersStopped", "workerStopped", "queuesEmpty", "accountingClear"],
    MIGRATED: [
      "ownedStop",
      "writersStopped",
      "workerStopped",
      "migrationVerified",
      "rolesVerified",
      "seedsVerified",
    ],
    VERIFIED: ["ownedStop", "candidateVerified", "runtimeReady", "accountingVerified"],
    RELEASED: ["verifiedStopRemoval"],
    COMPLETE: ["releaseDurable"],
  }
  if (!requirements[next]?.every((key) => evidence?.[key] === true)) fail("evidence incomplete")
  // On the first cutover no previous reservation-aware image may exist.
  // In that case the caller must enforce held-admission, repair-forward
  // failure handling; a legacy image is never a qualified rollback.
  if (
    next === "VERIFIED" &&
    evidence.rollbackQualified !== true &&
    evidence.repairForwardOnly !== true
  )
    fail("recovery policy missing")
  return {
    ...receipt,
    phase: next,
    ...(next === "VERIFIED"
      ? {
          recoveryPolicy:
            evidence.rollbackQualified === true ? "COMPATIBLE_ROLLBACK" : "REPAIR_FORWARD_ONLY",
        }
      : {}),
  }
}
