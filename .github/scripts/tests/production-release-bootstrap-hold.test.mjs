import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const workflows = [
  ["release-production.yml", "routing"],
  ["deploy-azure.yml", "preflight-compatible-baseline"],
  ["deploy-azure-runtime.yml", "prepare-dependencies"],
  ["deploy-azure-runtime.yml", "deploy"],
  ["deploy-marketing.yml", "deploy-marketing"],
  ["finalize-held-webhook-recovery.yml", "finalize"],
]

function firstStepInSource(source, workflow, jobName) {
  const job = source.match(
    new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m")
  )?.[1]
  assert.ok(job, `${workflow}: ${jobName} must exist`)
  const steps = job.match(/^    steps:\n([\s\S]*)/m)?.[1]
  assert.ok(steps, `${workflow}: ${jobName} must have steps`)
  const entry = steps.match(/^      -([^\n]*)\n([\s\S]*?)(?=^      -(?:\s|$)|(?![\s\S]))/m)
  if (!entry) return null
  const name = entry[1].match(/^\s+name:\s+(.+)$/)?.[1]
  return [entry[0], name, entry[2]]
}

function firstStep(workflow, jobName) {
  const source = readFileSync(new URL(`../../workflows/${workflow}`, import.meta.url), "utf8")
  return firstStepInSource(source, workflow, jobName)
}

for (const unnamed of ["run: echo bypass", "uses: actions/checkout@v4"]) {
  test(`does not overlook an unnamed ${unnamed.split(":")[0]} step before the hold`, () => {
    const source = `jobs:\n  routing:\n    steps:\n      - ${unnamed}\n      - name: Hold production until runtime qualification\n        run: exit 1\n`
    const step = firstStepInSource(source, "fixture.yml", "routing")
    assert.notEqual(step?.[1], "Hold production until runtime qualification")
  })
}

for (const [workflow, job] of workflows) {
  test(`${workflow} blocks production before any deployment action`, () => {
    const step = firstStep(workflow, job)
    assert.ok(step, "first step must exist")
    assert.equal(step[1], "Hold production until runtime qualification")
    assert.doesNotMatch(step[2], /^        (?:if|continue-on-error):/m)
    const block = step[2].match(/^        run: \|\n((?: {10}[^\n]*\n?)+)/m)?.[1]
    const script = block?.replace(/^ {10}/gm, "") ?? step[2].match(/^        run: (.+)$/m)?.[1]
    assert.ok(script, "the hold must run directly, before any checkout or credentials")
    const result = spawnSync("bash", ["-e", "-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    })
    assert.equal(result.status, 1, "the bootstrap hold must fail closed")
    if (result.stdout) assert.match(result.stdout, /production.*qualification/i)
  })
}
