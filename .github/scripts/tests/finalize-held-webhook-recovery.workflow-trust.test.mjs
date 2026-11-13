import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const workflow = readFileSync(
  new URL("../../workflows/finalize-held-webhook-recovery.yml", import.meta.url),
  "utf8"
)
const source = "a".repeat(40)
const match = workflow.match(
  /      - name: Verify trusted main source before checkout\n        env:\n          OPS_SHA: \$\{\{ inputs\.operations_sha \}\}\n        run: \|\n((?:          [^\n]*\n)+)      - name: Check out exact current main operations source/
)

test("trusted current-main gate runs before checkout and Azure OIDC", () => {
  assert.match(
    workflow,
    /    if: github\.ref == 'refs\/heads\/main' && inputs\.operations_sha == github\.sha/
  )
  assert.ok(match, "trusted inline gate must directly precede checkout")
  assert.match(
    workflow,
    /      - name: Check out exact current main operations source[\s\S]*?          ref: \$\{\{ github\.sha \}\}/
  )
  assert.ok(
    workflow.indexOf("Verify trusted main source before checkout") <
      workflow.indexOf("Log in to Azure with production OIDC identity")
  )
})

test("inline gate accepts only the exact trusted main run commit", () => {
  assert.ok(match)
  const script = match[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join("\n")
  const run = (ops, sha, ref) =>
    spawnSync("bash", ["-e", "-c", script], {
      env: { OPS_SHA: ops, GITHUB_SHA: sha, GITHUB_REF: ref },
      encoding: "utf8",
    })
  assert.equal(run(source, source, "refs/heads/main").status, 0)
  for (const [ops, sha, ref] of [
    ["b".repeat(40), source, "refs/heads/main"],
    [source, source, "refs/heads/feature"],
    ["bad; echo unexpected", source, "refs/heads/main"],
    [source.slice(1), source, "refs/heads/main"],
  ]) {
    const result = run(ops, sha, ref)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
  }
})
