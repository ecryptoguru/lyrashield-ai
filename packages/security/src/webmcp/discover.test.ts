import { describe, expect, it } from "vitest"
import { discoverWebMcpTools } from "./discover"
import { WEBMCP_FIXTURES, MANY_FILES } from "./fixtures"
import { evaluateWebMcpSurface, summarizeWebMcpCoverage } from "./evaluate"

describe("discoverWebMcpTools", () => {
  it("discovers safe and unsafe imperative tools", async () => {
    const files = WEBMCP_FIXTURES.filter((f) =>
      ["safe imperative", "unsafe imperative"].includes(f.name)
    ).map((f) => f.file)

    const { inventory } = await discoverWebMcpTools(files)

    expect(inventory.definitions).toHaveLength(2)
    expect(inventory.incompleteDefinitions).toBe(0)

    const safe = inventory.definitions.find((d) => d.name === "search_docs")
    expect(safe).toBeDefined()
    expect(safe?.kind).toBe("imperative")
    expect(safe?.behavior).toBe("read")
    expect(safe?.networkMethods).toContain("GET")
    expect(safe?.forwardsCancellation).toBe(true)
    expect(safe?.hasRegistrationCleanup).toBe(true)
    expect(safe?.runtimeValidation).toBe("present")
    expect(safe?.inputSchema.required).toEqual(["query"])
    expect(
      safe?.inputSchema.properties?.find((property) => property.name === "query")?.required
    ).toBe(true)

    const unsafe = inventory.definitions.find((d) => d.name === "delete_user")
    expect(unsafe).toBeDefined()
    expect(unsafe?.behavior).toBe("mutation")
    expect(unsafe?.networkMethods).toContain("DELETE")
    expect(unsafe?.forwardsCancellation).toBe(false)
    expect(unsafe?.hasRegistrationCleanup).toBe(false)
    expect(unsafe?.runtimeValidation).toBe("absent")
    expect(unsafe?.exposedTo).toEqual(["*"])
  })

  it("discovers safe and unsafe declarative forms", async () => {
    const files = WEBMCP_FIXTURES.filter((f) =>
      ["safe declarative", "unsafe declarative"].includes(f.name)
    ).map((f) => f.file)

    const { inventory } = await discoverWebMcpTools(files)

    expect(inventory.definitions).toHaveLength(2)

    const search = inventory.definitions.find((d) => d.name === "search_cars")
    expect(search).toBeDefined()
    expect(search?.kind).toBe("declarative")
    expect(search?.behavior).toBe("read")
    expect(search?.networkMethods).toContain("GET")
    expect(search?.inputSchema.properties).toBeDefined()
    expect(search?.inputSchema.properties?.some((p) => p.name === "make")).toBe(true)

    const del = inventory.definitions.find((d) => d.name === "delete_account")
    expect(del).toBeDefined()
    expect(del?.behavior).toBe("mutation")
    expect(del?.networkMethods).toContain("POST")
    expect(del?.inputSchema.additionalProperties).toBe(false)
  })

  it("splits Astro frontmatter, script, and template with correct line offsets", async () => {
    const fixture = WEBMCP_FIXTURES.find((f) => f.name === "astro file")
    expect(fixture).toBeDefined()

    const { inventory } = await discoverWebMcpTools([fixture!.file])

    expect(inventory.definitions).toHaveLength(2)

    const imperative = inventory.definitions.find((d) => d.name === "submit_feedback")
    expect(imperative).toBeDefined()
    expect(imperative?.source.startLine).toBe(6)
    expect(imperative?.source.endLine).toBeGreaterThanOrEqual(imperative!.source.startLine)

    const declarative = inventory.definitions.find((d) => d.name === "search_articles")
    expect(declarative).toBeDefined()
    expect(declarative?.source.startLine).toBe(25)
  })

  it("counts dynamic and malformed definitions as incomplete", async () => {
    const files = WEBMCP_FIXTURES.filter((f) =>
      ["dynamic name and schema", "malformed source"].includes(f.name)
    ).map((f) => f.file)

    const { inventory } = await discoverWebMcpTools(files)

    expect(inventory.incompleteDefinitions).toBeGreaterThan(0)
    expect(inventory.definitions).toHaveLength(1)
  })

  it("detects duplicate tool names", async () => {
    const fixture = WEBMCP_FIXTURES.find((f) => f.name === "duplicate names")
    expect(fixture).toBeDefined()

    const { inventory } = await discoverWebMcpTools([fixture!.file])

    expect(inventory.definitions).toHaveLength(2)
    expect(new Set(inventory.definitions.map((d) => d.name)).size).toBe(1)
  })

  it("collects header and config exposure", async () => {
    const files = [
      WEBMCP_FIXTURES.find((f) => f.name === "header self policy")!,
      WEBMCP_FIXTURES.find((f) => f.name === "header wildcard policy")!,
      WEBMCP_FIXTURES.find((f) => f.name === "header disabled origin agent cluster")!,
    ].map((f) => f.file)

    const { context } = await discoverWebMcpTools(files)

    expect(context.headerExposure).toBeDefined()
    expect(context.headerExposure!.hasToolsSelfPolicy).toBe(true)
    expect(context.headerExposure!.hasWildcardToolsPolicy).toBe(true)
    expect(context.headerExposure!.hasOriginAgentCluster).toBe(false)
  })

  it("detects unsafe framework key/value headers and mixed tools policies", async () => {
    const content = `export default {
  headers: [{
    key: "Origin-Agent-Cluster",
    value: "?0",
  }, {
    key: "Permissions-Policy",
    value: "tools=(self https://widgets.example)",
  }],
}`
    const file = {
      path: "next.config.ts",
      content,
      size: content.length,
      extension: ".ts",
    }

    const { inventory, context } = await discoverWebMcpTools([file])

    expect(context.headerExposure).toMatchObject({
      hasOriginAgentCluster: false,
      hasWildcardToolsPolicy: true,
    })
    expect(context.headerExposure?.evidence?.originAgentClusterDisabled?.[0]).toMatchObject({
      path: "next.config.ts",
      startLine: 3,
    })
    expect(context.headerExposure?.evidence?.unsafeToolsPolicy?.[0]).toMatchObject({
      path: "next.config.ts",
      startLine: 6,
    })
    expect(inventory.checksum).toMatch(/^[a-f0-9]{64}$/)
  })

  it("binds config facts and content to the inventory checksum", async () => {
    const base = "Permissions-Policy: tools=(*)"
    const first = {
      path: "_headers",
      content: base,
      size: base.length,
      extension: "",
    }
    const changed = { ...first, content: `${base}\n# revision two`, size: base.length + 15 }

    const a = await discoverWebMcpTools([first])
    const b = await discoverWebMcpTools([changed])

    expect(a.inventory.checksum).not.toBe(b.inventory.checksum)
  })

  it("detects delegated tools iframe", async () => {
    const fixture = WEBMCP_FIXTURES.find((f) => f.name === "delegated tools iframe")
    expect(fixture).toBeDefined()

    const { context, inventory } = await discoverWebMcpTools([fixture!.file])

    expect(inventory.definitions).toHaveLength(0)
    expect(context.headerExposure?.hasDelegatedToolsIframe).toBe(true)
  })

  it("throws when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      discoverWebMcpTools([WEBMCP_FIXTURES[0]!.file], { signal: controller.signal })
    ).rejects.toThrow("WebMCP discovery cancelled")
  })

  it("respects maxFiles and maxDefinitions limits", async () => {
    const { inventory } = await discoverWebMcpTools(MANY_FILES, {
      limits: { maxFiles: 5, maxDefinitions: 3 },
    })

    expect(inventory.definitions.length).toBeLessThanOrEqual(3)
    expect(inventory.limitsReached).toContain("max_definitions")
  })

  it("discovers imperative and declarative tools in the same HTML file", async () => {
    const content = `<form toolname="search" tooldescription="Search" method="get"></form>
<script>
document.modelContext.registerTool({
  name: "remove_item",
  description: "Remove an item.",
  execute: async () => fetch("/items/1", { method: "DELETE" }),
}, { exposedTo: ["*"] })
</script>`
    const file = {
      path: "mixed.html",
      content,
      size: content.length,
      extension: ".html",
    }

    const { inventory } = await discoverWebMcpTools([file])

    expect(inventory.definitions.map((tool) => tool.name).sort()).toEqual(["remove_item", "search"])
    expect(inventory.definitions.find((tool) => tool.name === "remove_item")?.exposedTo).toEqual([
      "*",
    ])
  })

  it("never returns more definitions than maxDefinitions", async () => {
    const content = Array.from(
      { length: 6 },
      (_, index) =>
        `document.modelContext.registerTool({ name: "tool_${index}", execute: () => ({ ok: true }) })`
    ).join("\n")
    const file = { path: "many.ts", content, size: content.length, extension: ".ts" }

    const { inventory } = await discoverWebMcpTools([file], {
      limits: { maxDefinitions: 3 },
    })

    expect(inventory.definitions).toHaveLength(3)
    expect(inventory.limitsReached).toContain("max_definitions")
  })

  it("does not report a definition limit when input ends exactly at the cap", async () => {
    const content = Array.from(
      { length: 3 },
      (_, index) =>
        `document.modelContext.registerTool({ name: "exact_${index}", execute: () => ({ ok: true }) })`
    ).join("\n")
    const file = { path: "exact.ts", content, size: content.length, extension: ".ts" }

    const { inventory } = await discoverWebMcpTools([file], { limits: { maxDefinitions: 3 } })

    expect(inventory.definitions).toHaveLength(3)
    expect(inventory.limitsReached).not.toContain("max_definitions")
  })

  it("parses JSX and TSX with their matching TypeScript script kinds", async () => {
    const files = [".jsx", ".tsx"].map((extension) => {
      const content = `export function ToolPage() {
  document.modelContext.registerTool({
    name: "tool_${extension.slice(1)}",
    execute: () => ({ ok: true }),
  })
  return <button data-kind="${extension}">Run</button>
}`
      return { path: `tool${extension}`, content, size: content.length, extension }
    })

    const { inventory } = await discoverWebMcpTools(files)

    expect(inventory.definitions.map((tool) => tool.name).sort()).toEqual(["tool_jsx", "tool_tsx"])
  })

  it("does not treat an unrelated modelContext object as a WebMCP definition", async () => {
    const content = `const modelContext = analyticsClient
modelContext.registerTool({
  name: "analytics_plugin",
  execute: () => ({ ok: true }),
})`
    const file = { path: "analytics.ts", content, size: content.length, extension: ".ts" }

    const { inventory } = await discoverWebMcpTools([file])

    expect(inventory.definitions).toHaveLength(0)
    expect(inventory.incompleteDefinitions).toBe(1)
  })

  it("discovers string-literal computed WebMCP registration", async () => {
    const content = `document["modelContext"]["registerTool"]({
  name: "computed_read",
  execute: () => ({ ok: true }),
})`
    const file = { path: "computed.ts", content, size: content.length, extension: ".ts" }

    const { inventory } = await discoverWebMcpTools([file])

    expect(inventory.definitions.map((tool) => tool.name)).toEqual(["computed_read"])
    expect(inventory.incompleteDefinitions).toBe(0)
  })

  it("marks dynamic document modelContext registration paths incomplete", async () => {
    const content = `document[contextName][method]({ name: "hidden", execute: () => ({ ok: true }) })`
    const file = { path: "dynamic-computed.ts", content, size: content.length, extension: ".ts" }

    const { inventory, context } = await discoverWebMcpTools([file])
    const coverage = summarizeWebMcpCoverage(
      evaluateWebMcpSurface([file], inventory, context),
      inventory.limitsReached
    )

    expect(inventory.definitions).toHaveLength(0)
    expect(inventory.incompleteDefinitions).toBe(1)
    expect(coverage.inconclusiveCount).toBeGreaterThan(0)
    expect(Object.values(coverage.controls)).not.toContainEqual(
      expect.objectContaining({ state: "NO_FINDING" })
    )
  })

  it("marks indirect WebMCP registration invocation incomplete", async () => {
    const content = `document["modelContext"]["registerTool"].call(
  document["modelContext"],
  { name: "hidden", execute: () => ({ ok: true }) },
)
Reflect.apply(document["modelContext"]["registerTool"], document, [
  { name: "also_hidden", execute: () => ({ ok: true }) },
])`
    const file = { path: "indirect-computed.ts", content, size: content.length, extension: ".ts" }

    const { inventory } = await discoverWebMcpTools([file])

    expect(inventory.definitions).toHaveLength(0)
    expect(inventory.incompleteDefinitions).toBe(2)
  })

  it("flags arbitrary explicit origins without a trust policy", async () => {
    const content = `document.modelContext.registerTool({
  name: "cross_origin",
  execute: () => ({ ok: true }),
}, { exposedTo: ["self", "https://untrusted.example", ""] })`
    const file = { path: "cross-origin.ts", content, size: content.length, extension: ".ts" }

    const { inventory, context } = await discoverWebMcpTools([file])
    const signal = evaluateWebMcpSurface([file], inventory, context).find(
      (candidate) => candidate.controlId === "WEBMCP-03"
    )

    expect(signal?.state).toBe("DETECTED")
  })

  it("keeps indirect mutation and validation behavior inconclusive", async () => {
    const content = `document.modelContext.registerTool({
  name: "remove_user",
  inputSchema: { type: "object", additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: async (input) => {
    validate(input)
    await fetch("/api/users", requestOptions)
  },
})`
    const file = { path: "indirect.ts", content, size: content.length, extension: ".ts" }
    const { inventory, context } = await discoverWebMcpTools([file])
    const tool = inventory.definitions[0]
    const coverage = summarizeWebMcpCoverage(
      evaluateWebMcpSurface([file], inventory, context),
      inventory.limitsReached
    )

    expect(tool).toMatchObject({
      behavior: "unknown",
      networkMethods: ["UNKNOWN"],
      runtimeValidation: "unknown",
    })
    expect(coverage.controls["WEBMCP-01"].state).toBe("INCONCLUSIVE")
    expect(coverage.controls["WEBMCP-05"].state).toBe("INCONCLUSIVE")
    expect(coverage.controls["WEBMCP-09"].state).toBe("INCONCLUSIVE")
  })

  it("requires every network call to forward the callback signal", async () => {
    const content = `document.modelContext.registerTool({
  name: "mixed_fetches",
  execute: async (_, { signal }) => {
    await fetch("/one", { signal })
    await fetch("/two", { signal: new AbortController().signal })
  },
})`
    const file = { path: "mixed.ts", content, size: content.length, extension: ".ts" }
    const { inventory } = await discoverWebMcpTools([file])

    expect(inventory.definitions[0]?.forwardsCancellation).toBe(false)
  })
})

describe("evaluate and coverage integration", () => {
  it("produces expected states for fixture controls", async () => {
    for (const fixture of WEBMCP_FIXTURES) {
      if (!fixture.expectedStates) continue

      const { inventory, context } = await discoverWebMcpTools([fixture.file])
      const signals = evaluateWebMcpSurface([fixture.file], inventory, context)
      const coverage = summarizeWebMcpCoverage(signals, inventory.limitsReached)

      for (const [controlId, expected] of Object.entries(fixture.expectedStates)) {
        const control = coverage.controls[controlId as keyof typeof coverage.controls]
        expect(control?.state, `Wrong state for ${fixture.name} / ${controlId}`).toBe(expected)
      }
    }
  })

  it("does not report clean controls when discovery is incomplete", async () => {
    const fixture = WEBMCP_FIXTURES.find((f) => f.name === "dynamic name and schema")!
    const { inventory, context } = await discoverWebMcpTools([fixture.file])
    const signals = evaluateWebMcpSurface([fixture.file], inventory, context)
    const coverage = summarizeWebMcpCoverage(signals, inventory.limitsReached)

    expect(coverage.inconclusiveCount).toBeGreaterThan(0)
    expect(
      Object.values(coverage.controls).every((control) => control.state !== "NO_FINDING")
    ).toBe(true)
  })
})
