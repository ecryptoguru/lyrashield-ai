import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// A8/A20: AGENTS.md claimed markdownlint runs in CI (it does not) and named
// `verify:launch-assurance` as a bare command (only apps/worker defines it).
// These assertions keep the corrected statements from drifting back.
const agents = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8")
const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
)
const workerPackage = JSON.parse(
  readFileSync(new URL("../../../apps/worker/package.json", import.meta.url), "utf8")
)
const markdownlintConfig = readFileSync(
  new URL("../../../.markdownlint-cli2.jsonc", import.meta.url),
  "utf8"
)

function ciWorkflow() {
  return readFileSync(new URL("../../workflows/ci.yml", import.meta.url), "utf8")
}

test("AGENTS.md no longer claims markdownlint is wired into CI", () => {
  assert.doesNotMatch(agents, /lint:md[^\n]*wired non-blocking in CI/)
  assert.match(agents, /`pnpm lint:md`[^\n]*No CI job runs it/)
  assert.doesNotMatch(markdownlintConfig, /Runs as a non-blocking CI check/)
})

test("markdownlint is a real manual script that no workflow invokes", () => {
  assert.equal(rootPackage.scripts["lint:md"], "markdownlint-cli2")
  assert.ok(rootPackage.devDependencies["markdownlint-cli2"])
  const ci = ciWorkflow()
  assert.doesNotMatch(ci, /lint:md/)
  assert.doesNotMatch(ci, /markdownlint/)
})

test("AGENTS.md names verify:launch-assurance with its worker filter", () => {
  assert.doesNotMatch(agents, /^- `verify:launch-assurance`/m)
  assert.match(
    agents,
    /`pnpm --filter @lyrashield\/worker verify:launch-assurance`[^\n]*apps\/worker\/package\.json/
  )
  assert.equal(
    rootPackage.scripts["verify:launch-assurance"],
    undefined,
    "the root package must not gain a script it never had"
  )
  assert.ok(workerPackage.scripts["verify:launch-assurance"])
})

test("AGENTS.md records the knip report and the per-job timeouts", () => {
  assert.match(agents, /`pnpm lint:knip`[^\n]*non-blocking/)
  assert.match(agents, /Every job declares its own `timeout-minutes`/)
  assert.equal(rootPackage.scripts["lint:knip"], "knip --no-exit-code")
})
