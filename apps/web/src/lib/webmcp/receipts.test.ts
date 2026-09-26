import { describe, expect, it, vi } from "vitest"
import {
  createWebMcpReceiptStore,
  redactToolInputs,
  safeDashboardHref,
  sanitizeReceiptReferences,
} from "./receipts"

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

  it("carries references and a recovery href on the receipt", () => {
    const store = createWebMcpReceiptStore()
    const receipt = store.add({
      toolName: "request_security_scan",
      classification: "mutation-durable",
      status: "running",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      durableMutation: true,
      humanConfirmationRequired: false,
      summary: "started",
    })
    store.update(receipt.id, {
      references: { requestId: "req-1", scanId: "scan-1" },
      href: "/dashboard/scans/scan-1",
    })
    const stored = store.getSnapshot().receipts[0]
    expect(stored?.references).toEqual({ requestId: "req-1", scanId: "scan-1" })
    expect(stored?.href).toBe("/dashboard/scans/scan-1")
  })
})

describe("safeDashboardHref", () => {
  it("accepts relative dashboard paths", () => {
    expect(safeDashboardHref("/dashboard/scans/scan-1")).toBe("/dashboard/scans/scan-1")
    expect(safeDashboardHref("/dashboard/reports")).toBe("/dashboard/reports")
    expect(safeDashboardHref("  /dashboard/scans  ")).toBe("/dashboard/scans")
  })

  it("rejects external URLs, query secrets, evidence and storage URIs", () => {
    expect(safeDashboardHref("https://app.example.com/dashboard/scans/x")).toBeUndefined()
    expect(safeDashboardHref("/dashboard/scans/x?token=abc")).toBeUndefined()
    expect(safeDashboardHref("/reports/shared/r1?token=secret")).toBeUndefined()
    expect(safeDashboardHref("encrypted://evidence/1")).toBeUndefined()
    expect(safeDashboardHref("s3://bucket/key")).toBeUndefined()
    expect(safeDashboardHref("//evil.example.com/dashboard")).toBeUndefined()
    expect(safeDashboardHref("/dashboard/../admin")).toBeUndefined()
    expect(safeDashboardHref("javascript:alert(1)")).toBeUndefined()
    expect(safeDashboardHref("/dashboard/scans/x#frag")).toBeUndefined()
    expect(safeDashboardHref(42)).toBeUndefined()
    expect(safeDashboardHref(null)).toBeUndefined()
  })
})

describe("sanitizeReceiptReferences", () => {
  it("keeps short string ids and drops sensitive keys", () => {
    const refs = sanitizeReceiptReferences({
      scanId: "scan-1",
      operationId: "op-9",
      requestId: "req-2",
      workspaceId: "ws-secret",
      userId: "user-1",
      token: "t",
      nested: { deep: true },
      count: 3,
      empty: "",
    })
    expect(refs).toEqual({ scanId: "scan-1", operationId: "op-9", requestId: "req-2" })
  })

  it("drops URI-shaped values — references are identifiers, not locators", () => {
    const refs = sanitizeReceiptReferences({
      scanId: "scan-1",
      evidenceUri: "encrypted://evidence/1",
      link: "https://signed.example/x?token=abc",
    })
    expect(refs).toEqual({ scanId: "scan-1" })
  })

  it("returns undefined for non-objects or empty results", () => {
    expect(sanitizeReceiptReferences("scan-1")).toBeUndefined()
    expect(sanitizeReceiptReferences(null)).toBeUndefined()
    expect(sanitizeReceiptReferences({ workspaceId: "ws" })).toBeUndefined()
  })

  it("truncates oversized values", () => {
    const refs = sanitizeReceiptReferences({ scanId: "s".repeat(500) })
    expect(refs?.scanId.length).toBeLessThanOrEqual(201)
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
