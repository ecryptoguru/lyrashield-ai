// Consumer checks only. These records have no signing or deployment entry point.
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { verifiedArtifact } from "./paired-runtime-github.mjs"
import {
  requireQualifiedFleetSchema,
  qualificationControlPlaneFields,
} from "./paired-runtime-authority.mjs"
export {
  qualifiedFleetSchema,
  qualificationControlPlaneFields,
} from "./paired-runtime-authority.mjs"
import {
  assertHeldReadiness,
  pairedReleaseReceipt,
} from "../../ops/monitoring/paired-release-hold.mjs"

const hash = /^[a-f0-9]{64}$/
const digest = /^sha256:[a-f0-9]{64}$/
const owner = /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/
const revision = /^[a-z][a-z0-9-]{0,30}--[a-z0-9][a-z0-9-]{0,30}$/
const pairDigests = [
  "workerDigest",
  "webDigest",
  "proxyDigest",
  "priorWorkerDigest",
  "sandboxDigest",
]
const services = ["app", "scanner", "relay"]
const proofs = ["releaseProof", "sandboxProof", "financialProof", "readerProof", "connectionProof"]

function requireRecord(condition) {
  if (!condition) throw new Error("Protected runtime qualification mismatch")
}
function exact(value, fields) {
  requireRecord(
    value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype &&
      isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())
  )
}
function matchedTuple(pair, controlPlane, expected) {
  exact(pair, ["owner", "productRevision", "engineRevision", ...pairDigests, ...services])
  pairedReleaseReceipt(pair.owner, pair.productRevision, pair.engineRevision, pair.workerDigest)
  for (const field of pairDigests)
    requireRecord(typeof pair[field] === "string" && digest.test(pair[field]))
  for (const service of services) {
    exact(pair[service], ["candidate", "previous"])
    const { candidate, previous } = pair[service]
    requireRecord(
      typeof candidate === "string" &&
        typeof previous === "string" &&
        revision.test(candidate) &&
        revision.test(previous) &&
        candidate !== previous &&
        candidate.split("--")[0] === previous.split("--")[0]
    )
  }
  requireRecord(
    new Set(services.map((service) => pair[service].candidate.split("--")[0])).size === 3
  )
  exact(controlPlane, qualificationControlPlaneFields)
  for (const field of qualificationControlPlaneFields)
    requireRecord(typeof controlPlane[field] === "string" && digest.test(controlPlane[field]))
  requireRecord(
    isDeepStrictEqual(pair, expected.pair) && isDeepStrictEqual(controlPlane, expected.controlPlane)
  )
}
async function authenticated(kind, id, verifyArtifact) {
  requireRecord(typeof id === "string" && hash.test(id))
  const artifact = await verifyArtifact(kind, id)
  const raw = artifact?.raw
  requireRecord(
    typeof raw === "string" &&
      Buffer.byteLength(raw) <= 4096 &&
      createHash("sha256").update(raw).digest("hex") === id
  )
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    throw new Error("Protected runtime qualification invalid")
  }
  requireRecord(record.kind === kind && JSON.stringify(record) === raw)
  requireRecord(
    typeof artifact.owner === "string" &&
      owner.test(artifact.owner) &&
      record.pair?.owner === artifact.owner &&
      record.pair?.productRevision === artifact.source
  )
  return record
}

// Legacy archives are not upgraded in memory. They require fresh signed v2
// qualification, including the complete control-plane tuple, before recovery.
export function validateQualifiedFleetArchive(record) {
  requireQualifiedFleetSchema(record)
  matchedTuple(record.pair, record.controlPlane, record)
}

// Structural validation is useful before transporting immutable bytes. It is
// not held-state authorization; callers must authenticate the separate readback.
export function validateHeldBaselineArchive(record) {
  exact(record, ["kind", "purpose", "pair", "controlPlane", ...proofs])
  requireRecord(record.kind === "held-baseline" && record.purpose === "rollback-only")
  matchedTuple(record.pair, record.controlPlane, record)
  for (const field of proofs)
    requireRecord(typeof record[field] === "string" && hash.test(record[field]))
}

// An archive of a held, qualified baseline is rollback evidence only. It never
// substitutes for the admission-open proof required by qualified-fleet recovery.
export async function readHeldBaselineArchive(id, expected, dependencies = {}) {
  const verifyArtifact = dependencies.verifyArtifact ?? verifiedArtifact
  const record = await authenticated("held-baseline", id, verifyArtifact)
  validateHeldBaselineArchive(record)
  matchedTuple(record.pair, record.controlPlane, expected)
  const readback = await authenticated("release-readback", record.releaseProof, verifyArtifact)
  exact(readback, [
    "kind",
    "owner",
    "pair",
    "controlPlane",
    "admission",
    "holdReceipt",
    "holdPersistent",
    "runRecordV11",
    "pendingHttpEvidence",
    "selectorPresent",
    "oldServingReplicas",
    "workerCount",
    "relayCount",
    "readyCode",
    "readyBody",
    "scansCode",
    "scansBody",
  ])
  matchedTuple(readback.pair, readback.controlPlane, expected)
  requireRecord(
    readback.owner === record.pair.owner &&
      readback.admission === "held" &&
      readback.holdPersistent === true &&
      readback.runRecordV11 === "0" &&
      readback.pendingHttpEvidence === "0" &&
      readback.selectorPresent === false &&
      readback.oldServingReplicas === 0 &&
      readback.workerCount === 1 &&
      readback.relayCount === 1 &&
      readback.holdReceipt ===
        pairedReleaseReceipt(
          record.pair.owner,
          record.pair.productRevision,
          record.pair.engineRevision,
          record.pair.workerDigest
        )
  )
  assertHeldReadiness(
    readback.readyCode,
    readback.readyBody,
    readback.scansCode,
    readback.scansBody
  )
  return record
}

// This check cannot mint a lease or consume a mutation. The future protected
// controller must supply complete qualification and durable lease/replay readers,
// and invoke it again at each physical mutation and admission-release boundary.
export async function assertPromotionActionLease(id, expected, dependencies = {}) {
  requireRecord(
    typeof dependencies.verifyQualifiedRelease === "function" &&
      typeof dependencies.readLeaseState === "function"
  )
  const qualification = await dependencies.verifyQualifiedRelease(expected.qualificationSha256)
  requireRecord(
    qualification?.kind === "qualified-release" &&
      qualification.qualified === true &&
      qualification.owner === expected.owner &&
      qualification.mode === "paired" &&
      qualification.conflictingMaintenance === false
  )
  matchedTuple(qualification.pair, qualification.controlPlane, expected)
  const lease = await authenticated(
    "promotion-action-lease",
    id,
    dependencies.verifyArtifact ?? verifiedArtifact
  )
  exact(lease, [
    "kind",
    "owner",
    "qualificationSha256",
    "pair",
    "controlPlane",
    "action",
    "epoch",
    "nonce",
    "issuedAt",
    "expiresAt",
  ])
  matchedTuple(lease.pair, lease.controlPlane, expected)
  requireRecord(
    lease.owner === expected.owner &&
      lease.owner === lease.pair.owner &&
      typeof lease.qualificationSha256 === "string" &&
      hash.test(lease.qualificationSha256) &&
      lease.qualificationSha256 === expected.qualificationSha256 &&
      ["forward", "restore", "release"].includes(lease.action) &&
      lease.action === expected.action &&
      Number.isSafeInteger(lease.epoch) &&
      lease.epoch > 0 &&
      lease.epoch === expected.epoch &&
      typeof lease.nonce === "string" &&
      hash.test(lease.nonce) &&
      lease.nonce === expected.nonce &&
      Number.isSafeInteger(lease.issuedAt) &&
      lease.issuedAt > 0 &&
      Number.isSafeInteger(lease.expiresAt) &&
      lease.expiresAt > lease.issuedAt &&
      lease.expiresAt - lease.issuedAt <= 900
  )
  const state = await dependencies.readLeaseState()
  exact(state, ["state", "now", "owner", "action", "epoch", "nonce", "qualificationSha256"])
  requireRecord(
    state.state === "active" &&
      Number.isSafeInteger(state.now) &&
      lease.issuedAt <= state.now &&
      state.now < lease.expiresAt &&
      state.owner === lease.owner &&
      state.action === lease.action &&
      state.epoch === lease.epoch &&
      state.nonce === lease.nonce &&
      state.qualificationSha256 === lease.qualificationSha256
  )
}
