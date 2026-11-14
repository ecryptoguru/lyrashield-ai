import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { assertRuntimeFleetQualification } from "../assert-runtime-fleet-qualification.mjs"

const source = "1".repeat(40)
const tree = "2".repeat(40)
const engine = "3".repeat(40)
const image = (value) => "sha256:" + value.repeat(64)
const record = {
  kind: "runtime-fleet-qualification",
  schema: "lyrashield-runtime-fleet-qualification/1",
  purpose: "exact-artifact-release",
  scope: "disposable-linux",
  fleet: {
    productRevision: source,
    engineRevision: engine,
    webDigest: image("a"),
    proxyDigest: image("b"),
    workerDigest: image("c"),
    sandboxDigest: image("d"),
    brokerDigest: image("e"),
    supervisorDigest: image("f"),
    providerGatewayDigest: image("9"),
    migrationChecksum: image("8"),
    runtimePolicyDigest: image("7"),
  },
  sourceTree: tree,
  architecture: "amd64",
  evidence: {
    native: "0".repeat(64),
    migration: "0".repeat(64),
    policy: "0".repeat(64),
    journal: "0".repeat(64),
    rollback: "0".repeat(64),
    inventory: "0".repeat(64),
  },
  journal: {
    sealHash: "0".repeat(64),
    recoverySnapshotSha256: "0".repeat(64),
    pinEnvelopeHash: "0".repeat(64),
    observedControlCasAckHash: "0".repeat(64),
  },
  issuer: {
    repositoryId: "1286618458",
    repositoryOwnerId: "116722580",
    workflow: ".github/workflows/issue-runtime-qualification.yml",
    source,
    runId: "42",
    attempt: "1",
  },
  // Relative to the run: a fixed timestamp silently ages out of the 24-hour
  // freshness window and fails this required check for unrelated changes.
  issuedAt: Math.floor(Date.now() / 1000) - 60,
}
const raw = JSON.stringify(record)
const expected = {
  source,
  sourceTree: tree,
  engineRevision: engine,
  recordSha256: createHash("sha256").update(raw).digest("hex"),
}
const verified = () => {}
const envelopeOf = (value) => ({ raw: value, result: { algorithm: "RS256" } })

test("accepts only an authenticated exact-artifact release record", () => {
  const accepted = assertRuntimeFleetQualification(envelopeOf(raw), expected, verified)
  assert.equal(accepted.fleet.productRevision, source)
})

test("rejects health, fixture and held purposes even when the bytes verify", () => {
  for (const purpose of [
    "signing-primitive-check-only",
    "publication-evidence-only",
    "fixture",
    "disposable-sandbox-proof",
  ]) {
    const changed = JSON.stringify({ ...record, purpose })
    assert.throws(
      () =>
        assertRuntimeFleetQualification(
          envelopeOf(changed),
          { ...expected, recordSha256: createHash("sha256").update(changed).digest("hex") },
          verified
        ),
      /does not authorize production/
    )
  }
})

test("rejects a record bound to another source, engine, issuer or time", () => {
  const cases = [
    [{ ...record, sourceTree: "f".repeat(40) }, expected],
    [
      { ...record, issuer: { ...record.issuer, workflow: ".github/workflows/deploy-azure.yml" } },
      expected,
    ],
    [{ ...record, issuer: { ...record.issuer, source: "f".repeat(40) } }, expected],
    [record, { ...expected, engineRevision: "f".repeat(40) }],
    [{ ...record, issuedAt: Math.floor(Date.now() / 1000) - 48 * 60 * 60 }, expected],
    [{ ...record, purpose: "exact-artifact-release", scope: "production-host" }, expected],
  ]
  for (const [value, proof] of cases) {
    const changed = typeof value === "string" ? value : JSON.stringify(value)
    assert.throws(
      () =>
        assertRuntimeFleetQualification(
          envelopeOf(changed),
          { ...proof, recordSha256: createHash("sha256").update(changed).digest("hex") },
          verified
        ),
      /Runtime fleet qualification/
    )
  }
})
