import assert from "node:assert/strict"
import { test } from "vitest"
import { fileURLToPath } from "node:url"
import {
  FUNCTION_SIZE_LIMIT,
  measureFunctionSizes,
  measureSourceFunctions,
  oversizedFunctions,
} from "./function-size.mjs"

// The v23 W7 decomposition targets. Whole-file size is not the metric: the
// debt item limits each function to FUNCTION_SIZE_LIMIT counted lines.
const DECOMPOSED_FILES = [
  "apps/worker/src/operations/verify-launch-assurance-run.ts",
  "apps/web/src/app/onboarding/onboarding-wizard.tsx",
  "apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client.tsx",
]

test("counts declaration-to-brace lines, skipping blank and comment-only lines", () => {
  const code = [
    "// leading comment outside the function",
    "function measured(a) {",
    "  // a comment-only line is skipped",
    "",
    "  const value = a + 1 // trailing comment still counts the code line",
    "  /*",
    "    multi-line comment",
    "  */",
    "  return value",
    "}",
  ].join("\n")
  const [entry] = measureSourceFunctions({ code, filename: "fixture.ts" })
  assert.equal(entry.name, "measured")
  // Lines counted: signature (2), `const value` (5), `return value` (9),
  // closing brace (10) = 4.
  assert.equal(entry.lines, 4)
})

test("counts arrow functions, methods, and nested functions individually", () => {
  const code = [
    "const outer = () => {",
    "  const inner = async () => {",
    "    return 1",
    "  }",
    "  return inner()",
    "}",
    "const holder = {",
    "  method() {",
    "    return 2",
    "  },",
    "}",
  ].join("\n")
  const entries = measureSourceFunctions({ code, filename: "fixture.ts" })
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.lines]),
    [
      ["outer", 6],
      ["inner", 3],
      ["method", 3],
    ]
  )
})

test("flags only functions beyond the shared limit", () => {
  const measurements = [
    { name: "small", lines: 10 },
    { name: "at-limit", lines: FUNCTION_SIZE_LIMIT },
    { name: "over", lines: FUNCTION_SIZE_LIMIT + 1 },
  ]
  assert.deepEqual(
    oversizedFunctions(measurements).map((entry) => entry.name),
    ["over"]
  )
})

for (const file of DECOMPOSED_FILES) {
  test(`no function in ${file} exceeds ${FUNCTION_SIZE_LIMIT} counted lines`, async () => {
    const path = fileURLToPath(new URL(`../${file}`, import.meta.url))
    const measurements = await measureFunctionSizes(path)
    const oversized = oversizedFunctions(measurements)
    assert.deepEqual(
      oversized.map((entry) => `${entry.name} (${entry.lines} lines, L${entry.line})`),
      []
    )
  })
}
