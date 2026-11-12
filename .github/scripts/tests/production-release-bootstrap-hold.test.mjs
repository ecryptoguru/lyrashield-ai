import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { parseRetainedApproval } from "../retained-legacy-runtime.mjs"

const workflows = [
  ["release-production.yml", "qualify-azure-release"],
  ["release-retained-worker.yml", "approve"],
  ["deploy-azure.yml", "preflight-compatible-baseline"],
  ["deploy-azure-runtime.yml", "prepare-dependencies"],
  ["deploy-azure-runtime.yml", "deploy"],
  ["finalize-held-webhook-recovery.yml", "finalize"],
]

function firstStepInSource(source, workflow, jobName) {
  // Job names come only from the fixed workflow inventory above.
  const job = source.match(
    // eslint-disable-next-line security/detect-non-literal-regexp
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
  // Workflow names come only from the fixed source-controlled inventory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL(`../../workflows/${workflow}`, import.meta.url), "utf8")
  return firstStepInSource(source, workflow, jobName)
}

function holdScript(step) {
  const lines = step[2].split("\n")
  const start = lines.findIndex((line) => line.startsWith("        run: "))
  assert.notEqual(start, -1, "the hold must run directly, before any checkout or credentials")
  const command = lines[start].slice("        run: ".length)
  if (command !== "|") return command
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("          ")) break
    body.push(line.slice(10))
  }
  assert.ok(body.length, "the hold must have an executable body")
  return body.join("\n")
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
    assert.ok(
      !step[2]
        .split("\n")
        .some(
          (line) => line.startsWith("        if:") || line.startsWith("        continue-on-error:")
        )
    )
    const result = spawnSync("bash", ["-e", "-c", holdScript(step)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    })
    assert.equal(result.status, 1, "the bootstrap hold must fail closed")
    if (result.stdout) assert.match(result.stdout, /production.*qualification/i)
  })
}

test("operator approval and retained mode cannot bypass the retained release or either runtime hold", () => {
  const source = "a".repeat(40)
  const approval = {
    schema: "lyrashield-retained-worker/1",
    sourceSha: source,
    reviewedSourceSha: source,
    workerSourceSha: "b03f0bbe2b42f3a49e24e103655187372ba0a5f6",
    workerDigest: `sha256:${"b".repeat(64)}`,
    engineRevision: "3001517530300ca5f602536bfadcbd3c95ad3039",
    sandboxImage: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"c".repeat(64)}`,
    workerEnvironmentSha256: "d".repeat(64),
    egressDigest: `sha256:${"e".repeat(64)}`,
    egressSourceSha: "b03f0bbe2b42f3a49e24e103655187372ba0a5f6",
  }
  assert.deepEqual(parseRetainedApproval(JSON.stringify(approval), source), approval)
  for (const [workflow, job] of [
    ["release-retained-worker.yml", "approve"],
    ["deploy-azure-runtime.yml", "prepare-dependencies"],
    ["deploy-azure-runtime.yml", "deploy"],
  ]) {
    const step = firstStep(workflow, job)
    const result = spawnSync("bash", ["-e", "-c", holdScript(step)], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_REF: "refs/heads/main",
        RETAINED_WORKER: "true",
        RETAINED_WORKER_APPROVAL: JSON.stringify(approval),
        LYRASHIELD_RETAINED_WORKER_APPROVAL: JSON.stringify(approval),
        DEPLOY_SHA: source,
      },
    })
    assert.equal(result.status, 1, `${workflow}/${job} must reject a recorded legacy tuple`)
  }
})
