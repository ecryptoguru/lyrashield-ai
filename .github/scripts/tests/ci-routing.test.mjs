import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { runInNewContext } from "node:vm"

const workflow = readFileSync(new URL("../../workflows/ci.yml", import.meta.url), "utf8")
const steps = new Map(
  [...workflow.matchAll(/^      - name: (.+)\n        if: (.+)$/gm)].map((match) => [
    match[1],
    match[2],
  ])
)

function runs(name, paths) {
  const output = execFileSync("bash", [".github/scripts/classify-paths.sh"], {
    input: paths.join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "" },
  })
  const outputs = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("="))
  )
  assert.ok(steps.has(name), `Missing gated step: ${name}`)
  const expression = steps.get(name).replace(/needs\.changes\.outputs\.([\w-]+)/g, (_, key) => {
    assert.ok(key in outputs, `Unknown classifier output: ${key}`)
    return JSON.stringify(outputs[key])
  })
  return runInNewContext(expression, {}, { timeout: 100 })
}

const runtimeSteps = [
  "Migration drift check",
  "Run database migrations",
  "Prove metering and queue invariants with disposable services",
  "Trial integration tests (restricted runtime role)",
  "Agent operation workspace foreign key test",
  "Run required PostgreSQL regression tests",
  "Build app and shared packages",
  "Browser E2E (includes functional mobile shell at 390px)",
  "Portable browser harness",
]

test("known tooling retains executable operations checks without runtime suites", () => {
  const paths = [".github/workflows/ci.yml", "run-all-tests.mjs"]
  for (const name of ["Test affected suites", "Test Azure deployment and alert operations"]) {
    assert.equal(runs(name, paths), true, name)
  }
  for (const name of runtimeSteps) assert.equal(runs(name, paths), false, name)
})

test("runtime, mixed, dependency and unknown paths retain production regression gates", () => {
  for (const paths of [
    ["apps/worker/src/index.ts"],
    [".github/workflows/ci.yml", "apps/web/src/app/page.tsx"],
    ["pnpm-lock.yaml"],
    ["new-runtime-entrypoint.js"],
  ]) {
    for (const name of runtimeSteps) assert.equal(runs(name, paths), true, `${paths}: ${name}`)
  }
})
