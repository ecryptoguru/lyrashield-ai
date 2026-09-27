import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { makeTypeAssertionRatchet } from "./type-assertion-ratchet.mjs"

const file = "apps/web/src/lib/example.ts"
const filename = fileURLToPath(new URL(`../${file}`, import.meta.url))
const expression = "value as unknown as Record<string, unknown>"
const sha256 = createHash("sha256").update(expression).digest("hex")
const node = {
  expression: { type: "TSAsExpression", typeAnnotation: { type: "TSUnknownKeyword" } },
  typeAnnotation: { type: "TSTypeReference" },
}

function inspect(approved, text, visits) {
  const reports = []
  const visitors = makeTypeAssertionRatchet(approved).create({
    filename,
    sourceCode: { getText: () => text },
    report: (report) => reports.push(report.messageId),
  })
  for (let index = 0; index < visits; index++) visitors.TSAsExpression(node)
  visitors["Program:exit"]({})
  return reports
}

test("allows only the recorded number of identical assertions", () => {
  const approved = { [file]: [{ kind: "double-unknown", sha256, count: 1 }] }
  assert.deepEqual(inspect(approved, expression, 1), [])
  assert.deepEqual(inspect(approved, expression, 2), ["new"])
  assert.deepEqual(inspect(approved, "other as unknown as T", 1), ["new", "stale"])
})

test("rejects stale baseline entries when an assertion disappears", () => {
  const approved = { [file]: [{ kind: "double-unknown", sha256, count: 1 }] }
  assert.deepEqual(inspect(approved, expression, 0), ["stale"])
})
