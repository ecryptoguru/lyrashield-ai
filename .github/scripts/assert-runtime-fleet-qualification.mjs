// Deployment consumes only an authenticated exact-artifact release record.
// Health, fixture and held publication signatures use other purposes and are
// rejected here, so they can never authorize production.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { verifyRuntimeQualificationSignature } from "../../packages/security/src/sandbox-publication-record.ts"

const sha256 = /^[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/
const image = /^sha256:[a-f0-9]{64}$/
const numberId = /^[1-9][0-9]{0,19}$/
export const RELEASE_PURPOSE = "exact-artifact-release"
export const ISSUER_WORKFLOW = ".github/workflows/issue-runtime-qualification.yml"
const maximumAgeMs = 24 * 60 * 60 * 1000

function exact(value, fields) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value))
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort())
}

function check(condition, message) {
  assert.ok(condition, `Runtime fleet qualification: ${message}`)
}

export function assertRuntimeFleetQualification(
  envelope,
  expected,
  verifySignature = verifyRuntimeQualificationSignature
) {
  check(envelope && typeof envelope === "object", "record unavailable")
  exact(envelope, ["raw", "result"])
  check(typeof envelope.raw === "string" && envelope.raw.length > 0, "record bytes unavailable")
  check(Buffer.byteLength(envelope.raw) <= 4096, "record over bound")
  check(
    createHash("sha256").update(envelope.raw).digest("hex") === expected.recordSha256,
    "record digest mismatch"
  )
  // The pinned source-controlled public key decides, not the caller.
  verifySignature(envelope.raw, envelope.result)
  const record = JSON.parse(envelope.raw)
  exact(record, [
    "kind",
    "schema",
    "purpose",
    "scope",
    "fleet",
    "sourceTree",
    "architecture",
    "evidence",
    "journal",
    "issuer",
    "issuedAt",
  ])
  check(record.kind === "runtime-fleet-qualification", "wrong record kind")
  check(record.schema === "lyrashield-runtime-fleet-qualification/1", "wrong record schema")
  check(record.purpose === RELEASE_PURPOSE, "record purpose does not authorize production")
  check(record.scope === "disposable-linux", "record scope is not the reviewed fleet proof")
  check(
    record.sourceTree.match(revision) && record.sourceTree === expected.sourceTree,
    "source tree drifts"
  )
  check(["amd64", "arm64"].includes(record.architecture), "architecture invalid")
  exact(record.fleet, [
    "productRevision",
    "engineRevision",
    "webDigest",
    "proxyDigest",
    "workerDigest",
    "sandboxDigest",
    "brokerDigest",
    "supervisorDigest",
    "providerGatewayDigest",
    "migrationChecksum",
    "runtimePolicyDigest",
  ])
  check(record.fleet.productRevision === expected.source, "record binds another product revision")
  check(
    record.fleet.engineRevision === expected.engineRevision,
    "record binds another engine revision"
  )
  for (const [field, value] of Object.entries(record.fleet))
    if (field.endsWith("Digest") || field === "migrationChecksum")
      check(image.test(value), `fleet ${field} invalid`)
  exact(record.evidence, ["native", "migration", "policy", "journal", "rollback", "inventory"])
  for (const [field, value] of Object.entries(record.evidence))
    check(sha256.test(value), `evidence ${field} invalid`)
  exact(record.journal, [
    "sealHash",
    "recoverySnapshotSha256",
    "pinEnvelopeHash",
    "observedControlCasAckHash",
  ])
  for (const [field, value] of Object.entries(record.journal))
    check(sha256.test(value), `journal ${field} invalid`)
  exact(record.issuer, [
    "repositoryId",
    "repositoryOwnerId",
    "workflow",
    "source",
    "runId",
    "attempt",
  ])
  check(record.issuer.repositoryId === "1286618458", "issuer repository invalid")
  check(record.issuer.repositoryOwnerId === "116722580", "issuer owner invalid")
  check(record.issuer.workflow === ISSUER_WORKFLOW, "record was not issued by the protected issuer")
  check(record.issuer.source === expected.source, "issuer source mismatch")
  check(
    numberId.test(record.issuer.runId) && numberId.test(record.issuer.attempt),
    "issuer run invalid"
  )
  check(Number.isSafeInteger(record.issuedAt) && record.issuedAt > 0, "issuedAt invalid")
  const age = Date.now() - record.issuedAt * 1000
  check(age > -5 * 60 * 1000 && age < maximumAgeMs, "record is stale or from the future")
  return record
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const record = assertRuntimeFleetQualification(
      JSON.parse(process.env.RUNTIME_FLEET_QUALIFICATION ?? ""),
      {
        source: process.env.SOURCE_SHA ?? "",
        sourceTree: process.env.SOURCE_TREE ?? "",
        engineRevision: process.env.ENGINE_REVISION ?? "",
        recordSha256: process.env.RUNTIME_FLEET_RECORD_SHA256 ?? "",
      }
    )
    if (process.env.REQUIRE_QUALIFIED_IMAGES === "1") {
      for (const [field, deployed] of [
        ["webDigest", process.env.WEB_DIGEST],
        ["workerDigest", process.env.WORKER_DIGEST],
        ["proxyDigest", process.env.PROXY_DIGEST],
      ])
        check(deployed && record.fleet[field] === deployed, `deployed ${field} is not qualified`)
    }
    process.stdout.write(
      `Exact-artifact release qualification verified: ${record.fleet.productRevision}\n`
    )
  } catch (error) {
    process.stderr.write(
      `::error::${error instanceof Error ? error.message : "Runtime fleet qualification unavailable"}\n`
    )
    process.exitCode = 1
  }
}
