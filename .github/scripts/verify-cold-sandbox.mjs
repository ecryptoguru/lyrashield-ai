// Immutable publication selectors are reauthenticated on every release, without a TTL.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { verifyIndependentSandboxInventory } from "./independent-sandbox-inventory.mjs"
import { protectedGh } from "./protected-gh.mjs"
import {
  SBOM_COVERAGE_PREDICATE_TYPE,
  verifySandboxSbomCoverage,
} from "../../apps/worker/src/engine/sandbox-sbom-coverage.ts"
import { verifySandboxCoveragePublication } from "./runtime-qualification-foundation.mjs"

export function verifyColdSandbox(
  selector,
  engineRevision,
  {
    verifyInventory = verifyIndependentSandboxInventory,
    verifyPublication = verifySandboxCoveragePublication,
    docker = (args) =>
      execFileSync("docker", args, {
        timeout: 300000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
  } = {}
) {
  assert.equal(selector.engineRevision, engineRevision)
  const inventory = verifyInventory(selector)
  assert.equal(inventory.qualified, false)
  assert.equal(inventory.nativeInventoryRechecked, true)
  const publication = verifyPublication(
    Object.fromEntries(
      [
        "engineRevision",
        "publicationRevision",
        "publishRunId",
        "publishAttempt",
        "sandboxDigest",
      ].map((key) => [key, selector[key]])
    )
  )
  assert.equal(publication.signedBoundedCoverageVerified, true)
  const sandboxImage = "ghcr.io/ecryptoguru/lyrashield-sandbox@" + selector.sandboxDigest
  const manifest = "ghcr.io/ecryptoguru/lyrashield-sandbox@" + inventory.nativeManifests.amd64
  const native = JSON.parse(docker(["buildx", "imagetools", "inspect", manifest, "--raw"]))
  assert.equal(native.config?.digest, publication.inventoryBindings.amd64.configDigest)
  docker(["pull", "--platform", "linux/amd64", sandboxImage])
  const images = JSON.parse(docker(["image", "inspect", sandboxImage]))
  assert.equal(images.length, 1)
  assert.equal(images[0].Architecture, "amd64")
  assert.equal(images[0].Os, "linux")
  if (images[0].Id !== native.config.digest) {
    // The containerd image store reports its immutable index as Image.Id.
    // Authenticate that actual store mode and its selected native descriptor.
    assert.equal(images[0].Id, selector.sandboxDigest)
    const status = JSON.parse(docker(["info", "--format", "{{json .DriverStatus}}"]))
    assert.ok(
      status.some((row) => row[0] === "driver-type" && row[1] === "io.containerd.snapshotter.v1")
    )
    const index = JSON.parse(docker(["buildx", "imagetools", "inspect", sandboxImage, "--raw"]))
    const selected = index.manifests.filter(
      (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64"
    )
    assert.equal(selected.length, 1)
    assert.equal(selected[0].digest, inventory.nativeManifests.amd64)
  }
  assert.ok(images[0].RepoDigests.includes(sandboxImage))
  return {
    sandboxImage,
    nativeManifest: inventory.nativeManifests.amd64,
    configDigest: native.config.digest,
    inventoryPredicateChecksum: inventory.inventoryPredicateChecksum,
    coveragePredicateChecksum: inventory.coveragePredicateChecksum,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const selector = JSON.parse(
      readFileSync(new URL("../cold-sandbox-publication.json", import.meta.url), "utf8")
    )
    const result = verifyColdSandbox(selector, process.env.EXPECTED_ENGINE_REVISION)
    const records = JSON.parse(
      protectedGh([
        "attestation",
        "verify",
        "oci://" + result.sandboxImage,
        "--bundle-from-oci",
        "--hostname",
        "github.com",
        "--repo",
        "ecryptoguru/lyrashield-engine",
        "--cert-identity",
        "https://github.com/ecryptoguru/lyrashield-engine/.github/workflows/publish-sandbox.yml@refs/heads/main",
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--signer-digest",
        selector.publicationRevision,
        "--source-digest",
        selector.publicationRevision,
        "--source-ref",
        "refs/heads/main",
        "--predicate-type",
        SBOM_COVERAGE_PREDICATE_TYPE,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ])
    )
    assert.equal(records.length, 1)
    const expectedAggregate = records[0]?.verificationResult?.statement?.predicate
    verifySandboxSbomCoverage({
      records,
      expectedAggregate,
      identity: {
        engineRevision: selector.engineRevision,
        workflowRevision: selector.publicationRevision,
        runId: selector.publishRunId,
        runAttempt: selector.publishAttempt,
        indexDigest: selector.sandboxDigest,
      },
      imageName: "ghcr.io/ecryptoguru/lyrashield-sandbox",
      repo: "ecryptoguru/lyrashield-engine",
      revision: selector.publicationRevision,
      ref: "refs/heads/main",
    })
    mkdirSync(process.env.RUNNER_TEMP + "/cold-sandbox", { mode: 0o700 })
    writeFileSync(
      process.env.RUNNER_TEMP + "/cold-sandbox/verification.json",
      JSON.stringify(records) + "\n",
      { mode: 0o444, flag: "wx" }
    )
    writeFileSync(
      process.env.RUNNER_TEMP + "/cold-sandbox/expected.json",
      JSON.stringify(expectedAggregate) + "\n",
      { mode: 0o444, flag: "wx" }
    )
    writeFileSync(
      process.env.RUNNER_TEMP + "/cold-sandbox-publication.json",
      JSON.stringify(result) + "\n",
      { mode: 0o600, flag: "wx" }
    )
    appendFileSync(process.env.GITHUB_OUTPUT, "sandbox_image=" + result.sandboxImage + "\n")
    console.log("Authenticated immutable sandbox publication and Linux image binding")
  } catch {
    console.error("Cold sandbox publication or native image binding verification failed")
    process.exitCode = 1
  }
}
