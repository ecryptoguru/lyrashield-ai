import "./test-env"
import { describe, expect, it, vi } from "vitest"
import { pruneMyraRetention } from "./retention"
import type { CalendarAdapter } from "./calendar/adapter"

function fakeAdapter(): CalendarAdapter & { cancelEvent: ReturnType<typeof vi.fn> } {
  return {
    name: "mock",
    listBusy: vi.fn().mockResolvedValue([]),
    insertEvent: vi.fn(),
    cancelEvent: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
  }
}

function fakeDb(opts: {
  replacements?: { rescheduledFromId: string | null }[]
  staleOriginals?: { id: string; providerEventId: string | null }[]
}) {
  return {
    myraOperation: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    demoBooking: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi
        .fn()
        .mockResolvedValueOnce(opts.replacements ?? [])
        .mockResolvedValue(opts.staleOriginals ?? []),
    },
    myraConversation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    myraPublicSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    myraIdentityVerification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    supportCase: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    myraAuditEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
  }
}

describe("pruneMyraRetention rescheduled-original reconcile", () => {
  it("cancels a confirmed original superseded by a confirmed replacement", async () => {
    const adapter = fakeAdapter()
    const db = fakeDb({
      replacements: [{ rescheduledFromId: "orig-1" }],
      staleOriginals: [{ id: "orig-1", providerEventId: "evt-1" }],
    })

    const counts = await pruneMyraRetention(db as never, adapter)

    expect(adapter.cancelEvent).toHaveBeenCalledTimes(1)
    expect(adapter.cancelEvent).toHaveBeenCalledWith("evt-1")
    expect(db.demoBooking.update).toHaveBeenCalledWith({
      where: { id: "orig-1" },
      data: expect.objectContaining({
        status: "CANCELED",
        manageTokenHash: null,
        manageTokenRevokedAt: expect.any(Date),
      }),
    })
    expect(counts.rescheduledOriginals).toBe(1)
  })

  it("leaves originals alone while no confirmed replacement exists", async () => {
    const adapter = fakeAdapter()
    const db = fakeDb({ replacements: [] })

    const counts = await pruneMyraRetention(db as never, adapter)

    expect(adapter.cancelEvent).not.toHaveBeenCalled()
    expect(db.demoBooking.update).not.toHaveBeenCalled()
    expect(counts.rescheduledOriginals).toBe(0)
  })

  it("still marks the original canceled when the provider cancel fails", async () => {
    const adapter = fakeAdapter()
    adapter.cancelEvent.mockRejectedValue(new Error("provider down"))
    const db = fakeDb({
      replacements: [{ rescheduledFromId: "orig-1" }],
      staleOriginals: [{ id: "orig-1", providerEventId: "evt-1" }],
    })

    const counts = await pruneMyraRetention(db as never, adapter)

    expect(adapter.cancelEvent).toHaveBeenCalledWith("evt-1")
    expect(db.demoBooking.update).toHaveBeenCalledWith({
      where: { id: "orig-1" },
      data: expect.objectContaining({ status: "CANCELED" }),
    })
    expect(counts.rescheduledOriginals).toBe(1)
  })
})
