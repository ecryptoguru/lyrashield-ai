import { describe, expect, it, vi } from "vitest"
import { createCheckDiffTool } from "./tools.js"

const tool = createCheckDiffTool({
  apiBaseUrl: "https://example.test",
  fetchFn: vi.fn() as unknown as typeof fetch,
})

async function payload(args: Record<string, unknown>) {
  const response = await tool.handler(args)
  return { response, data: JSON.parse(response.content[0]!.text) }
}

describe("lyrashield_check_diff", () => {
  it("preserves legacy advisory fields and declares missing full-file context", async () => {
    const { data } = await payload({ diff: '+ const apiKey = "SECRETVALUE1234567890"' })
    expect(data.advisory[0]).toMatchObject({
      id: "hardcoded-secret",
      line: 'const apiKey = "SECRETVALUE1234567890"',
      severity: "MEDIUM",
    })
    expect(data.checked).toBe(1)
    expect(data.coverage).toMatchObject({
      state: "INCOMPLETE",
      scope: "supplied-inputs",
      reasons: ["missing_source_snapshots"],
    })
  })

  it("keeps legacy MCP secret and eval matches", async () => {
    const { data } = await payload({
      diff: '+ const api-key = "SECRETVALUE1234567890"\n+eval(input)',
    })
    expect(data.advisory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hardcoded-secret",
          label: "Possible hardcoded secret or API key",
        }),
        expect.objectContaining({ id: "eval", label: "Use of eval()" }),
      ])
    )
  })

  it("finds WebMCP exposure from a supplied source snapshot", async () => {
    const content = `document.modelContext.registerTool({
  name: "cross_origin",
  execute: () => ({ ok: true }),
}, { exposedTo: ["self", "https://untrusted.example", ""] })`
    const { data } = await payload({
      diff:
        "+++ b/cross-origin.ts\n@@ -0,0 +1,4 @@\n" +
        content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n"),
      files: [{ path: "cross-origin.ts", content }],
    })
    expect(data.advisory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "WEBMCP-03", file: "cross-origin.ts" }),
      ])
    )
    expect(data.coverage.state).toBe("COMPLETE")
  })

  it("rejects unsafe snapshot paths without reading local files", async () => {
    const { response, data } = await payload({
      diff: "+eval(input)",
      files: [{ path: "../private.ts", content: "eval(input)" }],
    })
    expect(response.isError).toBe(true)
    expect(data.coverage.state).toBe("INCOMPLETE")
  })
})
