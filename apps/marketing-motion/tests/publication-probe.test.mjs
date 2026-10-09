import assert from "node:assert/strict"
import test from "node:test"
import { assertObjectAbsent } from "../scripts/publication-probe.mjs"
test("publication fails closed on existing objects, authentication and network failures", () => {
  assert.doesNotThrow(() =>
    assertObjectAbsent({ status: 1, stderr: "HTTP 404 object not found" }, "render")
  )
  assert.doesNotThrow(() =>
    assertObjectAbsent(
      { status: 1, stderr: "\u001b[31m[ERROR]\u001b[0m The specified key does not exist." },
      "render"
    )
  )
  for (const result of [
    { status: 0 },
    { status: 1, stderr: "403 unauthorized" },
    { status: 1, stderr: "connection timed out" },
    { status: null, signal: "SIGTERM", stderr: "404" },
    { status: 2, stderr: "404 object not found" },
    { status: null, error: new Error("spawn failed"), stderr: "404 object not found" },
  ])
    assert.throws(() => assertObjectAbsent(result, "render"))
})
