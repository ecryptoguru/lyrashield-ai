import assert from "node:assert/strict"
import test from "node:test"
import {
  verifyIndependentSandboxInventory,
  INVENTORY_PREDICATE_TYPE,
  INVENTORY_VERIFIER_TREE,
  INVENTORY_VERIFIER_FILES,
  INVENTORY_VERIFIER_FILE_HASHES,
} from "../independent-sandbox-inventory.mjs"

const hash = (c) => "sha256:" + c.repeat(64)
const input = {
  engineRevision: "a".repeat(40),
  publicationRevision: "a".repeat(40),
  publishRunId: "42",
  publishAttempt: "1",
  sandboxDigest: hash("b"),
  verifierRevision: "c".repeat(40),
  verifierRunId: "52",
  verifierAttempt: "2",
}
const now = Date.parse("2026-11-12T00:00:00Z")
const go = Array.from({ length: 12 }, (_, i) => ({
  name: `fixture-${i}`,
  binarySha256: "d".repeat(64),
}))
const binding = (c) => ({
  manifestDigest: hash(c),
  configDigest: hash("e"),
  spdxDocumentDigest: hash("f"),
  goApplications: go,
})
const publication = {
  ...input,
  qualified: false,
  nativeInventoryRechecked: false,
  signedBoundedCoverageVerified: true,
  coveragePredicateChecksum: "1".repeat(64),
  nativeManifests: { amd64: hash("1"), arm64: hash("2") },
  inventoryBindings: { amd64: binding("1"), arm64: binding("2") },
}
const limitations = [
  "Only Debian status, declared Python/npm metadata roots and twelve pinned Go files",
  "Conservative OCI header model; unsupported changesets fail closed",
  "Header/link/package and Go parsers are shared with the bounded producer oracle",
  "No Linux runtime overlay, capability state or image-wide completeness proof",
  "No benchmark, adversarial robustness or production promotion qualification",
]
function fixture() {
  const predicate = {
    schema: "lyrashield.sandbox.independent-package-inventory.v1",
    status: "bounded_scope_matched",
    indexDigest: input.sandboxDigest,
    engineRevision: input.engineRevision,
    workflowRevision: input.publicationRevision,
    image: "ghcr.io/ecryptoguru/lyrashield-sandbox",
    runId: input.publishRunId,
    runAttempt: input.publishAttempt,
    sourceFiles: {
      "containers/go-tools/applications.json": hash("3"),
      "containers/go-tools/distro/applications.cdx.json": hash("4"),
    },
    goToolSha256: "5f5eb6d0b2fb6aa0bb5d5f8c5f1c944e0de955c925f0111af92a9d8f79680b5b",
    ghToolSha256: "62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617",
    limits: {
      finalHeaders: 200000,
      scopedArchiveBytes: 3 * 1024 ** 3,
      individualMetadataBytes: 32 * 1024 ** 2,
      metadataBytes: 256 * 1024 ** 2,
      individualGoBinaryBytes: 512 * 1024 ** 2,
      totalGoBinaryBytes: 2 * 1024 ** 3,
      processingSeconds: 1800,
      verifierAddressSpaceBytes: 4294967296,
      helperAddressSpaceBytes: 2147483648,
      verifierCpuSeconds: 1800,
      verifierFileDescriptors: 256,
      verifierWallSeconds: 1810,
    },
    platforms: Object.fromEntries(
      ["amd64", "arm64"].map((arch) => [
        arch,
        {
          ...publication.inventoryBindings[arch],
          inventoryCounts: { deb: 1, pypi: 1, npm: 1, goApplications: go.length },
          layers: 1,
          finalHeaders: 1,
        },
      ])
    ),
    limitations,
    releaseQualified: false,
    verifier: {
      repositoryId: "1297157605",
      ownerId: "116722580",
      revision: input.verifierRevision,
      tree: INVENTORY_VERIFIER_TREE,
      workflow: ".github/workflows/verify-sandbox-inventory.yml",
      runId: input.verifierRunId,
      runAttempt: input.verifierAttempt,
      sourceFiles: { ...INVENTORY_VERIFIER_FILE_HASHES },
    },
  }
  const identity =
    "https://github.com/ecryptoguru/lyrashield-engine/.github/workflows/verify-sandbox-inventory.yml@refs/heads/main"
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeName: identity,
    buildSignerURI: identity,
    buildSignerDigest: input.verifierRevision,
    runnerEnvironment: "github-hosted",
    sourceRepositoryURI: "https://github.com/ecryptoguru/lyrashield-engine",
    sourceRepositoryDigest: input.verifierRevision,
    sourceRepositoryRef: "refs/heads/main",
    sourceRepositoryIdentifier: "1297157605",
    sourceRepositoryOwnerURI: "https://github.com/ecryptoguru",
    sourceRepositoryOwnerIdentifier: "116722580",
    runInvocationURI: "https://github.com/ecryptoguru/lyrashield-engine/actions/runs/52/attempts/2",
  }
  const row = {
    verificationResult: {
      signature: { certificate },
      verifiedTimestamps: [{ timestamp: "2026-11-11T23:00:00Z" }],
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: INVENTORY_PREDICATE_TYPE,
        subject: [
          {
            name: "ghcr.io/ecryptoguru/lyrashield-sandbox",
            digest: { sha256: input.sandboxDigest.slice(7) },
          },
        ],
        predicate,
      },
    },
  }
  const run = {
    id: 52,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: input.verifierRevision,
    path: ".github/workflows/verify-sandbox-inventory.yml",
    repository: { id: 1297157605 },
    head_repository: { id: 1297157605 },
  }
  const ci = {
    id: 61,
    workflow_id: 7,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: input.verifierRevision,
    path: ".github/workflows/ci.yml",
    repository: { id: 1297157605 },
    head_repository: { id: 1297157605 },
  }
  return {
    predicate,
    row,
    run,
    currentRun: structuredClone(run),
    ci,
    tree: INVENTORY_VERIFIER_TREE,
  }
}
function options(v) {
  return {
    when: now,
    verifyPublication: () => structuredClone(publication),
    verifyPublisher: () => {},
    read: (path) => {
      if (path === "actions/runs/52/attempts/2") return v.run
      if (path === "actions/runs/52") return v.currentRun
      if (path === "git/commits/" + input.verifierRevision)
        return { sha: input.verifierRevision, tree: { sha: v.tree } }
      if (path === "actions/workflows/ci.yml") return { id: 7, path: ".github/workflows/ci.yml" }
      if (
        path ===
        `actions/workflows/7/runs?event=push&head_sha=${input.verifierRevision}&per_page=100`
      )
        return { total_count: 1, workflow_runs: [v.ci] }
      if (path === "actions/runs/61/attempts/1" || path === "actions/runs/61") return v.ci
      if (path === "compare/" + input.verifierRevision + "...main")
        return { merge_base_commit: { sha: input.verifierRevision }, status: "ahead" }
      throw Error("unexpected API path")
    },
    run: (args) => {
      assert.ok(args.includes("--bundle-from-oci"))
      assert.equal(args[args.indexOf("--predicate-type") + 1], INVENTORY_PREDICATE_TYPE)
      assert.equal(args[args.indexOf("--source-digest") + 1], input.verifierRevision)
      assert.match(
        args[args.indexOf("--cert-identity") + 1],
        /verify-sandbox-inventory\.yml@refs\/heads\/main$/
      )
      return JSON.stringify([v.row])
    },
  }
}
test("accepts independently verified bounded inventory as evidence only", () => {
  const value = fixture()
  const result = verifyIndependentSandboxInventory(input, options(value))
  assert.equal(result.qualified, false)
  assert.equal(result.runtimeAuthorityVerified, false)
  assert.equal(result.nativeInventoryRechecked, true)
  assert.equal(result.sandboxDigest, input.sandboxDigest)
})
test("rejects changed identity, source, run, scope, native bytes, tools and authority", () => {
  const changes = [
    (v) => (v.tree = "9".repeat(40)),
    (v) => (v.run.conclusion = "failure"),
    (v) => (v.ci.conclusion = "failure"),
    (v) => (v.ci.conclusion = "cancelled"),
    (v) => (v.row.verificationResult.signature.certificate.runInvocationURI += "0"),
    (v) => (v.predicate.engineRevision = "9".repeat(40)),
    (v) => (v.predicate.platforms.arm64.configDigest = hash("9")),
    (v) => (v.predicate.goToolSha256 = "9".repeat(64)),
    (v) => (v.predicate.limitations = []),
    (v) => (v.predicate.releaseQualified = true),
    (v) => (v.predicate.platforms.amd64.goApplications = []),
    (v) => delete v.predicate.verifier.sourceFiles[INVENTORY_VERIFIER_FILES[0]],
    (v) => (v.predicate.verifier.sourceFiles[INVENTORY_VERIFIER_FILES[0]] = hash("9")),
  ]
  for (const change of changes) {
    const value = fixture()
    change(value)
    assert.throws(() => verifyIndependentSandboxInventory(input, options(value)))
  }
})

test("a non-ancestor, incomplete run list, or newer pending verifier CI never falls back to success", () => {
  for (const change of ["main", "incomplete", "newer"]) {
    const value = fixture()
    const base = options(value)
    const read = base.read
    base.read = (path) => {
      if (change === "main" && path === `compare/${input.verifierRevision}...main`)
        return { merge_base_commit: { sha: "9".repeat(40) }, status: "diverged" }
      if (
        path ===
        `actions/workflows/7/runs?event=push&head_sha=${input.verifierRevision}&per_page=100`
      ) {
        if (change === "incomplete") return { total_count: 2, workflow_runs: [value.ci] }
        if (change === "newer")
          return { total_count: 2, workflow_runs: [value.ci, { ...value.ci, id: 62 }] }
      }
      if (change === "newer" && path === "actions/runs/62")
        return { ...value.ci, id: 62, status: "in_progress", conclusion: null }
      if (change === "newer" && path === "actions/runs/62/attempts/1")
        return { ...value.ci, id: 62, status: "in_progress", conclusion: null }
      return read(path)
    }
    assert.throws(() => verifyIndependentSandboxInventory(input, base))
  }
})

test("allows an unchanged reviewed verifier after main advances, but rechecks ancestry", () => {
  const value = fixture()
  const base = options(value)
  assert.doesNotThrow(() => verifyIndependentSandboxInventory(input, base))
  const read = base.read
  let comparisons = 0
  base.read = (path) => {
    if (path === `compare/${input.verifierRevision}...main` && ++comparisons === 2)
      return { merge_base_commit: { sha: "9".repeat(40) }, status: "diverged" }
    return read(path)
  }
  assert.throws(() => verifyIndependentSandboxInventory(input, base))
})

test("rejects a superseded or failed current inventory attempt, including reruns during verification", () => {
  for (const state of [
    { run_attempt: 3, status: "in_progress", conclusion: null },
    { run_attempt: 2, status: "completed", conclusion: "failure" },
    { run_attempt: 2, status: "completed", conclusion: "cancelled" },
  ]) {
    for (const duringVerification of [false, true]) {
      const value = fixture()
      const base = options(value)
      const rerun = () => {
        value.currentRun = { ...value.currentRun, ...state }
      }
      if (duringVerification) {
        const run = base.run
        base.run = (args) => {
          const result = run(args)
          rerun()
          return result
        }
      } else rerun()
      assert.throws(() => verifyIndependentSandboxInventory(input, base))
    }
  }
})
