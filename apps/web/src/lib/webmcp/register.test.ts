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
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    const result = await tool.execute({}, { signal: new AbortController().signal })
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
})
