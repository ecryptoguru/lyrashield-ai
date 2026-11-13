import assert from "node:assert/strict"
import test from "node:test"
import { compareKnipReport } from "../check-knip-baseline.mjs"

const reviewed = "fixture.ts:unlisted:react"
const baseline = { issues: [{ id: reviewed, reason: "Deliberate browser alias" }] }

test("reviewed findings tolerate source line movement; new and resolved findings are visible", () => {
  assert.deepEqual(
    compareKnipReport(
      { issues: [{ file: "fixture.ts", unlisted: [{ name: "react", line: 999 }] }] },
      baseline
    ),
    { added: [], resolved: [], current: 1 }
  )
  assert.deepEqual(
    compareKnipReport({ issues: [{ file: "new.ts", exports: [{ name: "unused" }] }] }, baseline),
    { added: ["new.ts:exports:unused"], resolved: [reviewed], current: 1 }
  )
})

test("baseline entries require unique IDs and a review rationale", () => {
  assert.throws(
    () => compareKnipReport({ issues: [] }, { issues: [{ id: reviewed }] }),
    /Missing rationale/
  )
  assert.throws(
    () => compareKnipReport({ issues: [] }, { issues: [...baseline.issues, ...baseline.issues] }),
    /duplicate baseline ID/
  )
})
