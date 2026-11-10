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

function firstStep(workflow, jobName) {
  const source = readFileSync(new URL(`../../workflows/${workflow}`, import.meta.url), "utf8")
  const job = source.match(
    new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m")
  )?.[1]
  assert.ok(job, `${workflow}: ${jobName} must exist`)
  const steps = job.match(/^    steps:\n([\s\S]*)/m)?.[1]
  assert.ok(steps, `${workflow}: ${jobName} must have steps`)
  return steps.match(/^      - name: ([^\n]+)\n([\s\S]*?)(?=^      - name: |(?![\s\S]))/m)
}

for (const [workflow, job] of workflows) {
  test(`${workflow} blocks production before any deployment action`, () => {
    const step = firstStep(workflow, job)
    assert.ok(step, "first step must exist")
    assert.equal(step[1], "Hold production until runtime qualification")
    assert.doesNotMatch(step[2], /^        (?:if|continue-on-error):/m)
    const script = step[2].match(/^        run: \|\n((?: {10}[^\n]*\n?)+)/m)?.[1]
    assert.ok(script, "the hold must run directly, before any checkout or credentials")
    const result = spawnSync("bash", ["-e", "-c", script.replace(/^ {10}/gm, "")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    })
    assert.equal(result.status, 1, "the bootstrap hold must fail closed")
    assert.match(result.stdout, /production.*qualification/i)
  })
}
