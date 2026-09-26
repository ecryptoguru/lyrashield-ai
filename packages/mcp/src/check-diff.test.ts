import { describe, expect, it } from "vitest"
import { analyzeDiffAdvisory } from "@lyrashield/security/diff-advisory"
import { createCheckDiffTool, type ToolHandlerContext } from "./tools"

const context: ToolHandlerContext = { apiBaseUrl: "http://localhost", apiKey: "test" }

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

interface AdvisoryEntry {
  id: string
  label: string
  line: string
  severity?: string
  file?: string
  lineNumber?: number
}

function advisoryEntries(result: { structuredContent?: Record<string, unknown> }): AdvisoryEntry[] {
  return (result.structuredContent?.advisory as AdvisoryEntry[]) ?? []
}

describe("lyrashield_check_diff — shared analyzer adapter", () => {
  it("keeps the legacy advisory fields and flags hardcoded secrets", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({
      diff: '+ const apiKey = "SECRETVALUE1234567890"',
    })

    const advisory = advisoryEntries(result)
    expect(advisory[0]?.id).toBe("hardcoded-secret")
    expect(advisory[0]?.severity).toBe("MEDIUM")
    expect(advisory[0]?.line).toContain("apiKey")
    expect(result.structuredContent?.checked).toBe(1)
    expect(result.structuredContent?.note).toContain("recorded scan")
  })

  it("marks snippet-only input INCOMPLETE: full-file context not supplied", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({ diff: "+eval(userInput)" })

    const coverage = result.structuredContent?.coverage as {
      state: string
      scope: string
      reasons: string[]
    }
    expect(coverage.state).toBe("INCOMPLETE")
    expect(coverage.scope).toBe("supplied-inputs")
    expect(coverage.reasons).toContain("full_file_context_not_supplied")
    expect(result.structuredContent?.note).toContain("recorded scan")
    // Detection still runs.
    expect(advisoryEntries(result).some((a) => a.id === "eval-exec")).toBe(true)
  })

  it("accepts supplied file snapshots and reports COMPLETE coverage", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({ diff: DIFF, files: FILES })

    const coverage = result.structuredContent?.coverage as { state: string; reasons: string[] }
    expect(coverage.state).toBe("COMPLETE")
    expect(coverage.reasons).toEqual([])
    // Structural WebMCP analysis now runs on the supplied files.
    expect(advisoryEntries(result).some((a) => a.id === "WEBMCP-03" && a.file === "tools.ts")).toBe(
      true
    )
  })

  it("produces advisory entries 1:1 with the canonical analyzer result", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({ diff: DIFF, files: FILES })
    const canonical = await analyzeDiffAdvisory({ diff: DIFF, files: FILES })

    expect(
      advisoryEntries(result).map(
        (a) => `${a.id}|${a.severity}|${a.file ?? "-"}|${a.lineNumber ?? "-"}`
      )
    ).toEqual(
      canonical.findings.map((f) => `${f.ruleId}|${f.severity}|${f.file ?? "-"}|${f.line ?? "-"}`)
    )
  })

  it("rejects traversal and ambiguous file paths with a structured tool error", async () => {
    const tool = createCheckDiffTool(context)
    for (const bad of ["../escape.ts", "/abs.ts", "a\\b.ts", "a//b.ts", "./x.ts"]) {
      const result = await tool.handler({
        diff: "+eval(x)",
        files: [{ path: bad, content: "x" }],
      })
      expect(result.isError).toBe(true)
      expect((result.structuredContent?.error as string) ?? "").toContain("check_diff")
    }
  })

  it("rejects over-budget file inputs instead of silently truncating", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({
      diff: "+eval(x)",
      files: [{ path: "big.ts", content: "x".repeat(1024 * 1024 + 1) }],
    })
    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toContain("per-file limit")
  })

  it("rejects malformed files input with a structured tool error", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({ diff: "+eval(x)", files: "not-an-array" })
    expect(result.isError).toBe(true)
  })

  it("keeps the empty-diff response stable and reports COMPLETE coverage", async () => {
    const tool = createCheckDiffTool(context)
    const result = await tool.handler({ diff: "   \n" })
    expect(result.structuredContent?.note).toBe("Empty diff — nothing to check.")
    expect((result.structuredContent?.coverage as { state: string }).state).toBe("COMPLETE")
  })
})
