import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const lockfile = readFileSync("pnpm-lock.yaml", "utf8")
const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")

const isPatchedDevalue = (version) => {
  const [major, minor, patch] = version.split(".").map(Number)
  return major > 5 || (major === 5 && (minor > 9 || (minor === 9 && patch >= 2)))
}

test("all devalue lockfile resolutions include the security patch", () => {
  const versions = new Set(
    [...lockfile.matchAll(/^  devalue@(\d+\.\d+\.\d+):$/gm)].map((match) => match[1])
  )
  const references = [...lockfile.matchAll(/^\s+devalue: (\d+\.\d+\.\d+)$/gm)].map(
    (match) => match[1]
  )

  assert.ok(versions.size > 0, "expected a resolved devalue package")
  assert.ok(references.length > 0, "expected a dependency reference to devalue")
  for (const version of versions) {
    assert.ok(isPatchedDevalue(version), `devalue ${version} is below patched version 5.9.2`)
  }
  for (const version of references) assert.ok(versions.has(version))
})

test("all pinned deployment image builds generate BuildKit SBOM attestations", () => {
  const steps = [
    ...workflow.matchAll(/^      - name: Build and push (web|worker|egress-proxy) image$/gm),
  ]
  assert.deepEqual(
    steps.map((step) => step[1]),
    ["web", "worker", "egress-proxy"]
  )

  for (const step of steps) {
    const nextStep = workflow.indexOf("\n      - name:", step.index + step[0].length)
    const body = workflow.slice(step.index, nextStep)
    assert.match(
      body,
      /uses: docker\/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7\.4\.0/
    )
    assert.match(body, /^          push: true$/m)
    assert.match(body, /^          sbom: true$/m)
    assert.doesNotMatch(body, /^          provenance:/m)
  }
})

test("release summary records each image digest as both runtime identity and SBOM subject", () => {
  const start = workflow.indexOf("      - name: Image digests and SBOM attestation references")
  assert.notEqual(start, -1)
  const nextStep = workflow.indexOf("\n      - name:", start + 1)
  const summary = workflow.slice(start, nextStep)

  for (const [image, envPrefix] of [
    ["web", "WEB"],
    ["worker", "WORKER"],
    ["egress-proxy", "EGRESS_PROXY"],
  ]) {
    const imageReference = `\${${envPrefix}_IMAGE_REF}@\${${envPrefix}_DIGEST}`
    assert.ok(summary.includes(`${envPrefix}_DIGEST:`))
    assert.ok(summary.includes(`steps.build-${image}.outputs.digest`))
    assert.ok(summary.includes(`BuildKit SBOM attestation subject: ${imageReference}`))
  }

  assert.ok(
    workflow.includes(
      'worker_ref="${{ env.WORKER_IMAGE }}@${{ steps.build-worker.outputs.digest }}"'
    )
  )
  assert.ok(workflow.includes('docker pull "$worker_ref"'))
  assert.ok(
    workflow.includes(
      'bash apps/worker/scripts/verify-worker-image.sh \\\n            "$worker_ref"'
    )
  )
  assert.match(
    workflow,
    /bash \.github\/scripts\/validate-worker-provenance\.sh \\\n\s+"\$\{\{ steps\.build-worker\.outputs\.digest \}\}"/
  )
  assert.ok(
    workflow.includes(
      "IMAGE: ${{ needs.build.outputs.web_image }}@${{ needs.build.outputs.web_digest }}"
    )
  )
  assert.ok(
    workflow.includes(
      "IMAGE: ${{ needs.build.outputs.egress_proxy_image }}@${{ needs.build.outputs.egress_proxy_digest }}"
    )
  )
})
