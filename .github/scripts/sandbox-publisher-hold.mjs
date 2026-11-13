// Policy for the reviewed publisher's deliberate post-evidence promotion hold.
// Its inputs must come from authenticated GitHub API responses, not caller JSON.
import assert from "node:assert/strict"

const reviewedWorkflowBlob = "77361a87c6c7b4e2b11c79a69b9e574fd326a0d0"
const required = [
  "Assemble and verify qualified platform index",
  "Generate per-platform SPDX SBOMs",
  "Attach and validate complete SBOM artifact",
  "Sign provenance for the immutable image digest",
  "Sign selected runtime and qualified platform binding",
  "Sign per-platform SBOM binding",
  "Verify signed sandbox publication",
  "Qualify bounded SBOM coverage on both native images",
  "Assemble bounded SBOM coverage predicate",
  "Sign bounded SBOM coverage qualification",
  "Verify signed sandbox publication coverage",
  "Upload bounded SBOM coverage evidence",
]
const hold = "Hold promotion pending independent package coverage"
const skipped = ["Promote the smoke-qualified digest", "Record deployable immutable reference"]
const jobNames = [
  "Resolve qualified engine revision",
  "Build sandbox (amd64)",
  "Build sandbox (arm64)",
  "Publish qualified sandbox index",
]

export function assertExpectedPublisherHold(
  { run, jobs, workflowBlob },
  { source, runId, attempt }
) {
  assert.match(source, /^[a-f0-9]{40}$/)
  assert.match(runId, /^[1-9][0-9]{0,19}$/)
  assert.match(attempt, /^[1-9][0-9]{0,19}$/)
  assert.equal(workflowBlob?.sha, reviewedWorkflowBlob)
  assert.ok(
    String(run?.id) === runId &&
      String(run?.run_attempt) === attempt &&
      run.status === "completed" &&
      run.conclusion === "failure" &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.head_sha === source &&
      run.path === ".github/workflows/publish-sandbox.yml" &&
      run.repository?.id === 1297157605 &&
      run.head_repository?.id === 1297157605
  )
  assert.ok(jobs?.total_count === 4 && Array.isArray(jobs.jobs) && jobs.jobs.length === 4)
  assert.deepEqual(jobs.jobs.map((job) => job.name).sort(), [...jobNames].sort())
  for (const job of jobs.jobs) {
    const publish = job.name === "Publish qualified sandbox index"
    assert.ok(job.status === "completed" && job.conclusion === (publish ? "failure" : "success"))
    assert.ok(Array.isArray(job.steps) && job.steps.length > 0)
    const names = job.steps.map((step) => step.name)
    const numbers = job.steps.map((step) => step.number)
    assert.ok(numbers.every(Number.isSafeInteger))
    assert.ok(
      numbers.every((number, index) => number > 0 && (index === 0 || number > numbers[index - 1]))
    )
    if (publish) {
      for (const name of [...required, hold, ...skipped])
        assert.equal(names.filter((value) => value === name).length, 1)
      const order = [...required, hold].map((name) => names.indexOf(name))
      assert.ok(order.every((number, index) => index === 0 || number > order[index - 1]))
      assert.ok(skipped.every((name) => names.indexOf(name) > names.indexOf(hold)))
    }
    for (const step of job.steps) {
      const conclusion =
        publish && step.name === hold
          ? "failure"
          : publish && skipped.includes(step.name)
            ? "skipped"
            : "success"
      assert.ok(step.status === "completed" && step.conclusion === conclusion)
    }
  }
}
