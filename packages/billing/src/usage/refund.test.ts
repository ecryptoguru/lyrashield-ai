import { beforeEach, describe, expect, it, vi } from "vitest"

const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const auditCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "audit_1" }))
const packUpdateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 1 }))
const usageCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "usage_1" }))
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const identityFindMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ accountId: "buyer", workspaceId: "ws_1" })
)
const packFindMock = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ id: "pack_1", remainingMinutes: 40, accountId: "buyer", workspaceId: "ws_1" })
)

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({
    minutePack: { findFirst: identityFindMock },
  }),
  prisma: { auditLog: { create: auditCreateMock } },
  withWorkspaceRLS: withWorkspaceRLSMock,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { reverseRefund } from "./refund"

beforeEach(() => {
  vi.clearAllMocks()
  identityFindMock.mockResolvedValue({ accountId: "buyer", workspaceId: "ws_1" })
  packFindMock.mockResolvedValue({
    id: "pack_1",
    remainingMinutes: 40,
    accountId: "buyer",
    workspaceId: "ws_1",
  })
  const tx = {
    $executeRaw: executeRawMock,
    usageRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: usageCreateMock,
    },
    minutePack: {
      findFirst: packFindMock,
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
      where: { id: "pack_1", remainingMinutes: 40 },
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
        minutePack: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    )

    await expect(reverseRefund("ws_1", "subscription_1", "refund_1")).rejects.toThrow(
      "refund_entitlement_not_resolved"
    )
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("reverses a pack whose attribution workspace was hard-deleted (VERIFY-C-003)", async () => {
    // workspaceId SET NULL on the pack — the {workspaceId, externalId} key can
    // never match again; the account-keyed lookup must still find it.
    identityFindMock.mockResolvedValue({ accountId: "buyer", workspaceId: null })
    packFindMock.mockResolvedValue({
      id: "pack_orphan",
      remainingMinutes: 40,
      accountId: "buyer",
      workspaceId: null,
    })
    withWorkspaceRLSMock.mockImplementation((_workspaceId, callback) =>
      callback({
        $executeRaw: executeRawMock,
        usageRecord: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: usageCreateMock,
        },
        minutePack: { findFirst: packFindMock, updateMany: packUpdateMock },
      })
    )

    const result = await reverseRefund("ws_gone", "order_1", "refund_1", "polar")

    expect(identityFindMock).toHaveBeenCalledWith({
      where: { externalId: "order_1", provider: "polar", deletedAt: null },
      select: { accountId: true },
    })
    expect(packFindMock).toHaveBeenCalledWith({
      where: { externalId: "order_1", provider: "polar", deletedAt: null },
      select: { id: true, remainingMinutes: true, accountId: true, workspaceId: true },
    })
    expect(packUpdateMock).toHaveBeenCalledWith({
      where: { id: "pack_orphan", remainingMinutes: 40 },
      data: { remainingMinutes: 0 },
    })
    // The reversal ledger row keeps the pack's (now NULL) attribution — never
    // the deleted workspace id, which would violate the FK.
    expect(usageCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: null, accountId: "buyer" }),
    })
    expect(result).toEqual({ created: true, reversed: "pack", minutesReversed: 40 })
  })
})
