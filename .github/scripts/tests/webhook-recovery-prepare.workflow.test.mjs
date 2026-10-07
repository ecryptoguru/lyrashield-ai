import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workflow = readFileSync(".github/workflows/prepare-worker-recovery-candidate.yml", "utf8")
const dockerfile = readFileSync("Dockerfile", "utf8")

test("preparation is manual and binds dispatch to exact current main", () => {
  assert.match(workflow, /on:\n  workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^  (?:pull_request|push|schedule):/m)
  assert.match(workflow, /test "\$DISPATCH_REF" = refs\/heads\/main/)
  assert.match(workflow, /test "\$SOURCE_SHA" = "\$DISPATCH_SHA"/)
  assert.match(workflow, /commits\/main" --jq \.sha\)" = "\$SOURCE_SHA"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/)
})

test("preparation has registry permissions and no production access or operations", () => {
  assert.match(workflow, /packages: write/)
  assert.doesNotMatch(
    workflow,
    /id-token:|azure\/login|environment:|az (?:vm|containerapp|keyvault)/
  )
  assert.doesNotMatch(workflow, /webhook-claims-maintenance|promote-worker-vm|deploy-azure-runtime/)
  assert.doesNotMatch(workflow, /secrets\./)
})

test("all three candidate tags are unique and never overwrite release tags", () => {
  assert.match(workflow, /tag="candidate-\$SOURCE_SHA-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/)
  for (const image of ["web", "worker", "egress-proxy"]) {
    assert.match(workflow, new RegExp(`lyrashield-${image}:\\$tag`))
  }
  assert.doesNotMatch(workflow, /:latest|tags:.*\$\{\{ inputs\.source_sha \}\}/)
})

test("Docker targets exist and production provenance binds source and engine", () => {
  for (const target of ["runner", "worker", "egress-proxy"]) {
    assert.match(workflow, new RegExp(`target: ${target}\\n`))
    assert.match(dockerfile, new RegExp(` AS ${target}$`, "m"))
  }
  assert.match(workflow, /build-contexts: engine=lyrashield-engine/)
  assert.match(workflow, /io\.lyrashield\.engine\.revision=\$\{\{ env\.ENGINE_REVISION \}\}/)
  assert.equal((workflow.match(/org\.opencontainers\.image\.revision=/g) || []).length, 3)
})

test("receipt is published only after exact-digest worker rehearsal succeeds", () => {
  assert.match(workflow, /uses: \.\/\.github\/workflows\/verify-webhook-worker-image\.yml/)
  assert.match(workflow, /worker_image: \$\{\{ needs\.build\.outputs\.worker_image \}\}/)
  assert.match(workflow, /needs: \[build, rehearse\]/)
  assert.match(workflow, /\[\[ "\$digest" =~ \^sha256:\[a-f0-9\]\{64\}\$ \]\]/)
  for (const image of ["web", "worker", "egress-proxy"]) {
    assert.match(workflow, new RegExp(`lyrashield-${image}@\\$[A-Z_]+DIGEST`))
  }
  assert.match(workflow, /"schemaVersion": 1/)
  assert.match(workflow, /"sourceSha": os\.environ\["SOURCE_SHA"\]/)
  assert.match(workflow, /"runAttempt": int\(os\.environ\["GITHUB_RUN_ATTEMPT"\]\)/)
  assert.match(workflow, /name: webhook-recovery-candidate-\$\{\{ inputs\.source_sha \}\}/)
  assert.match(workflow, /path: recovery-candidate-receipt\.json/)
  assert.match(workflow, /if-no-files-found: error/)
})
