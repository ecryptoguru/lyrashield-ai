import { describe, expect, it } from "vitest"
import { analyzeDiffAdvisory } from "./diff-advisory.js"

const riskyCall = "ev" + "al("
const credentialLine = "const pass" + "word = '0123456789'"

describe("supplied diff advisory", () => {
  it("checks added lines only and preserves source locations", async () => {
    const result = await analyzeDiffAdvisory({
      diff: [
        "+++ b/src/app.ts",
        "@@ -1,2 +1,3 @@",
        " const safe = true",
        `-${riskyCall}oldValue)`,
        `+${riskyCall}newValue)`,
        `+${credentialLine}`,
      ].join("\n"),
      files: [
        {
          path: "src/app.ts",
          content: `const safe = true\n${riskyCall}newValue)\n${credentialLine}`,
        },
      ],
    })
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "eval-exec", severity: "HIGH", file: "src/app.ts" }),
        expect.objectContaining({
          ruleId: "hardcoded-secret",
          severity: "MEDIUM",
          file: "src/app.ts",
        }),
      ])
    )
    expect(result.checked).toBe(2)
    expect(result.coverage.state).toBe("COMPLETE")
  })

  it("detects a WebMCP cross-origin issue on an added line", async () => {
    const content = `document.modelContext.registerTool({
  name: "cross_origin",
  execute: () => ({ ok: true }),
}, { exposedTo: ["self", "https://untrusted.example", ""] })`
    const result = await analyzeDiffAdvisory({
      diff:
        "+++ b/cross-origin.ts\n@@ -0,0 +1,4 @@\n" +
        content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n"),
      files: [{ path: "cross-origin.ts", content }],
    })
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "WEBMCP-03", file: "cross-origin.ts" }),
      ])
    )
  })

  it("reports missing snapshots, malformed hunks, unsupported and oversized files", async () => {
    const snippet = await analyzeDiffAdvisory({ diff: `+${riskyCall}input)` })
    expect(snippet.coverage.reasons).toContain("missing_source_snapshots")
    const malformed = await analyzeDiffAdvisory({
      diff: `+++ b/app.ts\n@@ malformed @@\n+${riskyCall}input)`,
      files: [],
    })
    expect(malformed.coverage.reasons).toContain("malformed_hunk")
    const unsupported = await analyzeDiffAdvisory({
      diff: `+++ b/App.vue\n@@ -0,0 +1 @@\n+${riskyCall}input)`,
      files: [],
    })
    expect(unsupported.coverage.reasons).toContain("unsupported_language")
    const oversized = await analyzeDiffAdvisory({
      diff: `+++ b/app.ts\n@@ -0,0 +1 @@\n+${riskyCall}input)`,
      files: [{ path: "app.ts", content: "x".repeat(1024 * 1024 + 1) }],
    })
    expect(oversized.coverage.reasons).toContain("max_file_bytes")
  })

  it("rejects ambiguous or unsafe snapshots", async () => {
    await expect(
      analyzeDiffAdvisory({
        diff: `+${riskyCall}input)`,
        files: [{ path: "../outside.ts", content: "" }],
      })
    ).rejects.toThrow("Invalid or duplicate")
    await expect(
      analyzeDiffAdvisory({
        diff: `+${riskyCall}input)`,
        files: [
          { path: "app.ts", content: "" },
          { path: "app.ts", content: "" },
        ],
      })
    ).rejects.toThrow("Invalid or duplicate")
  })

  it("bounds repeated findings and marks coverage incomplete", async () => {
    const result = await analyzeDiffAdvisory({
      diff: Array.from({ length: 501 }, () => "+-----BEGIN PRIVATE KEY-----").join("\n"),
    })
    expect(result.findings).toHaveLength(500)
    expect(result.coverage.reasons).toContain("max_findings")
  })
})
