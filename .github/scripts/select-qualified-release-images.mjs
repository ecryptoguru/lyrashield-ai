import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assertRuntimeFleetQualification } from "./assert-runtime-fleet-qualification.mjs"

// The caller supplies no image names: the signed tuple chooses all digests.
export function selectQualifiedReleaseImages(envelope, expected, verifySignature) {
  const { fleet } = assertRuntimeFleetQualification(envelope, expected, verifySignature)
  assert.match(fleet.productRevision, /^[a-f0-9]{40}$/)
  assert.match(fleet.engineRevision, /^[a-f0-9]{40}$/)
  const root = "ghcr.io/ecryptoguru/lyrashield-ai"
  return {
    web_image: `${root}/lyrashield-web:${fleet.productRevision}`,
    web_digest: fleet.webDigest,
    worker_image: `${root}/lyrashield-worker:${fleet.productRevision}`,
    worker_digest: fleet.workerDigest,
    egress_proxy_image: `${root}/lyrashield-egress-proxy:${fleet.productRevision}`,
    egress_proxy_digest: fleet.proxyDigest,
    sandbox_digest: fleet.sandboxDigest,
    engine_revision: fleet.engineRevision,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GitHub output unavailable")
    const images = selectQualifiedReleaseImages(
      JSON.parse(process.env.RUNTIME_FLEET_QUALIFICATION ?? ""),
      {
        source: process.env.SOURCE_SHA ?? "",
        sourceTree: process.env.SOURCE_TREE ?? "",
        engineRevision: process.env.ENGINE_REVISION ?? "",
        recordSha256: process.env.RUNTIME_FLEET_RECORD_SHA256 ?? "",
      }
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Actions supplies its output file
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(images)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    )
  } catch {
    process.stderr.write("Qualified release image selection unavailable.\n")
    process.exitCode = 1
  }
}
