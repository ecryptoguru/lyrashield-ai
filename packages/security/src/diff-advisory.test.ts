import { describe, expect, it } from "vitest"
import { analyzeDiffAdvisory, DiffAdvisoryInputError, DIFF_ADVISORY_LIMITS } from "./diff-advisory"

const SIMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 const a = 1
+eval(userInput)
 const unchanged = true
-oldCall()
 const b = 2
`

const WEBMCP_SOURCE = `document.modelContext.registerTool({
  name: "cross_origin_tool",
  description: "Cross-origin tool.",
  execute: () => ({ ok: true }),
}, { exposedTo: ["*"] })`

const WEBMCP_DIFF = `diff --git a/tools.ts b/tools.ts
index 1111111..2222222 100644
--- a/tools.ts
+++ b/tools.ts
@@ -4,2 +4,2 @@
   execute: () => ({ ok: true }),
-}, { exposedTo: ["self"] })
+}, { exposedTo: ["*"] })
`

const APP_TS_CONTENT = `const a = 1
eval(userInput)
const unchanged = true
const b = 2
`

describe("analyzeDiffAdvisory — risky-pattern checks", () => {
  it("flags a risky added line with file, line and severity", async () => {
    const result = await analyzeDiffAdvisory({
      diff: SIMPLE_DIFF,
      files: [{ path: "src/app.ts", content: APP_TS_CONTENT }],
    })

    const evalFinding = result.findings.find((f) => f.ruleId === "eval-exec")
    expect(evalFinding).toMatchObject({
      severity: "HIGH",
      file: "src/app.ts",
      line: 2,
      source: "pattern",
    })
    expect(evalFinding?.message).toContain("eval/exec")
    expect(result.coverage.state).toBe("COMPLETE")
  })

  it("flags a hardcoded secret on an added line", async () => {
    const result = await analyzeDiffAdvisory({
      diff: `diff --git a/s.ts b/s.ts
--- a/s.ts
+++ b/s.ts
@@ -1,1 +1,2 @@
+const apiKey = "SECRETVALUE1234567890"
 x
`,
      files: [],
    })
    expect(
      result.findings.some((f) => f.ruleId === "hardcoded-secret" && f.severity === "MEDIUM")
    ).toBe(true)
  })

  it("does not flag unchanged context lines", async () => {
    const result = await analyzeDiffAdvisory({ diff: SIMPLE_DIFF, files: [] })
    expect(result.findings.some((f) => f.line === 3)).toBe(false)
    // "const unchanged = true" is context — nothing flags it.
    expect(result.findings.every((f) => !(f.match ?? "").includes("unchanged"))).toBe(true)
  })

  it("does not flag removed lines", async () => {
    const diff = `diff --git a/s.ts b/s.ts
--- a/s.ts
+++ b/s.ts
@@ -1,2 +1,1 @@
-eval(oldInput)
 const keep = 1
`
    const result = await analyzeDiffAdvisory({
      diff,
      files: [{ path: "s.ts", content: "const keep = 1\n" }],
    })
    expect(result.findings).toEqual([])
    expect(result.coverage.state).toBe("COMPLETE")
  })

  it("keeps the advisory rules shared with the MCP pre-filter", async () => {
    const diff = `diff --git a/s.ts b/s.ts
--- a/s.ts
+++ b/s.ts
@@ -0,0 +1,4 @@
+-----BEGIN RSA PRIVATE KEY-----
+const aws = "AKIAIOSFODNN7EXAMPLE"
+const html = { __html: x }
+dangerouslySetInnerHTML={{__html: y}}
`
    const result = await analyzeDiffAdvisory({ diff, files: [] })
    const ids = result.findings.map((f) => f.ruleId)
    expect(ids).toContain("private-key")
    expect(ids).toContain("aws-key")
    expect(ids).toContain("dangerous-html")
  })
})

describe("analyzeDiffAdvisory — coverage honesty", () => {
  it("marks snippet-only input INCOMPLETE: full-file context was not supplied", async () => {
    const result = await analyzeDiffAdvisory({ diff: "+eval(userInput)" })

    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.scope).toBe("supplied-inputs")
    expect(result.coverage.reasons).toContain("full_file_context_not_supplied")
    // The added line is still pattern-checked.
    expect(result.findings.some((f) => f.ruleId === "eval-exec")).toBe(true)
  })

  it("marks diff-only input (structured diff, no files) INCOMPLETE", async () => {
    const result = await analyzeDiffAdvisory({ diff: SIMPLE_DIFF })
    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.reasons).toContain("full_file_context_not_supplied")
  })

  it("is COMPLETE when supplied inputs cover the diff within limits", async () => {
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-old
+new
`
    const result = await analyzeDiffAdvisory({ diff, files: [] })
    expect(result.coverage.state).toBe("COMPLETE")
    expect(result.coverage.reasons).toEqual([])
  })

  it("reports eligible changed files whose content was not supplied", async () => {
    const result = await analyzeDiffAdvisory({ diff: SIMPLE_DIFF, files: [] })
    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.reasons).toContain("file_content_not_supplied")
  })

  it("surfaces malformed hunk headers instead of silently misnumbering", async () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ not-a-number @@
+eval(x)
`
    const result = await analyzeDiffAdvisory({
      diff,
      files: [{ path: "a.ts", content: "eval(x)\n" }],
    })
    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.reasons).toContain("malformed_hunk")
    // The added line is still scanned (without a trustworthy location).
    expect(result.findings.some((f) => f.ruleId === "eval-exec" && f.file === "a.ts")).toBe(true)
  })
})

describe("analyzeDiffAdvisory — WebMCP discovery on supplied files", () => {
  it("reports a cross-origin exposure signal on supplied full files", async () => {
    const result = await analyzeDiffAdvisory({
      diff: WEBMCP_DIFF,
      files: [{ path: "tools.ts", content: WEBMCP_SOURCE }],
    })

    const signal = result.findings.find((f) => f.ruleId === "WEBMCP-03")
    expect(signal).toBeDefined()
    expect(signal?.severity).toBe("HIGH")
    expect(signal?.file).toBe("tools.ts")
    expect(signal?.source).toBe("webmcp")
    expect(result.coverage.state).toBe("COMPLETE")
  })

  it("does not report WebMCP signals when the changed lines do not overlap the tool definition", async () => {
    const diff = `diff --git a/tools.ts b/tools.ts
index 1111111..2222222 100644
--- a/tools.ts
+++ b/tools.ts
@@ -6,1 +6,2 @@
 const pad = 1
+export const unrelated = 42
`
    const result = await analyzeDiffAdvisory({
      diff,
      files: [
        {
          path: "tools.ts",
          content: `${WEBMCP_SOURCE}\nconst pad = 1\nexport const unrelated = 42`,
        },
      ],
    })
    // Signal range for the tool spans lines 1–6; the addition lands on line 7.
    expect(result.findings.some((f) => f.ruleId === "WEBMCP-03")).toBe(false)
    expect(result.coverage.state).toBe("COMPLETE")
  })

  it("fails closed on unsupported code-like languages", async () => {
    const diff = `diff --git a/tool.py b/tool.py
--- a/tool.py
+++ b/tool.py
@@ -1,1 +1,1 @@
-old
+new
`
    const result = await analyzeDiffAdvisory({
      diff,
      files: [{ path: "tool.py", content: "new\n" }],
    })
    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.reasons).toContain("unsupported_language")
  })

  it("ignores binary diff entries without flagging coverage", async () => {
    const diff = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`
    const result = await analyzeDiffAdvisory({ diff, files: [] })
    expect(result.findings).toEqual([])
    expect(result.coverage.state).toBe("COMPLETE")
  })

  it("marks files above the per-file byte budget as incomplete coverage", async () => {
    const diff = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,1 +1,1 @@
-old
+new
`
    const result = await analyzeDiffAdvisory({
      diff,
      files: [{ path: "big.ts", content: "x".repeat(DIFF_ADVISORY_LIMITS.maxFileBytes + 1) }],
    })
    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.reasons).toContain("max_file_bytes")
  })

  it("bounds the number of supplied files", async () => {
    const files = Array.from({ length: DIFF_ADVISORY_LIMITS.maxFiles + 1 }, (_, i) => ({
      path: `tools/tool-${i}.ts`,
      content: "export const x = 1\n",
    }))
    const result = await analyzeDiffAdvisory({ diff: "", files })
    expect(result.coverage.state).toBe("INCOMPLETE")
    expect(result.coverage.reasons).toContain("max_files")
  })
})

describe("analyzeDiffAdvisory — input validation", () => {
  const base = { diff: "+eval(x)\n" }

  it.each([
    ["../escape.ts"],
    ["a/../b.ts"],
    ["./dotfile.ts"],
    ["/abs/path.ts"],
    ["C:\\windows\\path.ts"],
    ["back\\slash.ts"],
    ["double//slash.ts"],
  ])("rejects traversal/ambiguous path %j", async (path) => {
    await expect(analyzeDiffAdvisory({ ...base, files: [{ path, content: "x" }] })).rejects.toThrow(
      DiffAdvisoryInputError
    )
  })

  it("rejects NUL bytes in diff and file content", async () => {
    await expect(analyzeDiffAdvisory({ diff: `+eval(x)\0` })).rejects.toThrow(
      DiffAdvisoryInputError
    )
    await expect(
      analyzeDiffAdvisory({ ...base, files: [{ path: "a.ts", content: "x\0y" }] })
    ).rejects.toThrow(DiffAdvisoryInputError)
  })

  it("rejects duplicate and case-ambiguous paths", async () => {
    await expect(
      analyzeDiffAdvisory({
        ...base,
        files: [
          { path: "a.ts", content: "1" },
          { path: "a.ts", content: "2" },
        ],
      })
    ).rejects.toThrow(DiffAdvisoryInputError)
    await expect(
      analyzeDiffAdvisory({
        ...base,
        files: [
          { path: "A.ts", content: "1" },
          { path: "a.ts", content: "2" },
        ],
      })
    ).rejects.toThrow(DiffAdvisoryInputError)
  })

  it("rejects a diff over the byte budget instead of parsing it", async () => {
    await expect(
      analyzeDiffAdvisory({ diff: "x".repeat(DIFF_ADVISORY_LIMITS.maxDiffBytes + 1) })
    ).rejects.toThrow(DiffAdvisoryInputError)
  })

  it("rejects malformed file entries", async () => {
    await expect(
      analyzeDiffAdvisory({ ...base, files: [{ path: 42 as never, content: "x" }] })
    ).rejects.toThrow(DiffAdvisoryInputError)
  })
})
