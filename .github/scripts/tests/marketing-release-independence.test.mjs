import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"

const require = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)
const { parse } = require("yaml")
const release = parse(readFileSync(".github/workflows/release-production.yml", "utf8"))
const marketing = parse(readFileSync(".github/workflows/deploy-marketing.yml", "utf8"))

test("source qualification and classification run before independent release routing", () => {
  const routing = release.jobs.routing
  assert.deepEqual(
    routing.steps.map((step) => step.name),
    [
      "Checkout merged source",
      "Qualify merged source against required PR checks",
      "Classify changes since successful production releases",
    ]
  )
  assert.equal(routing.steps[0].with.ref, "${{ github.sha }}")
  assert.equal(routing.steps[1].run, "node .github/scripts/qualify-release-source.mjs")
  assert.equal(routing.steps[1].if, undefined)
  assert.equal(routing.steps[1]["continue-on-error"], undefined)
  assert.equal(routing.steps[2].run, "bash .github/scripts/classify-main-change-gap.sh")
  assert.equal(routing.steps[2].if, undefined)
  assert.equal(routing.steps[2]["continue-on-error"], undefined)
})

test("marketing route depends only on successful routing, even when Azure qualification fails", () => {
  const job = release.jobs["deploy-marketing"]
  assert.equal(job.needs, "routing")
  assert.equal(job.uses, "./.github/workflows/deploy-marketing.yml")
  assert.equal(job.with.source_sha, "${{ github.sha }}")
  for (const [current, selected, expected] of [
    ["true", "true", true],
    ["false", "true", false],
    ["true", "false", false],
  ]) {
    const expression = job.if.replace(/needs\.routing\.outputs\.([a-z-]+)/g, (_, key) =>
      JSON.stringify({ "current-main": current, "marketing-deploy": selected }[key])
    )
    assert.equal(runInNewContext(expression, {}, { timeout: 100 }), expected)
  }
})

test("marketing deploy retains its current-source and environment gates without a runtime hold", () => {
  const source = marketing.jobs.source.steps.find((step) => step.id === "source")
  const deploy = marketing.jobs["deploy-marketing"]
  assert.match(source.run, /SOURCE_SHA.*latest_main/)
  assert.equal(deploy.needs, "source")
  assert.equal(deploy.if, "needs.source.outputs.current == 'true'")
  assert.equal(deploy.environment.name, "cloudflare-production")
  assert.ok(
    !deploy.steps.some((step) => step.name === "Hold production until runtime qualification")
  )
  const checkout = deploy.steps.find((step) => step.name === "Checkout")
  assert.equal(checkout.with.ref, "${{ inputs.source_sha }}")
})
