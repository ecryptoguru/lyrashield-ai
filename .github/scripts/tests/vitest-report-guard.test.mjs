import assert from "node:assert/strict"
import test from "node:test"
import { assertNamedTestsPassed } from "../assert-named-vitest-tests.mjs"

const report = (assertionResults) => ({
  testResults: [{ assertionResults }],
})

test("accepts named required tests and leaves unrelated expected skips alone", () => {
  assert.doesNotThrow(() =>
    assertNamedTestsPassed(
      report([
        { fullName: "RLS proof binds the restricted role", status: "passed" },
        { fullName: "Darwin-only temp path behavior", status: "skipped" },
      ]),
      ["RLS proof binds the restricted role"]
    )
  )
})

test("rejects a named required test reported as skipped", () => {
  assert.throws(
    () =>
      assertNamedTestsPassed(
        report([{ fullName: "RLS proof binds the restricted role", status: "skipped" }]),
        ["RLS proof binds the restricted role"]
      ),
    /Expected exactly one passing test/
  )
})

test("rejects missing and ambiguous required test names", () => {
  assert.throws(
    () => assertNamedTestsPassed(report([]), ["restricted role"]),
    /Expected exactly one passing test/
  )
  assert.throws(
    () =>
      assertNamedTestsPassed(
        report([
          { fullName: "RLS proof binds restricted role", status: "passed" },
          { fullName: "another RLS proof binds restricted role", status: "passed" },
        ]),
        ["restricted role"]
      ),
    /Expected exactly one passing test/
  )
})
