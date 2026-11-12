// The result is bounded inventory evidence, never fleet or runtime authority.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { verifyHeldEnginePublisherRun } from "./paired-runtime-github.mjs"
import { protectedGh } from "./protected-gh.mjs"
import verifierPolicy from "./independent-inventory-policy.json" with { type: "json" }
import {
  verifyInventoryAttestation,
  verifySandboxCoveragePublication,
} from "./runtime-qualification-foundation.mjs"

export const INVENTORY_PREDICATE_TYPE =
  "https://lyrashieldai.com/attestations/sandbox-independent-inventory/v1"
// Exact reviewed engine tree. Update only with independent review of the complete verifier.
export const INVENTORY_VERIFIER_TREE = verifierPolicy.tree
// Generated from the exact reviewed engine tree's committed file bytes.
export const INVENTORY_VERIFIER_FILE_HASHES = Object.freeze({ ...verifierPolicy.files })
export const INVENTORY_VERIFIER_FILES = Object.freeze(Object.keys(INVENTORY_VERIFIER_FILE_HASHES))
const repo = "ecryptoguru/lyrashield-engine"
const image = "ghcr.io/ecryptoguru/lyrashield-sandbox"
const digest = /^sha256:[a-f0-9]{64}$/
const limits = Object.freeze({
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
})
const limitations = [
  "Only Debian status, declared Python/npm metadata roots and twelve pinned Go files",
  "Conservative OCI header model; unsupported changesets fail closed",
  "Header/link/package and Go parsers are shared with the bounded producer oracle",
  "No Linux runtime overlay, capability state or image-wide completeness proof",
  "No benchmark, adversarial robustness or production promotion qualification",
]

function exact(value, fields) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype)
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort())
}
function read(path) {
  return JSON.parse(protectedGh(["api", "--hostname", "github.com", `repos/${repo}/${path}`]))
}

function verifyVerifierCi(revision, get) {
  const ancestry = get(`compare/${revision}...main`)
  assert.ok(
    ancestry?.merge_base_commit?.sha === revision &&
      ["ahead", "identical"].includes(ancestry.status)
  )
  const workflow = get("actions/workflows/ci.yml")
  assert.ok(
    Number.isSafeInteger(workflow?.id) &&
      workflow.id > 0 &&
      workflow.path === ".github/workflows/ci.yml"
  )
  const list = get(
    `actions/workflows/${workflow.id}/runs?event=push&head_sha=${revision}&per_page=100`
  )
  assert.ok(
    Number.isSafeInteger(list?.total_count) &&
      list.total_count > 0 &&
      list.total_count <= 100 &&
      Array.isArray(list.workflow_runs) &&
      list.workflow_runs.length === list.total_count
  )
  assert.ok(list.workflow_runs.every((run) => Number.isSafeInteger(run.id) && run.id > 0))
  const sorted = [...list.workflow_runs].sort((a, b) => b.id - a.id)
  assert.ok(sorted.length === 1 || sorted[0].id !== sorted[1].id)
  const runId = sorted[0].id
  const current = get(`actions/runs/${runId}`)
  assert.ok(Number.isSafeInteger(current?.run_attempt) && current.run_attempt > 0)
  const attempt = get(`actions/runs/${runId}/attempts/${current.run_attempt}`)
  for (const item of [current, attempt]) {
    assert.ok(
      item?.id === runId &&
        item.workflow_id === workflow.id &&
        item.run_attempt === current.run_attempt &&
        item.status === "completed" &&
        item.conclusion === "success" &&
        item.event === "push" &&
        item.head_branch === "main" &&
        item.head_sha === revision &&
        item.path === ".github/workflows/ci.yml" &&
        item.repository?.id === 1297157605 &&
        item.head_repository?.id === 1297157605
    )
  }
  return `${runId}:${current.run_attempt}`
}

export function verifyIndependentSandboxInventory(
  expected,
  {
    when = Date.now(),
    run = protectedGh,
    read: get = read,
    verifyPublication = verifySandboxCoveragePublication,
    verifyPublisher = verifyHeldEnginePublisherRun,
  } = {}
) {
  exact(expected, [
    "engineRevision",
    "publicationRevision",
    "publishRunId",
    "publishAttempt",
    "sandboxDigest",
    "verifierRevision",
    "verifierRunId",
    "verifierAttempt",
  ])
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(expected)))
    assert.ok(Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string")
  for (const field of ["engineRevision", "publicationRevision", "verifierRevision"])
    assert.match(expected[field], /^[a-f0-9]{40}$/)
  for (const field of ["publishRunId", "publishAttempt", "verifierRunId", "verifierAttempt"])
    assert.match(expected[field], /^[1-9][0-9]{0,19}$/)
  assert.match(expected.sandboxDigest, digest)
  assert.ok(Number.isSafeInteger(when) && when > 0)
  const publicationSelector = Object.fromEntries(
    [
      "engineRevision",
      "publicationRevision",
      "publishRunId",
      "publishAttempt",
      "sandboxDigest",
    ].map((key) => [key, expected[key]])
  )
  verifyPublisher(expected.publishRunId, expected.publishAttempt, expected.publicationRevision)
  const publication = verifyPublication(publicationSelector, { run, when })
  assert.equal(publication.qualified, false)
  assert.equal(publication.nativeInventoryRechecked, false)
  assert.equal(publication.signedBoundedCoverageVerified, true)
  const source = get(`git/commits/${expected.verifierRevision}`)
  assert.match(INVENTORY_VERIFIER_TREE, /^[a-f0-9]{40}$/)
  assert.equal(source?.sha, expected.verifierRevision)
  assert.equal(source?.tree?.sha, INVENTORY_VERIFIER_TREE)
  const verifierCi = verifyVerifierCi(expected.verifierRevision, get)
  const verifierRun = get(
    `actions/runs/${expected.verifierRunId}/attempts/${expected.verifierAttempt}`
  )
  assert.ok(
    String(verifierRun?.id) === expected.verifierRunId &&
      String(verifierRun?.run_attempt) === expected.verifierAttempt &&
      verifierRun.status === "completed" &&
      verifierRun.conclusion === "success" &&
      verifierRun.event === "workflow_dispatch" &&
      verifierRun.head_branch === "main" &&
      verifierRun.head_sha === expected.verifierRevision &&
      verifierRun.path === ".github/workflows/verify-sandbox-inventory.yml" &&
      verifierRun.repository?.id === 1297157605 &&
      verifierRun.head_repository?.id === 1297157605
  )
  const verifier = {
    publicationRevision: expected.verifierRevision,
    publishRunId: expected.verifierRunId,
    publishAttempt: expected.verifierAttempt,
    sandboxDigest: expected.sandboxDigest,
  }
  const predicate = verifyInventoryAttestation(verifier, { run, when })
  exact(predicate, [
    "schema",
    "status",
    "indexDigest",
    "engineRevision",
    "workflowRevision",
    "image",
    "runId",
    "runAttempt",
    "sourceFiles",
    "goToolSha256",
    "ghToolSha256",
    "limits",
    "platforms",
    "limitations",
    "releaseQualified",
    "verifier",
  ])
  assert.equal(predicate.schema, "lyrashield.sandbox.independent-package-inventory.v1")
  assert.equal(predicate.status, "bounded_scope_matched")
  for (const [key, value] of Object.entries({
    indexDigest: expected.sandboxDigest,
    engineRevision: expected.engineRevision,
    workflowRevision: expected.publicationRevision,
    image,
    runId: expected.publishRunId,
    runAttempt: expected.publishAttempt,
  }))
    assert.equal(predicate[key], value)
  assert.equal(
    predicate.goToolSha256,
    "5f5eb6d0b2fb6aa0bb5d5f8c5f1c944e0de955c925f0111af92a9d8f79680b5b"
  )
  assert.equal(
    predicate.ghToolSha256,
    "62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617"
  )
  assert.deepEqual(predicate.limits, limits)
  assert.deepEqual(predicate.limitations, limitations)
  assert.equal(predicate.releaseQualified, false)
  exact(predicate.verifier, [
    "repositoryId",
    "ownerId",
    "revision",
    "tree",
    "workflow",
    "runId",
    "runAttempt",
    "sourceFiles",
  ])
  for (const [key, value] of Object.entries({
    repositoryId: "1297157605",
    ownerId: "116722580",
    revision: expected.verifierRevision,
    tree: INVENTORY_VERIFIER_TREE,
    workflow: ".github/workflows/verify-sandbox-inventory.yml",
    runId: expected.verifierRunId,
    runAttempt: expected.verifierAttempt,
  }))
    assert.equal(predicate.verifier[key], value)
  exact(predicate.verifier.sourceFiles, INVENTORY_VERIFIER_FILES)
  assert.deepEqual(predicate.verifier.sourceFiles, INVENTORY_VERIFIER_FILE_HASHES)
  exact(predicate.sourceFiles, [
    "containers/go-tools/applications.json",
    "containers/go-tools/distro/applications.cdx.json",
  ])
  for (const value of Object.values(predicate.sourceFiles)) assert.match(value, digest)
  exact(predicate.platforms, ["amd64", "arm64"])
  for (const arch of ["amd64", "arm64"]) {
    const entry = predicate.platforms[arch],
      binding = publication.inventoryBindings[arch]
    exact(entry, [
      "manifestDigest",
      "configDigest",
      "spdxDocumentDigest",
      "inventoryCounts",
      "goApplications",
      "layers",
      "finalHeaders",
    ])
    for (const key of ["manifestDigest", "configDigest", "spdxDocumentDigest"])
      assert.equal(entry[key], binding[key])
    assert.ok(
      isDeepStrictEqual(entry.goApplications, binding.goApplications) &&
        entry.goApplications.length === 12
    )
    exact(entry.inventoryCounts, ["deb", "pypi", "npm", "goApplications"])
    for (const key of ["deb", "pypi", "npm"])
      assert.ok(Number.isSafeInteger(entry.inventoryCounts[key]) && entry.inventoryCounts[key] > 0)
    assert.equal(entry.inventoryCounts.goApplications, 12)
    assert.ok(Number.isSafeInteger(entry.layers) && entry.layers > 0 && entry.layers <= 128)
    assert.ok(
      Number.isSafeInteger(entry.finalHeaders) &&
        entry.finalHeaders > 0 &&
        entry.finalHeaders <= limits.finalHeaders
    )
  }
  assert.equal(verifyVerifierCi(expected.verifierRevision, get), verifierCi)
  return Object.freeze({
    ...expected,
    qualified: false,
    nativeInventoryRechecked: true,
    runtimeAuthorityVerified: false,
    coveragePredicateChecksum: publication.coveragePredicateChecksum,
    inventoryPredicateChecksum: createHash("sha256")
      .update(JSON.stringify(predicate))
      .digest("hex"),
    nativeManifests: publication.nativeManifests,
  })
}
