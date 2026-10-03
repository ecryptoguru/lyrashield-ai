import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workflow = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")

const jobSection = (name) => {
  const section = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:/)[0]
  assert.ok(section, `expected job ${name}`)
  return section
}

test("dependency installation runs in a job without production credentials", () => {
  const preparation = jobSection("prepare-dependencies")
  const deployment = jobSection("deploy")

  assert.match(preparation, /pnpm install --frozen-lockfile/)
  assert.doesNotMatch(preparation, /id-token:\s*write|environment:/)
  assert.match(preparation, /^    permissions:\n      contents: read$/m)

  assert.match(deployment, /^    needs: prepare-dependencies$/m)
  assert.doesNotMatch(deployment, /pnpm install|npm ci/)
  assert.match(deployment, /actions\/download-artifact@/)
  assert.match(deployment, /migration-dependencies-\$\{\{ inputs\.source_sha \}\}/)
  assert.match(deployment, /EXPECTED_ARCHIVE_SHA/)
})

test("every checkout is immutable and does not persist a GitHub credential", () => {
  const checkouts = workflow
    .split("\n      - name: ")
    .filter((step) => /uses: actions\/checkout@/.test(step))
  assert.ok(checkouts.length >= 2, "expected preparation and deployment checkouts")
  for (const checkout of checkouts) {
    const inputs = checkout.split("\n        with:\n")[1]?.split("\n      - name: ")[0] ?? ""
    assert.match(inputs, /persist-credentials: false/)
  }
})

test("prepared dependencies are bound to the deployed source and lockfile", () => {
  const preparation = jobSection("prepare-dependencies")
  assert.match(preparation, /ref: \$\{\{ inputs\.source_sha \}\}/)
  assert.match(preparation, /git rev-parse HEAD/)
  assert.match(preparation, /sha256sum pnpm-lock\.yaml/)
  assert.match(preparation, /actions\/upload-artifact@/)
  assert.match(preparation, /migration-dependencies-\$\{\{ inputs\.source_sha \}\}/)
})
