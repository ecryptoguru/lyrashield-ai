import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

test("production Python cold barrier ownership and durability regressions", () => {
  const result = spawnSync("python3", [".github/scripts/tests/cold-start-barrier.unit.py"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
