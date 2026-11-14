import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)
const { parse } = require("yaml")
// The test passes only fixed repository workflow paths below.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const read = (path) => parse(readFileSync(path, "utf8"))
test("qualified normal releases consume exactly one rehearsed prebuilt image tuple", () => {
  const prep = read(".github/workflows/prepare-worker-recovery-candidate.yml")
  const release = read(".github/workflows/release-production.yml")
  const deploy = read(".github/workflows/deploy-azure.yml")
  const steps = prep.jobs.build.steps
  const index = (name) => steps.findIndex((step) => step.name === name)
  assert.ok(index("Qualify exact merged source against required PR checks") >= 0)
  assert.ok(
    index("Qualify exact merged source against required PR checks") < index("Build web candidate")
  )
  assert.ok(
    index("Verify the exact prepared web and worker image contracts") >
      index("Bind exact candidate digests")
  )
  assert.match(
    steps[index("Build worker candidate")].with.labels,
    /io\.lyrashield\.accounting\.protocol=reservations\/2/
  )
  assert.ok(
    release.jobs.routing.steps.some((step) => step.run?.includes("qualify-release-source.mjs"))
  )
  assert.equal(release.jobs["deploy-azure"].with.cold_release, true)
  const hold = deploy.jobs["preflight-compatible-baseline"].steps.find(
    (step) => step.name === "Hold HA and retained release lanes"
  )
  assert.equal(hold.if, "inputs.cold_release != true")
  assert.ok(deploy.on.workflow_call.inputs.prepared_candidate_run_id)
  assert.ok(deploy.on.workflow_call.inputs.prepared_candidate_run_attempt)
  assert.ok(deploy.jobs.build.if.includes("inputs.qualified_release_digest == ''"))
  assert.ok(
    deploy.jobs["resolve-prepared-images"].if.includes("inputs.prepared_candidate_run_id != ''")
  )
  const preflight = deploy.jobs["preflight-compatible-baseline"].steps
  assert.ok(preflight.some((step) => step.run?.includes("--paired-candidate")))
  assert.ok(preflight.some((step) => step.run?.includes("paired-prepared-candidate.mjs")))
  assert.ok(
    deploy.jobs["resolve-images"].steps.find((step) => step.id === "select").env.PAIRED_PREPARED
  )
})
