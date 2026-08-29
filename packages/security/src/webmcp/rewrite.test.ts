import { describe, expect, it } from "vitest"
import { discoverWebMcpTools } from "./discover"
import { evaluateWebMcpSurface } from "./evaluate"
import { WEBMCP_FIXTURES } from "./fixtures"
import { applyWebMcpRewrite, generateWebMcpDiff, planWebMcpRewrite } from "./rewrite"

describe("planWebMcpRewrite", () => {
  async function analyze(content: string, path = "tool.ts") {
    const file = { path, content, size: content.length, extension: ".ts" }
    const { inventory, context } = await discoverWebMcpTools([file])
    const signals = evaluateWebMcpSurface([file], inventory, context)
    return { file, inventory, signals }
  }

  it("proposes non-overlapping edits for an unsafe imperative fixture", async () => {
    const fixture = WEBMCP_FIXTURES.find((f) => f.name === "unsafe imperative")!
    const { inventory } = await discoverWebMcpTools([fixture.file])
    const signals = evaluateWebMcpSurface([fixture.file], inventory)
    const plan = await planWebMcpRewrite([fixture.file], signals, inventory)

    expect(plan.edits.length).toBeGreaterThan(0)
    expect(plan.addressed).toContain("WEBMCP-03")
    expect(plan.unresolved).toEqual(
      expect.arrayContaining(["WEBMCP-05", "WEBMCP-07", "WEBMCP-08", "WEBMCP-09"])
    )
    expect(plan.updatedChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.warnings).toBeDefined()

    // Edits are sorted by position.
    for (let i = 1; i < plan.edits.length; i++) {
      const prev = plan.edits[i - 1]!
      const curr = plan.edits[i]!
      expect(
        prev.endLine < curr.startLine ||
          (prev.endLine === curr.startLine && prev.endColumn <= curr.startColumn)
      ).toBe(true)
    }
  })

  it("applies a rewrite without overlapping ranges", () => {
    const before = `document.modelContext.registerTool({\n  name: "x"\n})`
    const edit = {
      path: "test.ts",
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      endColumn: 0,
      newText: "// header\n",
      controlIds: ["WEBMCP-01"],
    }
    const after = applyWebMcpRewrite(before, [edit])
    expect(after.startsWith("// header")).toBe(true)
  })

  it("generates a readable diff", () => {
    const before = "line one\nline two"
    const after = "line one\nline two changed"
    const diff = generateWebMcpDiff(before, after)
    expect(diff).toContain("-")
    expect(diff).toContain("+")
  })

  it("does not mutate the original content", async () => {
    const fixture = WEBMCP_FIXTURES.find((f) => f.name === "safe imperative")!
    const { inventory } = await discoverWebMcpTools([fixture.file])
    const signals = evaluateWebMcpSurface([fixture.file], inventory)
    const plan = await planWebMcpRewrite([fixture.file], signals, inventory)

    expect(plan.edits.length).toBe(0)
    expect(plan.addressed.length).toBe(0)
  })

  it("rewrites only an exact static wildcard and checksum-binds the rerun", async () => {
    const source = `document.modelContext.registerTool({
  name: "search",
  inputSchema: { type: "object", additionalProperties: false },
  execute: () => ({ ok: true }),
}, { exposedTo: ["*"] })`
    const { file, inventory, signals } = await analyze(source)
    const plan = await planWebMcpRewrite([file], signals, inventory)
    const rewritten = applyWebMcpRewrite(file.content, plan.edits)
    const rerun = await analyze(rewritten)

    expect(plan.edits).toHaveLength(1)
    expect(rewritten).toContain('exposedTo: ["self"]')
    expect(plan.updatedChecksum).toBe(rerun.inventory.checksum)
    expect(rerun.signals).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controlId: "WEBMCP-03", state: "DETECTED" }),
      ])
    )

    const secondPlan = await planWebMcpRewrite([rerun.file], rerun.signals, rerun.inventory)
    expect(secondPlan.edits).toEqual([])
  })

  it("leaves dynamic and explicit cross-origin exposure unresolved", async () => {
    const source = `document.modelContext.registerTool({ name: "dynamic", execute: () => null }, { exposedTo: origin() })
document.modelContext.registerTool({ name: "http", execute: () => null }, { exposedTo: ["http://example.com"] })
document.modelContext.registerTool({ name: "wildcard", execute: () => null }, { exposedTo: ["*"] })`
    const { file, inventory, signals } = await analyze(source)
    const plan = await planWebMcpRewrite([file], signals, inventory)

    expect(plan.edits).toHaveLength(1)
    expect(plan.addressed).toContain("WEBMCP-03")
    expect(plan.unresolved).toContain("WEBMCP-03")
  })

  it("fails closed when findings no longer match the analyzed inventory", async () => {
    const source = `document.modelContext.registerTool({ name: "x", execute: () => null }, { exposedTo: ["*"] })`
    const analyzed = await analyze(source)
    const changed = { ...analyzed.file, content: `${source}\n// changed`, size: source.length + 11 }
    const plan = await planWebMcpRewrite([changed], analyzed.signals, analyzed.inventory)

    expect(plan.edits).toEqual([])
    expect(plan.unresolved).toContain("WEBMCP-03")
    expect(plan.warnings.join(" ")).toMatch(/inventory changed/i)
  })

  it("keeps same-position edits in different files non-overlapping", async () => {
    const source = `document.modelContext.registerTool({ name: "x", execute: () => null }, { exposedTo: ["*"] })`
    const first = await analyze(source, "a.ts")
    const second = await analyze(source.replace('name: "x"', 'name: "y"'), "b.ts")
    const files = [first.file, second.file]
    const { inventory, context } = await discoverWebMcpTools(files)
    const signals = evaluateWebMcpSurface(files, inventory, context)
    const plan = await planWebMcpRewrite(files, signals, inventory)

    expect(plan.edits).toHaveLength(2)
    expect(plan.edits.map((edit) => edit.path)).toEqual(["a.ts", "b.ts"])
  })

  it.each([".html", ".astro"])(
    "rewrites an exact wildcard inside an imperative %s script region",
    async (extension) => {
      const source = `<!doctype html>
<html><body>
  <script type="module">
    document.modelContext.registerTool({
      name: "public_sample",
      inputSchema: { type: "object", additionalProperties: false },
      exposedTo: ["*"],
      execute: () => ({ ok: true }),
    })
  </script>
</body></html>`
      const file = {
        path: `pasted-code${extension}`,
        content: source,
        size: source.length,
        extension,
      }
      const { inventory, context } = await discoverWebMcpTools([file])
      const signals = evaluateWebMcpSurface([file], inventory, context)
      const plan = await planWebMcpRewrite([file], signals, inventory)
      const rewritten = applyWebMcpRewrite(source, plan.edits)
      const rerunFile = { ...file, content: rewritten, size: rewritten.length }
      const rerun = await discoverWebMcpTools([rerunFile])
      const rerunSignals = evaluateWebMcpSurface([rerunFile], rerun.inventory, rerun.context)

      expect(plan.edits).toHaveLength(1)
      expect(rewritten).toContain('exposedTo: ["self"]')
      expect(plan.updatedChecksum).toBe(rerun.inventory.checksum)
      expect(rerunSignals).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ controlId: "WEBMCP-03", state: "DETECTED" }),
        ])
      )
    }
  )
})
