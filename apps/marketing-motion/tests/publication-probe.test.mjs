import assert from "node:assert/strict"
import test from "node:test"
import { assertObjectAbsent } from "../scripts/publication-probe.mjs"
test("publication fails closed on existing objects, authentication and network failures", () => {
  assert.doesNotThrow(() =>
    assertObjectAbsent({ status: 1, stderr: "HTTP 404 object not found" }, "render")
  )
  for (const result of [
    { status: 0 },
    { status: 1, stderr: "403 unauthorized" },
    { status: 1, stderr: "connection timed out" },
    { status: null, signal: "SIGTERM", stderr: "404" },
  ])
    assert.throws(() => assertObjectAbsent(result, "render"))
})
