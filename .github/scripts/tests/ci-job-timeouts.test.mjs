import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// P2-18: every job in ci.yml must bound its own runtime. Individual steps carry
// timeouts, but a hung step outside those six previously burned the 360-minute
// job default on a runner. PR #850 failed on a 15-minute "Install Playwright
// browser" step timeout, so the real incident is a stuck step, not a day-long
// lint run.
const workflow = readFileSync(new URL("../../workflows/ci.yml", import.meta.url), "utf8")

function jobBlocks(source) {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => line === "jobs:")
  assert.notEqual(start, -1, "ci.yml must declare jobs")
  const blocks = new Map()
  let name = null
  for (let index = start + 1; index < lines.length; index++) {
    const header = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[index] ?? "")
    if (header) {
      name = header[1]
      blocks.set(name, [])
      continue
    }
    if (name) blocks.get(name).push(lines[index] ?? "")
  }
  return new Map([...blocks].map(([key, body]) => [key, body.join("\n")]))
}

const jobs = jobBlocks(workflow)

test("every ci.yml job declares a bounded job-level timeout", () => {
  assert.ok(jobs.size > 0)
  for (const [name, body] of jobs) {
    const declared = /^ {4}timeout-minutes: ([0-9]+)$/m.exec(body)
    assert.ok(declared, `job ${name} must declare a job-level timeout-minutes`)
    const minutes = Number(declared[1])
    assert.ok(minutes >= 1, `job ${name} timeout must be at least one minute`)
    assert.ok(minutes <= 360, `job ${name} timeout must stay inside the runner ceiling`)
  }
})

test("the required aggregate contexts keep their names and fail-closed guards", () => {
  for (const [job, name] of [
    ["security", "SCA & Secret Scan"],
    ["lint-and-typecheck", "Lint, Typecheck, Test & Build"],
    ["engine-worker-contract", "Pinned Engine / Worker Contract"],
  ]) {
    assert.ok(jobs.has(job), `required job ${job} must stay in ci.yml`)
    assert.ok(
      jobs.get(job).split("\n").includes(`    name: ${name}`),
      `job ${job} must keep the required context name ${name}`
    )
  }

  const aggregate = jobs.get("lint-and-typecheck")
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m)
  assert.match(aggregate, /Workflow was cancelled before the required CI aggregate could run\./)
  assert.match(aggregate, /Changed-path classification did not succeed\./)
  assert.match(aggregate, /Workflow was cancelled while required CI checks were running\./)

  const contract = jobs.get("engine-worker-contract")
  assert.match(contract, /^ {4}if: \$\{\{ always\(\) && !cancelled\(\) \}\}$/m)
  assert.match(contract, /Changed-path classification did not succeed/)
})

test("the aggregate job keeps owning the full install, test and build work", () => {
  // The timeout work is not a licence to split, parallelise or reorder the
  // aggregate: it must still run the install, the suites and the build.
  const aggregate = jobs.get("lint-and-typecheck")
  for (const step of [
    "- name: Install dependencies",
    "- name: Test affected suites",
    "- name: Build app and shared packages",
    "- name: Portable browser harness",
  ]) {
    assert.ok(aggregate.includes(step), `aggregate must keep the step ${step}`)
  }
  assert.match(aggregate, /^ {4}needs: changes$/m)
})
