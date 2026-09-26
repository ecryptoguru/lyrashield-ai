import { describe, expect, it } from "vitest"
import { analyzeDiffAdvisory } from "@lyrashield/security/diff-advisory"
import { mapDiffAdvisoryResult, runAdvisoryChecks } from "../diff-core.js"

// Adapter parity: both adapters run the same canonical analyzer. This file
// proves the CLI adapter's mapped output carries the same ruleIds, severities
// and locations as the canonical result; the MCP side asserts the same thing
// in packages/mcp/src/check-diff.test.ts (MCP cannot depend on the CLI).

const TOOL_TS = `document.modelContext.registerTool({
  name: "cross_origin_tool",
  description: "Cross-origin tool.",
  execute: () => ({ ok: true }),
}, { exposedTo: ["*"] })`

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1
+const token = "abc123456789"
+eval(userInput)
 const b = 2
diff --git a/tools.ts b/tools.ts
index 3333333..4444444 100644
--- a/tools.ts
+++ b/tools.ts
@@ -4,2 +4,2 @@
   execute: () => ({ ok: true }),
-}, { exposedTo: ["self"] })
+}, { exposedTo: ["*"] })
`

const FILES = [
  {
    path: "src/app.ts",
    content: `const a = 1
const token = "abc123456789"
eval(userInput)
const b = 2
`,
  },
  { path: "tools.ts", content: TOOL_TS },
]

describe("diff advisory parity — CLI adapter vs canonical analyzer", () => {
  it("produces equivalent ruleIds, severities and locations", async () => {
    const input = { diff: DIFF, files: FILES }
    const canonical = await analyzeDiffAdvisory(input)
    const cliFindings = await runAdvisoryChecks(input)

    const key = (f: { ruleId: string; severity: string; file?: string }) =>
      `${f.ruleId}|${f.severity}|${f.file ?? "-"}`

    const canonicalSet = new Set(canonical.findings.map(key))
    const cliSet = new Set(cliFindings.filter((f) => !f.coverageIncomplete).map(key))
    expect(cliSet).toEqual(canonicalSet)

    // WebMCP signals keep their file/line locations through the adapter.
    const canonicalLocations = new Set(
      canonical.findings
        .filter((f) => f.source === "webmcp")
        .map((f) => `${f.ruleId}@${f.file}:${f.line}`)
    )
    const cliLocations = new Set(
      cliFindings.filter((f) => f.line !== undefined).map((f) => `${f.ruleId}@${f.file}:${f.line}`)
    )
    expect(cliLocations).toEqual(canonicalLocations)

    // Sanity: the fixture exercises both detector families.
    expect(canonicalSet).toContain("hardcoded-secret|MEDIUM|src/app.ts")
    expect(canonicalSet).toContain("eval-exec|HIGH|src/app.ts")
    expect(canonicalSet).toContain("WEBMCP-03|HIGH|tools.ts")
  })

  it("maps INCOMPLETE coverage to the fail-closed pseudo-finding", async () => {
    const input = { diff: DIFF } // no files supplied
    const canonical = await analyzeDiffAdvisory(input)
    const cliFindings = mapDiffAdvisoryResult(canonical)

    expect(canonical.coverage.state).toBe("INCOMPLETE")
    const coverage = cliFindings.find((f) => f.coverageIncomplete)
    expect(coverage).toBeDefined()
    expect(coverage?.ruleId).toBe("WEBMCP-COVERAGE-INCOMPLETE")
    expect(coverage?.severity).toBe("HIGH")
    expect(coverage?.level).toBe("error")
    expect(coverage?.message).toContain("full_file_context_not_supplied")
  })

  it("keeps complete coverage clean", async () => {
    const canonical = await analyzeDiffAdvisory({ diff: DIFF, files: FILES })
    const cliFindings = mapDiffAdvisoryResult(canonical)
    expect(canonical.coverage.state).toBe("COMPLETE")
    expect(cliFindings.some((f) => f.coverageIncomplete)).toBe(false)
  })
})
