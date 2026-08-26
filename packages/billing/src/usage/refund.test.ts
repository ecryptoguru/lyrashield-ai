import { beforeEach, describe, expect, it, vi } from "vitest"

const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const auditCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "audit_1" }))
const packUpdateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 1 }))
const usageCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "usage_1" }))
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))

vi.mock("@lyrashield/db", () => ({
  prisma: { auditLog: { create: auditCreateMock } },
  withWorkspaceRLS: withWorkspaceRLSMock,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { reverseRefund } from "./refund"

beforeEach(() => {
  vi.clearAllMocks()
  const tx = {
    $executeRaw: executeRawMock,
    usageRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: usageCreateMock,
    },
    minutePack: {
      findUnique: vi.fn().mockResolvedValue({ id: "pack_1", remainingMinutes: 40 }),
      updateMany: packUpdateMock,
    },
  }
  withWorkspaceRLSMock.mockImplementation((workspaceId, callback) => {
    expect(workspaceId).toBe("ws_1")
    return callback(tx)
  })
})

describe("reverseRefund", () => {
  it("reverses the purchased resource and records the distinct refund id atomically", async () => {
    const result = await reverseRefund("ws_1", "order_1", "refund_1")

    expect(packUpdateMock).toHaveBeenCalledWith({
      where: { id: "pack_1", workspaceId: "ws_1", remainingMinutes: 40 },
      data: { remainingMinutes: 0 },
    })
    expect(executeRawMock).toHaveBeenCalledOnce()
    expect(usageCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: "ws_1:refund_1",
        quantity: 40,
        metadata: expect.objectContaining({
          refundExternalId: "refund_1",
          resourceExternalId: "order_1",
        }),
      }),
    })
    expect(result).toEqual({ created: true, reversed: "pack", minutesReversed: 40 })
  })

  it("fails closed when the provider payload cannot identify a local entitlement", async () => {
    withWorkspaceRLSMock.mockImplementationOnce((_workspaceId, callback) =>
      callback({
        $executeRaw: executeRawMock,
        usageRecord: { findUnique: vi.fn().mockResolvedValue(null) },
        minutePack: { findUnique: vi.fn().mockResolvedValue(null) },
      })
    )

    await expect(reverseRefund("ws_1", "subscription_1", "refund_1")).rejects.toThrow(
      "refund_entitlement_not_resolved"
    )
    expect(auditCreateMock).not.toHaveBeenCalled()
  })
})
