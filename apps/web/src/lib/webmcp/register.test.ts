import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { registerWebMcpTool } from "./register"
import { createWebMcpReceiptStore } from "./receipts"

describe("WebMCP registration", () => {
  let registerTool: ReturnType<typeof vi.fn>

  beforeEach(() => {
    registerTool = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).document = {
      modelContext: {
        registerTool,
      },
    }
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).document
    vi.restoreAllMocks()
  })

  it("registers a tool and unregisters on cleanup", () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ ok: true })

    const cleanup = registerWebMcpTool({
      name: "test_tool",
      title: "Test Tool",
      description: "A test tool.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler,
    })

    expect(registerTool).toHaveBeenCalledOnce()
    const [, options] = registerTool.mock.calls[0]
    expect(options.signal).toBeInstanceOf(AbortSignal)

    cleanup()
    expect(options.signal.aborted).toBe(true)
  })

  it("rejects duplicate active tool names", () => {
    const store = createWebMcpReceiptStore()
    const cleanup = registerWebMcpTool({
      name: "dup_tool",
      title: "Duplicate",
      description: "First registration.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler: vi.fn(),
    })

    expect(() =>
      registerWebMcpTool({
        name: "dup_tool",
        title: "Duplicate 2",
        description: "Second registration.",
        inputSchema: { properties: {} },
        receiptStore: store,
        classification: "read",
        dataClass: "public",
        untrustedContent: false,
        uiChanged: false,
        humanConfirmationRequired: false,
        handler: vi.fn(),
      })
    ).toThrow("already active")

    cleanup()
  })

  it("releases the tool name after asynchronous registration rejection", async () => {
    const store = createWebMcpReceiptStore()
    registerTool.mockRejectedValueOnce(new Error("registration failed"))
    const firstCleanup = registerWebMcpTool({
      name: "retry_tool",
      title: "Retry Tool",
      description: "Tests failed registration cleanup.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler: vi.fn(),
    })

    await Promise.resolve()
    await Promise.resolve()

    const secondCleanup = registerWebMcpTool({
      name: "retry_tool",
      title: "Retry Tool",
      description: "Retries after failed registration.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler: vi.fn(),
    })

    firstCleanup()
    secondCleanup()
  })

  it.each(["request", "registration"])(
    "does not invoke a handler after %s cancellation",
    async (source) => {
      const store = createWebMcpReceiptStore()
      const handler = vi.fn().mockResolvedValue({ ok: true })
      const cleanup = registerWebMcpTool({
        name: "already_cancelled_tool",
        title: "Cancelled Tool",
        description: "Must not execute.",
        inputSchema: { properties: {} },
        receiptStore: store,
        classification: "ui-only",
        dataClass: "public",
        untrustedContent: false,
        uiChanged: true,
        humanConfirmationRequired: false,
        handler,
      })
      const tool = registerTool.mock.calls[0][0] as {
        execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
      }
      const controller = new AbortController()
      if (source === "request") controller.abort()
      else cleanup()
      expect(await tool.execute({}, { signal: controller.signal })).toMatchObject({
        ok: false,
        cancelled: true,
      })
      expect(handler).not.toHaveBeenCalled()
      expect(store.getSnapshot().latest?.status).toBe("cancelled")
      cleanup()
    }
  )

  it("forwards execution cancellation to the handler", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi
      .fn()
      .mockImplementation(async (_input, { signal }: { signal: AbortSignal }) => {
        return new Promise<unknown>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
      })

    const cleanup = registerWebMcpTool({
      name: "cancel_tool",
      title: "Cancel Tool",
      description: "Tests cancellation.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler,
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    const controller = new AbortController()
    const promise = tool.execute({}, { signal: controller.signal })
    controller.abort()

    const result = await promise
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(store.getSnapshot().latest?.status).toBe("cancelled")

    cleanup()
  })

  it("emits a completed receipt with the result", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ prepared: true })

    const cleanup = registerWebMcpTool({
      name: "ok_tool",
      title: "OK Tool",
      description: "Returns a value.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "ui-only",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: true,
      humanConfirmationRequired: false,
      handler,
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options?: { signal: AbortSignal }) => Promise<unknown>
    }
    const result = await tool.execute({})
    expect(await tool.execute({}, { signal: new AbortController().signal })).toMatchObject({
      ok: true,
    })
    expect(result).toMatchObject({ ok: true })
    expect(store.getSnapshot().latest?.status).toBe("completed")
    expect(store.getSnapshot().latest?.classification).toBe("ui-only")

    cleanup()
  })

  it("rejects forbidden cross-workspace input", async () => {
    const store = createWebMcpReceiptStore()

    const cleanup = registerWebMcpTool({
      name: "reject_tool",
      title: "Reject Tool",
      description: "Rejects forbidden keys.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      forbiddenInputKeys: ["workspaceId"],
      handler: vi.fn().mockResolvedValue({ ok: true }),
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    const result = await tool.execute(
      { workspaceId: "injected" },
      { signal: new AbortController().signal }
    )
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Input rejected") })
    expect(store.getSnapshot().latest?.status).toBe("failed")

    cleanup()
  })

  it("rejects undeclared and incorrectly typed input before the handler", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const cleanup = registerWebMcpTool<{ query: string }>({
      name: "validate_tool",
      title: "Validate Tool",
      description: "Validates input.",
      inputSchema: {
        required: ["query"],
        properties: { query: { type: "string", description: "Search query" } },
      },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler,
    })
    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }

    await expect(
      tool.execute({ query: 3, extra: true }, { signal: new AbortController().signal })
    ).resolves.toMatchObject({ ok: false })
    expect(handler).not.toHaveBeenCalled()
    expect(store.getSnapshot().latest?.status).toBe("failed")
    cleanup()
  })

  it("rejects primitive native input even when the tool has no required parameters", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const cleanup = registerWebMcpTool({
      name: "object_only_tool",
      title: "Object Only Tool",
      description: "Requires an object input.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler,
    })
    const tool = registerTool.mock.calls.at(-1)?.[0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }

    await expect(
      tool.execute("not-an-object", { signal: new AbortController().signal })
    ).resolves.toMatchObject({ ok: false })
    expect(handler).not.toHaveBeenCalled()
    cleanup()
  })

  it("rejects oversized string input before the handler", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const cleanup = registerWebMcpTool<{ query: string }>({
      name: "bounded_input_tool",
      title: "Bounded Input Tool",
      description: "Rejects oversized input.",
      inputSchema: {
        required: ["query"],
        properties: { query: { type: "string", description: "Search query" } },
      },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler,
    })
    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }

    await expect(
      tool.execute({ query: "x".repeat(1_501) }, { signal: new AbortController().signal })
    ).resolves.toMatchObject({ ok: false })
    expect(handler).not.toHaveBeenCalled()
    cleanup()
  })

  it("reports cancellation when a handler resolves after abort", async () => {
    const store = createWebMcpReceiptStore()
    let resolveHandler: ((value: unknown) => void) | undefined
    const handler = vi.fn(() => new Promise<unknown>((resolve) => (resolveHandler = resolve)))
    const cleanup = registerWebMcpTool({
      name: "late_cancel_tool",
      title: "Late Cancel Tool",
      description: "Resolves after cancellation.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler,
    })
    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    const controller = new AbortController()
    const resultPromise = tool.execute({}, { signal: controller.signal })
    controller.abort()
    resolveHandler?.({ stale: true })

    await expect(resultPromise).resolves.toMatchObject({ ok: false, cancelled: true })
    expect(store.getSnapshot().latest?.status).toBe("cancelled")
    cleanup()
  })

  it("bounds tool names and descriptions", () => {
    const store = createWebMcpReceiptStore()
    const longDescription = "d".repeat(200)

    const cleanup = registerWebMcpTool({
      name: "bounded_tool",
      title: "Bounded",
      description: longDescription,
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler: vi.fn(),
    })

    const tool = registerTool.mock.calls[0][0] as { description: string }
    expect(tool.description.length).toBeLessThanOrEqual(150)

    cleanup()
  })

  it("returns cleanly when the browser has no modelContext — the page stays functional", () => {
    // Unsupported browser: document exists but document.modelContext does not.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).document = {}
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ ok: true })

    let cleanup: (() => void) | undefined
    expect(() => {
      cleanup = registerWebMcpTool({
        name: "no_modelcontext_tool",
        title: "Unsupported",
        description: "Registration must not throw on unsupported browsers.",
        inputSchema: { properties: {} },
        receiptStore: store,
        classification: "read",
        dataClass: "public",
        untrustedContent: false,
        uiChanged: false,
        humanConfirmationRequired: false,
        handler,
      })
    }).not.toThrow()

    expect(registerTool).not.toHaveBeenCalled()
    // Cleanup stays safe and releases the name for a later registration.
    expect(() => cleanup?.()).not.toThrow()
    let secondCleanup: (() => void) | undefined
    expect(() => {
      secondCleanup = registerWebMcpTool({
        name: "no_modelcontext_tool",
        title: "Unsupported",
        description: "Re-registers after cleanup.",
        inputSchema: { properties: {} },
        receiptStore: store,
        classification: "read",
        dataClass: "public",
        untrustedContent: false,
        uiChanged: false,
        humanConfirmationRequired: false,
        handler,
      })
    }).not.toThrow()
    secondCleanup?.()
  })

  it("unregisters a page-scoped tool on route/workspace change so it can re-register", () => {
    const store = createWebMcpReceiptStore()
    const options = (suffix: string) => ({
      name: "review_scan_progress",
      title: "Review scan progress",
      description: `Page-scoped read for ${suffix}.`,
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read" as const,
      dataClass: "workspace-summary" as const,
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      handler: vi.fn().mockResolvedValue({ ok: true }),
    })

    const firstCleanup = registerWebMcpTool(options("workspace A"))
    expect(registerTool).toHaveBeenCalledTimes(1)
    const [, firstOptions] = registerTool.mock.calls[0]

    // Navigating away (or switching workspace) runs the effect cleanup, which
    // aborts the registration signal and frees the tool name.
    firstCleanup()
    expect(firstOptions.signal.aborted).toBe(true)

    const secondCleanup = registerWebMcpTool(options("workspace B"))
    expect(registerTool).toHaveBeenCalledTimes(2)
    secondCleanup()
  })

  it("reports an uncertain outcome — never a completed cancel — when a durable mutation aborts", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          // The server round-trip is in flight; the result arrives after abort.
          setTimeout(() => resolve({ started: true, scanId: "scan-1" }), 5)
        })
    )
    const cleanup = registerWebMcpTool({
      name: "request_security_scan",
      title: "Request security scan",
      description: "Durable mutation under test.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "mutation-durable",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      durableMutation: true,
      humanConfirmationRequired: false,
      handler,
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    const controller = new AbortController()
    const resultPromise = tool.execute({}, { signal: controller.signal })
    controller.abort()
    const result = (await resultPromise) as {
      ok: boolean
      cancelled?: boolean
      uncertain?: boolean
      error?: string
    }

    // The call was cancelled — but the durable action's outcome is uncertain:
    // the message must say so and must not claim the action was cancelled.
    expect(result.ok).toBe(false)
    expect(result.uncertain).toBe(true)
    expect(result.error).toMatch(/uncertain/i)
    expect(result.error).toMatch(/may (already )?(have|be)/i)
    expect(result.error).toMatch(/poll|status|dashboard/i)
    expect(result.error).not.toMatch(/action was cancelled|has been cancelled|was stopped/i)
    // The receipt reflects the uncertainty rather than a clean "cancelled".
    const receipt = store.getSnapshot().latest
    expect(receipt?.status).toBe("cancelled")
    expect(receipt?.summary).toMatch(/uncertain/i)

    cleanup()
  })

  it("attaches sanitized references and a recovery href from receiptProjection", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ started: true, scanId: "scan-7" })
    const cleanup = registerWebMcpTool<{ requestId: string }>({
      name: "request_security_scan",
      title: "Request security scan",
      description: "Projection under test.",
      inputSchema: {
        required: ["requestId"],
        properties: { requestId: { type: "string", description: "Idempotency id" } },
      },
      receiptStore: store,
      classification: "mutation-durable",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      durableMutation: true,
      humanConfirmationRequired: false,
      receiptProjection: (result, input) => {
        const r = result as { scanId?: string }
        return {
          references: {
            requestId: input.requestId,
            ...(r.scanId ? { scanId: r.scanId } : {}),
            workspaceId: "must-be-dropped",
          },
          href: r.scanId ? `/dashboard/scans/${r.scanId}` : "/dashboard/scans",
        }
      },
      handler,
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    await tool.execute({ requestId: "req-42" }, { signal: new AbortController().signal })

    const receipt = store.getSnapshot().latest
    expect(receipt?.status).toBe("completed")
    expect(receipt?.references).toEqual({ requestId: "req-42", scanId: "scan-7" })
    expect(receipt?.href).toBe("/dashboard/scans/scan-7")

    cleanup()
  })

  it("drops a projection href that is not a safe dashboard path", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ shareUrl: "/reports/shared/r1?token=abc" })
    const cleanup = registerWebMcpTool({
      name: "review_scan_report",
      title: "Review scan report",
      description: "Unsafe href under test.",
      inputSchema: { properties: {} },
      receiptStore: store,
      classification: "read",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      receiptProjection: () => ({
        references: { reportId: "r1" },
        href: "/reports/shared/r1?token=abc",
      }),
      handler,
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    await tool.execute({}, { signal: new AbortController().signal })

    const receipt = store.getSnapshot().latest
    expect(receipt?.references).toEqual({ reportId: "r1" })
    expect(receipt?.href).toBeUndefined()

    cleanup()
  })

  it("rejects caller-supplied principal and foreign resource ids on page tools", async () => {
    const store = createWebMcpReceiptStore()
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const cleanup = registerWebMcpTool({
      name: "page_scoped_tool",
      title: "Page tool",
      description: "Rejects tenancy and foreign-resource inputs.",
      inputSchema: {
        properties: { scanId: { type: "string", description: "Visible scan id" } },
      },
      receiptStore: store,
      classification: "read",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      forbiddenInputKeys: ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"],
      handler,
    })

    const tool = registerTool.mock.calls[0][0] as {
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    for (const key of ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"]) {
      const result = (await tool.execute(
        { [key]: "injected" },
        { signal: new AbortController().signal }
      )) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`"${key}"`)
    }
    expect(handler).not.toHaveBeenCalled()
    cleanup()
  })
})
