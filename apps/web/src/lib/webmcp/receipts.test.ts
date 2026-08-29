import { describe, expect, it, vi } from "vitest"
import { createWebMcpReceiptStore, redactToolInputs } from "./receipts"

describe("WebMCP receipt store", () => {
  it("returns the same snapshot until the store changes", () => {
    const store = createWebMcpReceiptStore()
    const before = store.getSnapshot()
    expect(store.getSnapshot()).toBe(before)

    store.add({
      toolName: "snapshot-test",
      classification: "read",
      status: "completed",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: false,
      durableMutation: false,
      humanConfirmationRequired: false,
      summary: "done",
    })

    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it("stores receipts and keeps only the last 20", () => {
    const store = createWebMcpReceiptStore()
    for (let i = 0; i < 25; i++) {
      store.add({
        toolName: `tool-${i}`,
        classification: "read",
        status: "completed",
        dataClass: "workspace-summary",
        untrustedContent: false,
        uiChanged: false,
        durableMutation: false,
        humanConfirmationRequired: false,
        summary: `run ${i}`,
      })
    }
    expect(store.getSnapshot().receipts).toHaveLength(20)
    expect(store.getSnapshot().latest?.toolName).toBe("tool-24")
  })

  it("notifies subscribers on add, update, and clear", () => {
    const store = createWebMcpReceiptStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    const receipt = store.add({
      toolName: "notify-test",
      classification: "ui-only",
      status: "running",
      dataClass: "public",
      untrustedContent: false,
      uiChanged: true,
      durableMutation: false,
      humanConfirmationRequired: false,
      summary: "started",
    })
    expect(listener).toHaveBeenCalledTimes(1)

    store.update(receipt.id, { status: "completed", summary: "done" })
    expect(listener).toHaveBeenCalledTimes(2)

    store.clear()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
  })

  it("returns null when updating an unknown receipt", () => {
    const store = createWebMcpReceiptStore()
    expect(store.update("missing", { status: "completed" })).toBeNull()
  })
})

describe("redactToolInputs", () => {
  it("redacts sensitive keys and truncates long strings", () => {
    const input = {
      query: "find issues",
      workspaceId: "ws-123",
      apiKey: "super-secret",
      userToken: "token",
      evidenceUrl: "https://example.com/evidence",
      notes: "x".repeat(500),
    }
    const redacted = redactToolInputs(input)
    expect(redacted.query).toBe("find issues")
    expect(redacted.workspaceId).toBe("[REDACTED]")
    expect(redacted.apiKey).toBe("[REDACTED]")
    expect(redacted.userToken).toBe("[REDACTED]")
    expect(redacted.evidenceUrl).toBe("[REDACTED]")
    expect(typeof redacted.notes).toBe("string")
    expect((redacted.notes as string).length).toBeLessThanOrEqual(201)
  })

  it("redacts nested sensitive values", () => {
    const input = {
      search: { query: "ok", workspaceId: "ws", token: "tok" },
    }
    const redacted = redactToolInputs(input as Record<string, unknown>)
    expect((redacted.search as { query: string }).query).toBe("ok")
    expect((redacted.search as { workspaceId: string }).workspaceId).toBe("[REDACTED]")
  })
})
