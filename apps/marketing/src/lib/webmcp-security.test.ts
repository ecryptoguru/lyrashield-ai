import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { discoverWebMcpTools } from "@lyrashield/security/webmcp/discover"
import {
  applyWebMcpRewrite,
  evaluateWebMcpSurface,
  summarizeWebMcpCoverage,
} from "@lyrashield/security/webmcp"
import { planWebMcpRewrite } from "@lyrashield/security/webmcp/rewrite"
import {
  pastedCodeForWebMcp,
  readFilesForWebMcp,
  registerWebMcpTools,
  runLightweightWebMcpDiscovery,
  UNSAFE_EXAMPLE,
  WebMcpAnalyzerState,
  type WebMcpToolDefinition,
} from "./webmcp-security"

describe("public WebMCP Security Lab", () => {
  it("documents the real GitHub Action input", () => {
    // Test-only path is fixed relative to this module.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(
      new URL("../components/tools/WebMcpSecurityLab.astro", import.meta.url),
      "utf8"
    )
    expect(source).toContain("npx lyrashield gate --fail-on HIGH")
    expect(source).not.toContain("check-diff --fail-on")
    expect(source).toContain("fail_on_severity: HIGH")
    expect(source).not.toContain("fail_on: HIGH")
  })

  it("discovers both declarative and imperative tools in the unsafe sample", async () => {
    const file = pastedCodeForWebMcp(UNSAFE_EXAMPLE, ".html")
    const { inventory, context } = await discoverWebMcpTools([file])
    const signals = evaluateWebMcpSurface([file], inventory, context)
    const coverage = summarizeWebMcpCoverage(signals, inventory.limitsReached)

    expect(inventory.definitions.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["send_email", "delete_user"])
    )
    expect(coverage.controls["WEBMCP-03"].state).toBe("DETECTED")
    expect(coverage.controls["WEBMCP-05"].state).toBe("DETECTED")
  })

  it("prepares and verifies one exact-wildcard edit for the public unsafe sample", async () => {
    const file = pastedCodeForWebMcp(UNSAFE_EXAMPLE, ".html")
    const { inventory, context } = await discoverWebMcpTools([file])
    const signals = evaluateWebMcpSurface([file], inventory, context)
    const selected = signals.filter((signal) => signal.controlId === "WEBMCP-03")
    const plan = await planWebMcpRewrite([file], selected, inventory)
    const rewritten = applyWebMcpRewrite(file.content, plan.edits)

    expect(plan.edits).toHaveLength(1)
    expect(plan.addressed).toContain("WEBMCP-03")
    expect(plan.updatedChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(rewritten).toContain('exposedTo: ["self"]')
    expect(rewritten).not.toContain('exposedTo: ["*"]')
  })

  it("routes pasted TypeScript through imperative discovery", async () => {
    const file = pastedCodeForWebMcp(
      `document.modelContext.registerTool({ name: "read_status", execute: () => ({ ok: true }) })`
    )

    expect(file.extension).toBe(".ts")
    const { inventory } = await discoverWebMcpTools([file])
    expect(inventory.definitions).toHaveLength(1)
  })

  it("escapes an attacker-controlled schema type before inventory rendering", async () => {
    const payload = "<img src=x onerror=alert(1)>"
    const file = pastedCodeForWebMcp(
      `document.modelContext.registerTool({ name: "read_status", inputSchema: { type: '${payload}' }, execute: () => ({ ok: true }) })`
    )
    const { inventory } = await discoverWebMcpTools([file])
    expect(inventory.definitions[0]?.inputSchema.type).toBe(payload)

    // Test-only path is fixed relative to this module.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const component = readFileSync(
      new URL("../components/tools/WebMcpSecurityLab.astro", import.meta.url),
      "utf8"
    )
    expect(component).toContain("${escapeHtml(tool.inputSchema.type)}")
    expect(component).not.toContain(">${tool.inputSchema.type}</span>")
  })

  it("gates Apply on edits and Undo on an applied rewrite while retaining Rerun", () => {
    // Test-only path is fixed relative to this module.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const component = readFileSync(
      new URL("../components/tools/WebMcpSecurityLab.astro", import.meta.url),
      "utf8"
    )
    const editGuard = component.indexOf("if (state.rewritePlan.edits.length > 0)")
    const apply = component.indexOf('apply.textContent = "Apply in memory and rerun"')
    const undoGuard = component.indexOf("if (state.canUndo)")
    const undo = component.indexOf('undo.textContent = "Undo"')
    const rerun = component.indexOf('rerun.textContent = "Rerun"')

    expect(editGuard).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(editGuard)
    expect(undoGuard).toBeGreaterThan(apply)
    expect(undo).toBeGreaterThan(undoGuard)
    expect(rerun).toBeGreaterThan(undo)
  })

  it("retains Undo after apply until undo, rerun, or new input", async () => {
    const state = new WebMcpAnalyzerState(() => {
      throw new Error("Worker is replaced by the focused state transition stub")
    })
    state.analyze = async () => {
      state.rewritePlan = null
    }
    state.setFiles([pastedCodeForWebMcp("before")])
    state.rewritePlan = {
      edits: [
        {
          path: "pasted-code.ts",
          startLine: 1,
          startColumn: 0,
          endLine: 1,
          endColumn: 6,
          newText: "after",
          controlIds: ["WEBMCP-03"],
        },
      ],
      addressed: ["WEBMCP-03"],
      unresolved: [],
      warnings: [],
    }

    await state.applyRewrite()
    expect(state.files[0]?.content).toBe("after")
    expect(state.rewritePlan).toBeNull()
    expect(state.canUndo).toBe(true)

    await state.undoRewrite()
    expect(state.files[0]?.content).toBe("before")
    expect(state.canUndo).toBe(false)

    state.canUndo = true
    await state.rerun()
    expect(state.canUndo).toBe(false)

    state.canUndo = true
    state.setFiles([pastedCodeForWebMcp("new input")])
    expect(state.canUndo).toBe(false)
  })

  it("keeps prepared rewrite source and diff out of browser-agent results", async () => {
    const sensitiveSource = "const privateToken = 'source-only-secret'"
    const registered: WebMcpToolDefinition[] = []
    const registrationOptions: WebMCP.ModelContextRegisterToolOptions[] = []
    const activity: string[] = []
    const previousDocument = globalThis.document
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        modelContext: {
          registerTool: (
            tool: WebMcpToolDefinition,
            options: WebMCP.ModelContextRegisterToolOptions
          ) => {
            registered.push(tool)
            registrationOptions.push(options)
            return Promise.resolve()
          },
        },
      },
    })

    const state = {
      files: [pastedCodeForWebMcp(sensitiveSource)],
      signals: [{ controlId: "WEBMCP-03", state: "DETECTED" }],
      selectedControlIds: new Set(),
      rewritePlan: null,
      async prepareRewrite(this: { rewritePlan: unknown }) {
        this.rewritePlan = {
          edits: [{ newText: sensitiveSource }],
          addressed: ["WEBMCP-03"],
          unresolved: [],
          warnings: [sensitiveSource],
        }
      },
      getRewriteDiff: () => sensitiveSource,
      terminate() {},
    } as unknown as WebMcpAnalyzerState

    try {
      const lifecycle = new AbortController()
      registerWebMcpTools(state, lifecycle.signal, (receipt) => {
        activity.push(`${receipt.toolName}:${receipt.status}`)
      })
      const tool = registered.find((candidate) => candidate.name === "prepare_webmcp_rewrite")
      expect(tool).toBeDefined()
      const result = await tool!.execute(
        { controlId: "WEBMCP-03" },
        // Chrome 151 invokes WebMCP callbacks without the optional options object.
        undefined as unknown as WebMCP.ToolExecuteCallbackOptions
      )
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(sensitiveSource)
      expect(serialized).not.toContain('"diff"')
      expect(result).toMatchObject({
        controlId: "WEBMCP-03",
        warningCount: 1,
        rewritePrepared: true,
        applyRequiredHumanReview: true,
      })
      expect(registrationOptions).toHaveLength(2)
      expect(registrationOptions.every((options) => options.signal === lifecycle.signal)).toBe(true)
      expect(registrationOptions.every((options) => !("exposedTo" in options))).toBe(true)
      expect(activity).toEqual([
        "prepare_webmcp_rewrite:running",
        "prepare_webmcp_rewrite:completed",
      ])
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      })
    }
  })

  it("keeps the complete human UI available without native WebMCP", () => {
    const previousDocument = globalThis.document
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    })
    try {
      const state = new WebMcpAnalyzerState(() => {
        throw new Error("Worker must not start during feature detection")
      })
      expect(registerWebMcpTools(state, new AbortController().signal)).toBeNull()
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      })
    }
  })

  it("fails closed when the shared analyzer is unavailable", async () => {
    await expect(
      runLightweightWebMcpDiscovery([pastedCodeForWebMcp(UNSAFE_EXAMPLE, ".html")])
    ).rejects.toThrow("no fallback result")
  })

  it("matches the visible file-limit UX", async () => {
    const file = (name: string, size: number) =>
      ({ name, size, text: async () => "x".repeat(size) }) as File

    await expect(readFilesForWebMcp([file("source.txt", 1)])).rejects.toThrow("not a supported")
    await expect(readFilesForWebMcp([file("large.ts", 1024 * 1024 + 1)])).rejects.toThrow("1 MiB")
    await expect(
      readFilesForWebMcp(Array.from({ length: 21 }, (_, index) => file(`${index}.ts`, 1)))
    ).rejects.toThrow("at most 20")
    await expect(
      readFilesForWebMcp(Array.from({ length: 6 }, (_, index) => file(`${index}.ts`, 1024 * 1024)))
    ).rejects.toThrow("5 MiB total")

    // Test-only path is fixed relative to this module.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const component = readFileSync(
      new URL("../components/tools/WebMcpSecurityLab.astro", import.meta.url),
      "utf8"
    )
    expect(component).toContain("Unsupported files are rejected.")
    expect(component).toContain("only bounded summaries and rewrite metadata are returned")
    expect(component).toContain(
      "Agent activity · ${activity.toolName} · ${activity.status}${ended}"
    )
  })

  it("uses the native registration option shape from the project spec", () => {
    // Test-only path is fixed relative to this module.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const page = readFileSync(new URL("../pages/webmcp.astro", import.meta.url), "utf8")
    expect(page).toContain("{ signal: controller.signal }")
    expect(page).not.toContain("{ signal: controller.signal, exposedTo:")
    expect(page).toContain("Run lyrashield check-diff")
    expect(page).not.toContain("lyraphield")
  })

  it("settles every pending request when cancellation terminates the shared worker", async () => {
    class HangingWorker {
      onmessage: Worker["onmessage"] = null
      onerror: Worker["onerror"] = null
      postMessage() {}
      terminate() {}
    }

    const state = new WebMcpAnalyzerState(() => new HangingWorker() as unknown as Worker)
    state.setFiles([pastedCodeForWebMcp(UNSAFE_EXAMPLE, ".html")])
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = state.analyze(firstController.signal)
    const second = state.analyze(secondController.signal)
    firstController.abort()

    const settled = await Promise.race([
      Promise.all([first, second]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ])
    expect(settled).toBe(true)
  })

  it("rejects pasted input over the local file limit", () => {
    expect(() => pastedCodeForWebMcp("x".repeat(1024 * 1024 + 1))).toThrow("1 MiB")
  })
})
