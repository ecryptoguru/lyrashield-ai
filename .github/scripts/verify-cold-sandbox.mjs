// Immutable publication selectors are reauthenticated on every release, without a TTL.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { verifyIndependentSandboxInventory } from "./independent-sandbox-inventory.mjs"
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
  assert.equal(images[0].Id, native.config.digest)
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
