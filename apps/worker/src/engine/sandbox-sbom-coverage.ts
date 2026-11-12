/**
 * Structural and content policy for bounded sandbox SBOM coverage
 * (`lyrashield.sandbox.sbom-coverage.v1`).
 *
 * This module does not authenticate the input or verify signatures. A JSON
 * file can be fabricated even if its fields match the expected verifier
 * output. The production gate remains held until an independent protected
 * issuer verifies the actual bundle and binds the exact qualification.
 *
 * Constants (policy, scope, limitations, limits, required applications)
 * mirror the engine aggregate builder
 * (`check_sandbox_sbom_coverage.py::build_aggregate`) and receipt validator
 * (`validate_receipt`), so the consumer and the engine agree on the
 * bounded-scope contract.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REVISION_RE = /^[0-9a-f]{40}$/
const NUMBER_RE = /^[1-9][0-9]*$/
const MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9._~+/-]*$/
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, validated SBOM content, byte-bounded input
const VERSION_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/
const SPDX_ID_RE = /^SPDXRef-[A-Za-z0-9.-]{1,1024}$/
const DOCKER_SERVER_RE = /^[A-Za-z0-9._+/:-]{1,256}$/

export const SBOM_COVERAGE_PREDICATE_TYPE =
  "https://lyrashieldai.com/attestations/sandbox-sbom-coverage/v1"
const SBOM_COVERAGE_AGGREGATE_SCHEMA = "lyrashield.sandbox.sbom-coverage.v1"
export const SBOM_COVERAGE_POLICY = { id: "sandbox-bounded-package-coverage", version: 1 }
export const SBOM_COVERAGE_LINK_POLICY = {
  id: "sandbox-bounded-package-link-policy",
  version: 2,
}
export const SBOM_COVERAGE_SCOPE = [
  "debian:var/lib/dpkg/status",
  "python:dist-info-metadata-under-declared-roots",
  "npm:package-json-under-declared-roots",
  "go:twelve-pinned-application-files",
] as const
export const SBOM_COVERAGE_LIMITATIONS = [
  "Bounded scopes only; this is not proof of image-wide package completeness",
  "Debian coverage is limited to installed identities in var/lib/dpkg/status",
  "Python coverage is limited to dist-info METADATA under declared roots",
  "npm coverage is limited to installed package metadata under declared roots",
  "Go coverage is limited to the 12 pinned application files and their linked build metadata",
  "Docker export is trusted to produce the merged root filesystem for the verified unstarted container",
  "Local-build Go main modules are UNKNOWN in SPDX; source versions come from pinned repository manifests",
  "The gate does not prove completeness of Syft cataloger discovery or enumerate every file, source tree, binary, or ecosystem",
] as const
export const SBOM_COVERAGE_REQUIRED_APPS = [
  "ffuf",
  "gitleaks",
  "gospider",
  "httpx",
  "interactsh-client",
  "katana",
  "naabu",
  "nuclei",
  "subfinder",
  "trivy",
  "trufflehog",
  "vulnx",
] as const
export const SBOM_COVERAGE_LIMITS = {
  rootfsExportBytes: 8 * 1024 * 1024 * 1024,
  rootfsExportSeconds: 900,
  archiveEntries: 1_000_000,
  metadataBytes: 256 * 1024 * 1024,
  individualMetadataBytes: 32 * 1024 * 1024,
  sbomBytes: 256 * 1024 * 1024,
  goBinaries: 12,
  totalGoBinaryBytes: 2 * 1024 * 1024 * 1024,
  individualGoBinaryBytes: 512 * 1024 * 1024,
  processingSeconds: 1800,
} as const

const MAX_ROOTFS_EXPORT_BYTES = SBOM_COVERAGE_LIMITS.rootfsExportBytes
const MAX_ARCHIVE_ENTRIES = SBOM_COVERAGE_LIMITS.archiveEntries
const PLATFORM_KEYS = [
  "receiptDigest",
  "manifestDigest",
  "configDigest",
  "containerId",
  "rootfsDigest",
  "rootfsSize",
  "spdxDocumentDigest",
  "goToolSha256",
  "exporter",
  "ignoredLinks",
  "goApplications",
  "limits",
] as const
const GO_APP_KEYS = [
  "name",
  "binaryPath",
  "binarySha256",
  "spdxFileId",
  "mainModule",
  "pinnedVersion",
  "mainSpdxPackageId",
  "dependencyCount",
] as const

interface SandboxSbomCoverageIdentity {
  engineRevision: string
  workflowRevision: string
  runId: string
  runAttempt: string
  indexDigest: string
}

export interface SandboxSbomCoverageVerifyOptions {
  /** Untrusted JSON shaped like `gh attestation verify --format json` output. */
  records: unknown
  /** The exact aggregate predicate the signer must have attested. */
  expectedAggregate: unknown
  /** Identity the aggregate must carry (run/attempt/index/revisions). */
  identity: SandboxSbomCoverageIdentity
  /** Sandbox image name (subject name), e.g. `ghcr.io/ecryptoguru/lyrashield-sandbox`. */
  imageName: string
  /** Engine repository, e.g. `ecryptoguru/lyrashield-engine`. */
  repo: string
  /** Signed workflow revision (40 hex). */
  revision: string
  /** Source ref the signer workflow ran on. */
  ref: string
}

function fail(message: string): never {
  throw new Error(`sandbox SBOM coverage: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]))
  }
  return false
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return deepEqual(Object.keys(value).sort(), [...keys].sort())
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    fail(`${label} must be a sha256 digest`)
  }
  return value
}

/**
 * Validate the aggregate predicate shape and policy content. Mirrors the
 * engine's `validate_receipt` + `build_aggregate` checks at aggregate scope:
 * both architecture receipts present, bounded scopes matched, LIMITATIONS
 * propagated, and rootfs digests recorded.
 */
export function validateSandboxSbomCoverageAggregate(
  aggregate: unknown,
  identity: SandboxSbomCoverageIdentity
): void {
  if (!isRecord(aggregate)) fail("aggregate predicate must be a JSON object")
  if (
    !hasExactKeys(aggregate, [
      "schema",
      "policy",
      "indexDigest",
      "engineRevision",
      "workflowRevision",
      "runId",
      "runAttempt",
      "platforms",
      "requiredGoApplications",
      "scope",
      "limitations",
    ])
  ) {
    fail("invalid aggregate fields")
  }
  if (aggregate.schema !== SBOM_COVERAGE_AGGREGATE_SCHEMA) {
    fail("invalid aggregate schema")
  }
  if (!deepEqual(aggregate.policy, SBOM_COVERAGE_POLICY)) {
    fail("invalid aggregate policy")
  }
  for (const name of ["engineRevision", "workflowRevision"] as const) {
    if (typeof aggregate[name] !== "string" || !REVISION_RE.test(aggregate[name])) {
      fail(`invalid ${name}`)
    }
  }
  for (const name of ["runId", "runAttempt"] as const) {
    if (typeof aggregate[name] !== "string" || !NUMBER_RE.test(aggregate[name])) {
      fail(`invalid ${name}`)
    }
  }
  requireDigest(aggregate.indexDigest, "indexDigest")
  for (const name of [
    "engineRevision",
    "workflowRevision",
    "runId",
    "runAttempt",
    "indexDigest",
  ] as const) {
    if (!deepEqual(aggregate[name], identity[name])) {
      fail(`aggregate ${name} mismatch`)
    }
  }
  const platforms = aggregate.platforms
  if (!isRecord(platforms) || !deepEqual(Object.keys(platforms).sort(), ["amd64", "arm64"])) {
    fail("aggregate must carry exactly the amd64 and arm64 platform receipts")
  }
  const manifestDigests: string[] = []
  for (const arch of ["amd64", "arm64"] as const) {
    const platform = platforms[arch]
    if (!isRecord(platform) || !hasExactKeys(platform, PLATFORM_KEYS)) {
      fail(`invalid platform receipt fields: ${arch}`)
    }
    requireDigest(platform.receiptDigest, `${arch} receiptDigest`)
    manifestDigests.push(requireDigest(platform.manifestDigest, `${arch} manifestDigest`))
    requireDigest(platform.configDigest, `${arch} configDigest`)
    if (typeof platform.containerId !== "string" || !SHA256_RE.test(platform.containerId)) {
      fail(`invalid containerId: ${arch}`)
    }
    requireDigest(platform.rootfsDigest, `${arch} rootfsDigest`)
    if (
      typeof platform.rootfsSize !== "number" ||
      !Number.isInteger(platform.rootfsSize) ||
      platform.rootfsSize <= 0 ||
      platform.rootfsSize > MAX_ROOTFS_EXPORT_BYTES
    ) {
      fail(`invalid rootfs size: ${arch}`)
    }
    requireDigest(platform.spdxDocumentDigest, `${arch} spdxDocumentDigest`)
    if (typeof platform.goToolSha256 !== "string" || !SHA256_RE.test(platform.goToolSha256)) {
      fail(`invalid Go tool digest: ${arch}`)
    }
    const exporter = platform.exporter
    if (
      !isRecord(exporter) ||
      !hasExactKeys(exporter, ["dockerServer"]) ||
      typeof exporter.dockerServer !== "string" ||
      !DOCKER_SERVER_RE.test(exporter.dockerServer)
    ) {
      fail(`invalid Docker exporter receipt: ${arch}`)
    }
    const ignoredLinks = platform.ignoredLinks
    if (
      !isRecord(ignoredLinks) ||
      !hasExactKeys(ignoredLinks, ["count", "policy"]) ||
      typeof ignoredLinks.count !== "number" ||
      !Number.isInteger(ignoredLinks.count) ||
      ignoredLinks.count < 0 ||
      ignoredLinks.count > MAX_ARCHIVE_ENTRIES ||
      !deepEqual(ignoredLinks.policy, SBOM_COVERAGE_LINK_POLICY)
    ) {
      fail(`invalid ignored-link receipt: ${arch}`)
    }
    if (!deepEqual(platform.limits, SBOM_COVERAGE_LIMITS)) {
      fail(`receipt limits differ from the bounded policy: ${arch}`)
    }
    validateGoApplications(platform.goApplications, arch)
  }
  if (manifestDigests[0] === manifestDigests[1]) {
    fail("platform manifest digests must differ")
  }
  if (
    !Array.isArray(aggregate.requiredGoApplications) ||
    !deepEqual(aggregate.requiredGoApplications, [...SBOM_COVERAGE_REQUIRED_APPS])
  ) {
    fail("required Go application set mismatch")
  }
  if (!deepEqual(aggregate.scope, [...SBOM_COVERAGE_SCOPE])) {
    fail("aggregate scope differs from the bounded policy")
  }
  if (!deepEqual(aggregate.limitations, [...SBOM_COVERAGE_LIMITATIONS])) {
    fail("aggregate limitations must propagate the bounded-scope limitations")
  }
}

function validateGoApplications(value: unknown, arch: string): void {
  if (!Array.isArray(value) || value.length !== 12) {
    fail(`Go application coverage mismatch: ${arch}`)
  }
  const names = value.map((item) => (isRecord(item) ? item.name : undefined))
  if (!deepEqual(names, [...SBOM_COVERAGE_REQUIRED_APPS])) {
    fail(`Go application set mismatch: ${arch}`)
  }
  for (const app of value) {
    if (!isRecord(app) || !hasExactKeys(app, GO_APP_KEYS)) {
      fail(`invalid Go application: ${arch}`)
    }
    const goModule = app.mainModule
    if (
      typeof goModule !== "string" ||
      !MODULE_RE.test(goModule) ||
      goModule.length > 1024 ||
      goModule.includes("://") ||
      goModule.split("/").some((part) => ["", ".", ".."].includes(part))
    ) {
      fail(`invalid Go module: ${arch}`)
    }
    if (typeof app.pinnedVersion !== "string" || !VERSION_RE.test(app.pinnedVersion)) {
      fail(`invalid pinned Go version: ${arch}`)
    }
    if (
      typeof app.binaryPath !== "string" ||
      !app.binaryPath.startsWith("/") ||
      app.binaryPath.length > 4096 ||
      app.binaryPath.split("/").some((part) => part === "..")
    ) {
      fail(`invalid Go binary path: ${arch}`)
    }
    if (typeof app.binarySha256 !== "string" || !SHA256_RE.test(app.binarySha256)) {
      fail(`invalid Go binary digest: ${arch}`)
    }
    if (
      typeof app.spdxFileId !== "string" ||
      !SPDX_ID_RE.test(app.spdxFileId) ||
      typeof app.mainSpdxPackageId !== "string" ||
      !SPDX_ID_RE.test(app.mainSpdxPackageId)
    ) {
      fail(`invalid Go SPDX identity: ${arch}`)
    }
    if (
      typeof app.dependencyCount !== "number" ||
      !Number.isInteger(app.dependencyCount) ||
      app.dependencyCount < 0
    ) {
      fail(`invalid Go dependency count: ${arch}`)
    }
  }
}

/**
 * Apply run/content policy to verifier-shaped JSON. This does not establish
 * authenticity. Mirrors the engine's `check_sandbox_attestations.py::accepted`
 * for the coverage predicate: fixed signer, source revision, source ref,
 * GitHub-hosted runner, run invocation, exact subject and exact predicate.
 *
 * The signer certificate's `buildSignerDigest` and `sourceRepositoryDigest`
 * bind the workflow run revision (`github.sha`), which is the aggregate's
 * `workflowRevision` — never the engine source pin.
 */
function findAcceptedCoverageAttestation(
  records: unknown,
  expectedAggregate: unknown,
  options: {
    imageName: string
    indexHex: string
    repo: string
    revision: string
    ref: string
    invocation: string
  }
): boolean {
  if (!Array.isArray(records)) fail("expected verified attestation result list")
  const { imageName, indexHex, repo, revision, ref, invocation } = options
  const signer = `https://github.com/${repo}/.github/workflows/publish-sandbox.yml@${ref}`
  const expectedCert = {
    issuer: "https://token.actions.githubusercontent.com",
    buildSignerURI: signer,
    buildSignerDigest: revision,
    sourceRepositoryURI: `https://github.com/${repo}`,
    sourceRepositoryDigest: revision,
    sourceRepositoryRef: ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: invocation,
  }
  for (const record of records) {
    if (!isRecord(record)) continue
    const result = record.verificationResult
    if (!isRecord(result)) continue
    const signature = result.signature
    const certificate = isRecord(signature) ? signature.certificate : undefined
    const statement = result.statement
    if (!isRecord(certificate) || !isRecord(statement)) continue
    if (!Object.entries(expectedCert).every(([key, value]) => certificate[key] === value)) {
      continue
    }
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== SBOM_COVERAGE_PREDICATE_TYPE
    ) {
      continue
    }
    if (!deepEqual(statement.subject, [{ name: imageName, digest: { sha256: indexHex } }])) {
      continue
    }
    if (!deepEqual(statement.predicate, expectedAggregate)) continue
    return true
  }
  return false
}

/**
 * Check bounded coverage fields for the sandbox image. Passing these content
 * checks does not establish that an attestation was signed or verified.
 */
export function verifySandboxSbomCoverage(options: SandboxSbomCoverageVerifyOptions): void {
  const { records, expectedAggregate, identity, imageName, repo, revision, ref } = options
  for (const [name, value, pattern] of [
    ["revision", revision, REVISION_RE],
    ["runId", identity.runId, NUMBER_RE],
    ["runAttempt", identity.runAttempt, NUMBER_RE],
    ["indexDigest", identity.indexDigest, DIGEST_RE],
  ] as const) {
    if (!pattern.test(value)) fail(`invalid ${name}`)
  }
  validateSandboxSbomCoverageAggregate(expectedAggregate, identity)
  const invocation = `https://github.com/${repo}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`
  const accepted = findAcceptedCoverageAttestation(records, expectedAggregate, {
    imageName,
    indexHex: identity.indexDigest.slice("sha256:".length),
    repo,
    revision,
    ref,
    invocation,
  })
  if (!accepted) {
    fail(`no accepted ${SBOM_COVERAGE_PREDICATE_TYPE} attestation`)
  }
}

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024
const SANDBOX_IMAGE_RE = /^ghcr\.io\/ecryptoguru\/lyrashield-sandbox@sha256:([a-f0-9]{64})$/

export function readJsonEvidence(path: string, label: string, expectedOwner: number): unknown {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    fail("safe evidence file flags are unavailable")
  }
  let fd: number
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    fail(`${label} is unavailable: ${path}`)
  }
  try {
    const before = fstatSync(fd)
    if (
      !before.isFile() ||
      before.uid !== expectedOwner ||
      before.size <= 0 ||
      before.size > MAX_EVIDENCE_BYTES
    ) {
      fail(`${label} has an invalid owner, type or size: ${path}`)
    }
    const bytes = Buffer.allocUnsafe(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const entry = lstatSync(path)
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.uid !== expectedOwner ||
      !entry.isFile() ||
      entry.dev !== before.dev ||
      entry.ino !== before.ino
    ) {
      fail(`${label} changed while reading: ${path}`)
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))
    } catch {
      fail(`${label} is not valid JSON: ${path}`)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Fail-closed production gate for the running sandbox image. Reads and checks
 * verifier-shaped JSON and its expected aggregate, then rejects admission
 * until a protected issuer can authenticate the actual qualification.
 */
export function assertSandboxSbomCoverageVerified(
  runtimeEnv: NodeJS.ProcessEnv,
  image: string
): void {
  const imageMatch = SANDBOX_IMAGE_RE.exec(image)
  if (!imageMatch) {
    fail("coverage verification is scoped to the pinned sandbox image")
  }
  const verifyPath = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH?.trim()
  const expectedPath = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH?.trim()
  const repo = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO?.trim()
  const ref = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF?.trim()
  const engineRevision = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION?.trim()
  const workflowRevision = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION?.trim()
  const runId = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID?.trim()
  const runAttempt = runtimeEnv.LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT?.trim()
  if (
    !verifyPath ||
    !expectedPath ||
    !repo ||
    !ref ||
    !engineRevision ||
    !workflowRevision ||
    !runId ||
    !runAttempt
  ) {
    fail(
      "signed SBOM coverage evidence env is required in production " +
        "(LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH, _EXPECTED_PATH, _REPO, _REF, " +
        "_ENGINE_REVISION, _WORKFLOW_REVISION, _RUN_ID, _RUN_ATTEMPT)"
    )
  }
  const expectedOwner = process.getuid?.()
  if (expectedOwner === undefined) fail("evidence owner cannot be established")
  verifySandboxSbomCoverage({
    records: readJsonEvidence(verifyPath, "verified attestation output", expectedOwner),
    expectedAggregate: readJsonEvidence(expectedPath, "expected coverage predicate", expectedOwner),
    identity: {
      engineRevision,
      workflowRevision,
      runId,
      runAttempt,
      indexDigest: `sha256:${imageMatch[1]}`,
    },
    imageName: "ghcr.io/ecryptoguru/lyrashield-sandbox",
    repo,
    revision: workflowRevision,
    ref,
  })
  // Matching a JSON rendering of verification output does not authenticate
  // the underlying bundle. Keep production admission closed until a protected
  // issuer verifies the attestation and signs the exact qualification tuple.
  fail("protected qualification issuer is unavailable")
}
