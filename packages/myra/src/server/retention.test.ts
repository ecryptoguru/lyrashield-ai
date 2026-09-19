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
  staleOriginals?: { id: string; providerEventId: string | null }[]
  pendingCancellations?: { id: string; providerEventId: string }[]
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
      findMany: vi.fn(async () => opts.pendingCancellations ?? []),
    },
    myraConversation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    myraPublicSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    myraIdentityVerification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    supportCase: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    myraAuditEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue(opts.staleOriginals ?? []),
  }
}

describe("pruneMyraRetention rescheduled-original reconcile", () => {
  it("cancels a confirmed original superseded by a confirmed replacement", async () => {
    const adapter = fakeAdapter()
    const db = fakeDb({
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

  it("bounds outstanding originals instead of repeatedly scanning historical replacements", async () => {
    const adapter = fakeAdapter()
    const db = fakeDb({})

    await pruneMyraRetention(db as never, adapter)

    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
    const query = db.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] }
    const sql = query.strings?.join(" ") ?? ""
    expect(sql).toContain("original.status IN ('CONFIRMED', 'HELD')")
    expect(sql).toContain('replacement."rescheduledFromId" = original.id')
    expect(sql).toContain("LIMIT 100")
  })

  it("leaves originals alone while no confirmed replacement exists", async () => {
    const adapter = fakeAdapter()
    const db = fakeDb({})

    const counts = await pruneMyraRetention(db as never, adapter)

    expect(adapter.cancelEvent).not.toHaveBeenCalled()
    expect(db.demoBooking.update).not.toHaveBeenCalled()
    expect(counts.rescheduledOriginals).toBe(0)
  })

  it("retains a failed provider cancellation for the next maintenance pass", async () => {
    const adapter = fakeAdapter()
    adapter.cancelEvent.mockRejectedValue(new Error("provider down"))
    const db = fakeDb({
      staleOriginals: [{ id: "orig-1", providerEventId: "evt-1" }],
    })

    const counts = await pruneMyraRetention(db as never, adapter)

    expect(adapter.cancelEvent).toHaveBeenCalledWith("evt-1")
    expect(db.demoBooking.update).toHaveBeenCalledWith({
      where: { id: "orig-1" },
      data: expect.objectContaining({ status: "CANCELED", providerEventId: "evt-1" }),
    })
    expect(counts.rescheduledOriginals).toBe(1)
  })

  it("retries a canceled booking until its provider event is confirmed absent", async () => {
    const adapter = fakeAdapter()
    const db = fakeDb({ pendingCancellations: [{ id: "booking-1", providerEventId: "evt-1" }] })

    const counts = await pruneMyraRetention(db as never, adapter)

    expect(adapter.cancelEvent).toHaveBeenCalledWith("evt-1")
    expect(db.demoBooking.updateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: "CANCELED", providerEventId: "evt-1" },
      data: { providerEventId: null },
    })
    expect(counts.pendingProviderCancellations).toBe(1)
  })

  it("commits retention before provider cleanup and preserves pending cancellation rows", async () => {
    let finishCancellation!: () => void
    const adapter = fakeAdapter()
    adapter.cancelEvent.mockImplementation(
      () => new Promise<void>((resolve) => (finishCancellation = resolve))
    )
    const db = fakeDb({ pendingCancellations: [{ id: "booking-1", providerEventId: "evt-1" }] })

    const sweep = pruneMyraRetention(db as never, adapter)
    await vi.waitFor(() => expect(adapter.cancelEvent).toHaveBeenCalledWith("evt-1"))

    try {
      expect(db.demoBooking.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: { lt: expect.any(Date) },
          OR: [{ status: { not: "CANCELED" } }, { providerEventId: null }],
        },
      })
    } finally {
      finishCancellation()
      await sweep
    }
  })
})
