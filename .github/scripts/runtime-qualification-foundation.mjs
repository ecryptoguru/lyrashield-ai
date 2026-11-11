// Protected read-only verification. Publication evidence never issues fleet authority.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SBOM_COVERAGE_PREDICATE_TYPE,
  validateSandboxSbomCoverageAggregate,
} from "../../apps/worker/src/engine/sandbox-sbom-coverage.ts"

const repo = "ecryptoguru/lyrashield-engine"
const repositoryId = "1297157605",
  ownerId = "116722580"
const workflow = repo + "/.github/workflows/publish-sandbox.yml"
const sourceRef = "refs/heads/main"
const identity = "https://github.com/" + workflow + "@" + sourceRef
const image = "ghcr.io/ecryptoguru/lyrashield-sandbox"
const predicateType = "https://slsa.dev/provenance/v1"
const qualificationType = "https://lyrashieldai.com/attestations/sandbox-qualification/v1"
// gh v2.95.0 binaries extracted only after verifying the official archive hashes.
const binaryHashes = Object.freeze({
  x64: "62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617",
  arm64: "706b030846db08d0dac0392d6f74416e0bbf0d9ac5ecbd54c9046305c10eac59",
})
const hash = (raw) => createHash("sha256").update(raw).digest("hex")

function gh(args) {
  // No PATH lookup, caller-chosen binary, custom roots or arbitrary command.
  const path = "/usr/bin/gh"
  assert.equal(process.platform, "linux")
  const expected = binaryHashes[process.arch]
  assert.ok(expected)
  const file = statSync(path)
  assert.ok(file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0)
  assert.equal(hash(readFileSync(path)), expected)
  try {
    return execFileSync(path, args, {
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8")
  } catch {
    // Registry/verifier errors can include credential material.
    throw new Error("Protected attestation verification failed")
  }
}

function checkedExpected(expected, when) {
  assert.deepEqual(Object.keys(expected).sort(), [
    "publicationRevision",
    "publishAttempt",
    "publishRunId",
    "sandboxDigest",
  ])
  assert.equal(Object.getPrototypeOf(expected), Object.prototype)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(expected)))
    assert.ok(Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string")
  expected = Object.freeze({ ...expected })
  assert.match(expected.publicationRevision, /^[a-f0-9]{40}$/)
  assert.match(expected.sandboxDigest, /^sha256:[a-f0-9]{64}$/)
  for (const field of ["publishRunId", "publishAttempt"])
    assert.match(expected[field], /^[1-9][0-9]{0,19}$/)
  assert.ok(Number.isSafeInteger(when) && when > 0)
  return expected
}

function verificationArguments(expected, type, bundle) {
  return [
    "attestation",
    "verify",
    "oci://" + image + "@" + expected.sandboxDigest,
    ...bundle,
    "--hostname",
    "github.com",
    "--repo",
    repo,
    "--cert-identity",
    identity,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--signer-digest",
    expected.publicationRevision,
    "--source-digest",
    expected.publicationRevision,
    "--source-ref",
    sourceRef,
    "--predicate-type",
    type,
    "--deny-self-hosted-runners",
    "--format",
    "json",
  ]
}

export function verifySandboxAttestationBundle(
  raw,
  expected,
  { run = gh, when = Date.now() } = {}
) {
  assert.equal(typeof raw, "string")
  assert.ok(Buffer.byteLength(raw) <= 1024 * 1024)
  expected = checkedExpected(expected, when)
  const bundle = JSON.parse(raw)
  // A saved gh verificationResult is not a signed bundle. The actual bundle is
  // reverified by the pinned process; no caller supplies verified result JSON.
  assert.ok(
    bundle &&
      !Array.isArray(bundle) &&
      bundle.mediaType === "application/vnd.dev.sigstore.bundle.v0.3+json" &&
      bundle.verificationMaterial &&
      bundle.dsseEnvelope &&
      !bundle.verificationResult &&
      !bundle.attestation
  )
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-attestation-"))
  const path = join(directory, "bundle.json")
  let rows
  try {
    // Path is generated inside our private directory, never supplied by a caller.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path, raw, { mode: 0o600, flag: "wx" })
    rows = JSON.parse(run(verificationArguments(expected, predicateType, ["--bundle", path])))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const statement = verifiedStatement(rows, expected, predicateType, when)
  assert.equal(statement.predicate?.runDetails?.metadata?.invocationId, invocationFor(expected))
  return Object.freeze({
    schema: "lyrashield-sandbox-provenance-check/1",
    qualified: false,
    packageCoverage: "UNVERIFIED",
    bundleChecksum: hash(raw),
    ...expected,
    checkedAt: new Date(when).toISOString(),
  })
}

function invocationFor(expected) {
  return (
    "https://github.com/" +
    repo +
    "/actions/runs/" +
    expected.publishRunId +
    "/attempts/" +
    expected.publishAttempt
  )
}

function verifiedStatement(rows, expected, type, when) {
  assert.ok(Array.isArray(rows) && rows.length === 1)
  const result = rows[0]?.verificationResult
  const certificate = result?.signature?.certificate
  assert.ok(certificate)
  // Fulcio certificate fields are flattened by sigstore-go v1.2.1. Unlike the
  // predicate, these values come from authenticated GitHub OIDC claims.
  for (const [field, value] of Object.entries({
    issuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeName: identity,
    buildSignerURI: identity,
    buildSignerDigest: expected.publicationRevision,
    runnerEnvironment: "github-hosted",
    sourceRepositoryURI: "https://github.com/" + repo,
    sourceRepositoryDigest: expected.publicationRevision,
    sourceRepositoryRef: sourceRef,
    sourceRepositoryIdentifier: repositoryId,
    sourceRepositoryOwnerURI: "https://github.com/ecryptoguru",
    sourceRepositoryOwnerIdentifier: ownerId,
    runInvocationURI: invocationFor(expected),
  }))
    assert.equal(certificate[field], value)
  assert.ok(Array.isArray(result.verifiedTimestamps) && result.verifiedTimestamps.length > 0)
  for (const timestamp of result.verifiedTimestamps)
    assert.ok(
      Number.isFinite(Date.parse(timestamp.timestamp)) && Date.parse(timestamp.timestamp) <= when
    )
  const statement = result.statement
  assert.equal(statement?._type, "https://in-toto.io/Statement/v1")
  assert.equal(statement.predicateType, type)
  assert.deepEqual(statement.subject, [
    { name: image, digest: { sha256: expected.sandboxDigest.slice(7) } },
  ])
  return statement
}

export function verifySandboxCoveragePublication(expected, { run = gh, when = Date.now() } = {}) {
  assert.equal(Object.getPrototypeOf(expected), Object.prototype)
  assert.deepEqual(Object.keys(expected).sort(), [
    "engineRevision",
    "publicationRevision",
    "publishAttempt",
    "publishRunId",
    "sandboxDigest",
  ])
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(expected)))
    assert.ok(Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string")
  const { engineRevision, ...publication } = expected
  assert.match(engineRevision, /^[a-f0-9]{40}$/)
  const binding = checkedExpected(publication, when)
  const statements = [predicateType, qualificationType, SBOM_COVERAGE_PREDICATE_TYPE].map((type) =>
    verifiedStatement(
      JSON.parse(run(verificationArguments(binding, type, ["--bundle-from-oci"]))),
      binding,
      type,
      when
    )
  )
  assert.equal(statements[0].predicate?.runDetails?.metadata?.invocationId, invocationFor(binding))
  const qualification = statements[1].predicate
  assert.deepEqual(Object.keys(qualification).sort(), [
    "engineCiAttempt",
    "engineCiRun",
    "engineRevision",
    "indexDigest",
    "platformIndexes",
    "platformManifests",
    "runAttempt",
    "runId",
    "schema",
    "workflowRevision",
  ])
  assert.equal(qualification.schema, "lyrashield.sandbox.qualification.v1")
  const identity = {
    engineRevision,
    workflowRevision: binding.publicationRevision,
    runId: binding.publishRunId,
    runAttempt: binding.publishAttempt,
    indexDigest: binding.sandboxDigest,
  }
  for (const [key, value] of Object.entries(identity)) assert.equal(qualification[key], value)
  for (const key of ["engineCiRun", "engineCiAttempt"])
    assert.match(qualification[key], /^[1-9][0-9]{0,19}$/)
  const coverage = statements[2].predicate
  validateSandboxSbomCoverageAggregate(coverage, identity)
  for (const key of ["platformIndexes", "platformManifests"]) {
    assert.deepEqual(Object.keys(qualification[key]).sort(), ["amd64", "arm64"])
    for (const arch of ["amd64", "arm64"])
      assert.match(qualification[key][arch], /^sha256:[a-f0-9]{64}$/)
    assert.notEqual(qualification[key].amd64, qualification[key].arm64)
  }
  for (const arch of ["amd64", "arm64"])
    assert.equal(qualification.platformManifests[arch], coverage.platforms[arch].manifestDigest)
  return Object.freeze({
    schema: "lyrashield-sandbox-publication-verification/1",
    qualified: false,
    signedBoundedCoverageVerified: true,
    nativeInventoryRechecked: false,
    ...binding,
    engineRevision,
    coveragePredicateChecksum: hash(JSON.stringify(coverage)),
    nativeManifests: Object.freeze({ ...qualification.platformManifests }),
    checkedAt: new Date(when).toISOString(),
  })
}

export function issueRuntimeQualification() {
  // No trusted native inventory, fleet, policy, migrations, independent journal
  // and rollback readers exist yet. Never exchange a credential on this path.
  throw new Error("Runtime qualification issuance unavailable: trusted evidence readers required")
}
