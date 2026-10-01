import { describe, it, expect, vi, beforeEach } from "vitest"

const getPolarClientMock = vi.hoisted(() => vi.fn(() => null as unknown))
const getRazorpayClientMock = vi.hoisted(() => vi.fn(() => null as unknown))
const rawQueryMock = vi.hoisted(() => vi.fn())
const rawExecuteMock = vi.hoisted(() => vi.fn())
const lookupResults: Array<Array<{ id: string; processed?: boolean }>> = []
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock the billing module
vi.mock("@lyrashield/billing", () => ({
  getPolarClient: getPolarClientMock,
  getRazorpayClient: getRazorpayClientMock,
  // Faithful stand-in for the pack predicate: the topup routes stamp
  // metadata/notes.packId = "pack_<n>" for pack purchases; any other product
  // hint is not a minute-pack settlement.
  isMinutePackOrderPayload: (entity: Record<string, unknown>) => {
    const meta = (entity.metadata ?? entity.notes) as Record<string, unknown> | undefined
    return typeof meta?.packId === "string" && meta.packId.startsWith("pack_")
  },
}))

// Mock prisma. getSystemPrisma returns the same mock shape: the
// reconciliation sweep reads WebhookEvent (FORCE RLS strict) cross-workspace.
vi.mock("@lyrashield/db", () => {
  const webhookEvent = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(() => Promise.resolve([])),
    count: vi.fn(() => Promise.resolve(0)),
  }
  const webhookEventTrack = {
    count: vi.fn(() => Promise.resolve(0)),
  }
  const minutePack = {
    findFirst: vi.fn(() => Promise.resolve({ id: "pack_row_1" })),
  }
  const systemPrisma = {
    webhookEvent,
    webhookEventTrack,
    minutePack,
    $queryRaw: rawQueryMock,
    $executeRaw: rawExecuteMock,
  }
  return {
    prisma: { webhookEvent },
    getSystemPrisma: () => systemPrisma,
  }
})

// Mock logger
vi.mock("@lyrashield/logger", () => ({
  logger: loggerMock,
}))

import { runBillingReconciliation } from "./billing-reconciliation.job"

describe("billing-reconciliation.job", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { prisma } = await import("@lyrashield/db")
    vi.mocked(prisma.webhookEvent.findFirst).mockReset().mockResolvedValue(null)
    vi.mocked(prisma.webhookEvent.findMany).mockReset().mockResolvedValue([])
    vi.mocked(prisma.webhookEvent.count).mockReset().mockResolvedValue(0)
    const { getSystemPrisma } = await import("@lyrashield/db")
    vi.mocked(getSystemPrisma().webhookEventTrack.count).mockReset().mockResolvedValue(0)
    vi.mocked(getSystemPrisma().minutePack.findFirst)
      .mockReset()
      .mockResolvedValue({ id: "pack_row_1" } as never)
    lookupResults.length = 0
    rawQueryMock.mockImplementation((strings: TemplateStringsArray) => {
      if (strings.join("").includes('FROM "WebhookEvent"')) {
        return Promise.resolve(lookupResults.shift() ?? [])
      }
      return Promise.resolve([
        {
          checked_through: new Date(),
          coverage_from: new Date(Date.now() - 24 * 24 * 60 * 60 * 1000),
          last_completed_at: null,
        },
      ])
    })
    rawExecuteMock.mockResolvedValue(1)
    getPolarClientMock.mockReturnValue({
      orders: {
        list: vi.fn().mockResolvedValue({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    })
    getRazorpayClientMock.mockReturnValue({
      payments: { all: vi.fn().mockResolvedValue({ items: [] }) },
    })
  })

  it("reports incomplete provider checks when no providers are configured", async () => {
    getPolarClientMock.mockReturnValue(null)
    getRazorpayClientMock.mockReturnValue(null)
    const result = await runBillingReconciliation()

    expect(result).toBeDefined()
    expect(result.polarChecked).toBe(0)
    expect(result.razorpayChecked).toBe(0)
    expect(result.replayed).toBe(0)
    expect(result.completed).toBe(false)
    expect(result.driftAlerts).toBe(2)
    expect(result.alerts).toEqual([
      {
        provider: "polar",
        type: "provider_check_failed",
        message: "polar reconciliation failed; provider events were not checked",
      },
      {
        provider: "razorpay",
        type: "provider_check_failed",
        message: "razorpay reconciliation failed; provider events were not checked",
      },
    ])
  })

  it("completes without throwing when providers are unavailable", async () => {
    // The mocks return null for both clients, so reconciliation should
    // gracefully skip both providers and only check unprocessed events.
    getPolarClientMock.mockReturnValue(null)
    getRazorpayClientMock.mockReturnValue(null)
    const result = await runBillingReconciliation()

    expect(result.polarChecked).toBe(0)
    expect(result.razorpayChecked).toBe(0)
    expect(result.driftAlerts).toBe(2)
  })

  it("finds a Polar order paid after creation within the 24-day baseline", async () => {
    const recent = new Date(Date.now() - 60_000)
    const latePaid = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    const page = {
      result: {
        items: [
          { id: "ord_1", paid: true, createdAt: recent },
          { id: "ord_late_paid", paid: true, createdAt: latePaid },
        ],
        pagination: { totalCount: 2, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    const list = vi.fn().mockResolvedValue(page)
    getPolarClientMock.mockReturnValue({
      orders: { list },
    })
    lookupResults.push([{ id: "evt_1" }], [])

    const result = await runBillingReconciliation()

    expect(list).toHaveBeenCalledWith({ limit: 100, sorting: ["-created_at"] })
    const lookups = rawQueryMock.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").includes('FROM "WebhookEvent"')
    )
    expect(lookups).toHaveLength(2)
    expect(lookups.map(([, objectId]) => objectId)).toEqual(["ord_1", "ord_late_paid"])
    expect(lookups[0]?.[0].join("")).toContain(
      "provider = 'polar' AND \"eventType\" = 'order.paid'"
    )
    expect(lookups[0]?.[0].join("")).toContain("payload #> '{data,id}'")
    expect(result).toMatchObject({ polarChecked: 2, driftAlerts: 1, replayed: 0 })
  })

  it("finds a Razorpay payment captured after creation within the 24-day baseline", async () => {
    const checkedThrough = new Date()
    const coverageFrom = new Date(checkedThrough.getTime() - 24 * 24 * 60 * 60 * 1000)
    const nowSeconds = Math.floor(checkedThrough.getTime() / 1000)
    const sinceSeconds = Math.floor(coverageFrom.getTime() / 1000)
    const lateCreatedAt = nowSeconds - 4 * 24 * 60 * 60
    rawQueryMock.mockResolvedValueOnce([
      { checked_through: checkedThrough, coverage_from: coverageFrom, last_completed_at: null },
    ])
    const all = vi.fn().mockResolvedValueOnce({
      items: [
        { id: "pay_1", status: "captured", created_at: nowSeconds - 60 },
        { id: "pay_late_captured", status: "captured", created_at: lateCreatedAt },
      ],
    })
    getRazorpayClientMock.mockReturnValue({
      payments: { all },
    })
    lookupResults.push([{ id: "evt_1" }], [])

    const result = await runBillingReconciliation()

    expect(all).toHaveBeenCalledWith({ count: 50, skip: 0, from: sinceSeconds, to: nowSeconds })
    const lookups = rawQueryMock.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").includes('FROM "WebhookEvent"')
    )
    expect(lookups).toHaveLength(2)
    expect(lookups.map(([, objectId]) => objectId)).toEqual(["pay_1", "pay_late_captured"])
    expect(lookups[0]?.[0].join("")).toContain(
      "provider = 'razorpay' AND \"eventType\" = 'payment.captured'"
    )
    expect(lookups[0]?.[0].join("")).toContain("payload #> '{payload,payment,entity,id}'")
    expect(result).toMatchObject({ razorpayChecked: 2, driftAlerts: 1, replayed: 0 })
    expect(result.completed).toBe(true)
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Billing reconciliation complete",
      expect.objectContaining({
        initialBaseline: true,
        coverageFrom: coverageFrom.toISOString(),
        checkedThrough: checkedThrough.toISOString(),
      })
    )
  })

  it("uses the last successful checkpoint with a 24-day overlap after a long outage", async () => {
    const lastCompletedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    rawQueryMock.mockResolvedValueOnce([
      {
        checked_through: new Date(),
        coverage_from: new Date(Date.now() - 24 * 24 * 60 * 60 * 1000),
        last_completed_at: lastCompletedAt,
      },
    ])
    const all = vi.fn().mockResolvedValue({ items: [] })
    getRazorpayClientMock.mockReturnValue({ payments: { all } })

    const result = await runBillingReconciliation()

    const from = all.mock.calls[0]?.[0].from as number
    expect(from).toBe(Math.floor((lastCompletedAt.getTime() - 24 * 24 * 60 * 60 * 1000) / 1000))
    expect(result.completed).toBe(true)
  })

  it("does not advance the checkpoint when a provider check fails", async () => {
    getPolarClientMock.mockReturnValue({
      orders: { list: vi.fn().mockRejectedValue(new Error("provider unavailable")) },
    })

    const result = await runBillingReconciliation()
    const executeQueries = rawExecuteMock.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join("")
    )

    expect(result.completed).toBe(false)
    expect(executeQueries.some((query) => query.includes('"last_completed_at" ='))).toBe(false)
  })

  it("rejects malformed Razorpay pages instead of advancing as an empty scan", async () => {
    getRazorpayClientMock.mockReturnValue({
      payments: { all: vi.fn().mockResolvedValue({}) },
    })

    const result = await runBillingReconciliation()
    const executeQueries = rawExecuteMock.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join("")
    )

    expect(result.completed).toBe(false)
    expect(result.alerts).toContainEqual(
      expect.objectContaining({ provider: "razorpay", type: "provider_check_failed" })
    )
    expect(executeQueries.some((query) => query.includes('"last_completed_at" ='))).toBe(false)
  })

  it("does not advance when a stale worker loses the lease", async () => {
    rawExecuteMock.mockResolvedValueOnce(0)

    await expect(runBillingReconciliation()).rejects.toThrow("lease was lost")
    const executeQueries = rawExecuteMock.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join("")
    )
    expect(executeQueries.some((query) => query.includes('"last_completed_at" ='))).toBe(false)
  })

  it("skips overlapping runs while another worker holds the lease", async () => {
    rawQueryMock.mockResolvedValueOnce([])

    const result = await runBillingReconciliation()

    expect(result.skipped).toBe(true)
    expect(result.completed).toBe(false)
    expect(getPolarClientMock).not.toHaveBeenCalled()
    expect(getRazorpayClientMock).not.toHaveBeenCalled()
  })

  it("does not advance the checkpoint when the database sweep fails", async () => {
    const { prisma } = await import("@lyrashield/db")
    vi.mocked(prisma.webhookEvent.findMany).mockRejectedValueOnce(new Error("database unavailable"))

    await expect(runBillingReconciliation()).rejects.toThrow("database unavailable")
    const executeQueries = rawExecuteMock.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join("")
    )
    expect(executeQueries.some((query) => query.includes('"last_completed_at" ='))).toBe(false)
  })

  it("logs provider drift as an operator alert without replaying or mutating billing state", async () => {
    const page = {
      result: {
        items: [{ id: "ord_missing", paid: true, createdAt: new Date(Date.now() - 60_000) }],
        pagination: { totalCount: 1, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
    const { prisma } = await import("@lyrashield/db")

    const result = await runBillingReconciliation()

    expect(result.alerts).toHaveLength(1)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "operator_alert",
      expect.objectContaining({
        code: "reconciliation_drift",
        severity: "warning",
        alertSamples: [expect.objectContaining({ provider: "polar" })],
      })
    )
    expect(
      rawQueryMock.mock.calls.filter(([strings]) =>
        (strings as TemplateStringsArray).join("").includes('FROM "WebhookEvent"')
      )
    ).toHaveLength(1)
    expect(prisma.webhookEvent.findMany).toHaveBeenCalledTimes(1)
  })

  it("counts an unprocessed webhook once across provider and ledger checks", async () => {
    const page = {
      result: {
        items: [{ id: "ord_pending", paid: true, createdAt: new Date() }],
        pagination: { totalCount: 1, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
    const { prisma } = await import("@lyrashield/db")
    lookupResults.push([{ id: "evt_pending" }])
    vi.mocked(prisma.webhookEvent.count).mockResolvedValue(1)
    vi.mocked(prisma.webhookEvent.findMany).mockResolvedValue([
      {
        id: "evt_pending",
        provider: "polar",
        externalId: "ord_pending",
        eventType: "order.paid",
      },
    ] as never)

    const result = await runBillingReconciliation()

    expect(result.driftAlerts).toBe(1)
    expect(result.alerts).toEqual([
      {
        provider: "polar",
        externalId: "ord_pending",
        type: "order.paid",
        message: "Unprocessed polar webhook event: order.paid",
      },
    ])
  })

  it("counts every unprocessed webhook and logs an ordered bounded sample", async () => {
    const { prisma } = await import("@lyrashield/db")
    const oldEvent = {
      id: "evt_old",
      provider: "polar",
      externalId: "evt_old_external",
      eventType: "subscription.updated",
    }
    vi.mocked(prisma.webhookEvent.count).mockResolvedValue(101)
    vi.mocked(prisma.webhookEvent.findMany).mockResolvedValue([oldEvent] as never)

    const result = await runBillingReconciliation()

    expect(prisma.webhookEvent.count).toHaveBeenCalledWith({
      where: {
        processed: false,
        provider: { in: ["polar", "razorpay"] },
        createdAt: { gte: expect.any(Date), lt: expect.any(Date) },
      },
    })
    expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith({
      where: {
        processed: false,
        provider: { in: ["polar", "razorpay"] },
        createdAt: { gte: expect.any(Date), lt: expect.any(Date) },
      },
      select: { id: true, provider: true, externalId: true, eventType: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    })
    expect(result.driftAlerts).toBe(101)
    expect(result.alerts).toHaveLength(1)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "operator_alert",
      expect.objectContaining({
        alertCount: 101,
        alertSamples: [expect.objectContaining({ externalId: "evt_old_external" })],
        truncatedAlertCount: 100,
      })
    )
  })

  it.each(["polar", "razorpay"] as const)(
    "alerts when the %s provider query fails instead of reporting a clean check",
    async (provider) => {
      const error = new Error("provider unavailable")
      if (provider === "polar") {
        getPolarClientMock.mockReturnValue({
          orders: { list: vi.fn().mockRejectedValue(error) },
        })
      } else {
        getRazorpayClientMock.mockReturnValue({
          payments: { all: vi.fn().mockRejectedValue(error) },
        })
      }

      const result = await runBillingReconciliation()

      expect(result.driftAlerts).toBe(1)
      expect(result.alerts).toEqual([
        {
          provider,
          type: "provider_check_failed",
          message: `${provider} reconciliation failed; provider events were not checked`,
        },
      ])
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "operator_alert",
        expect.objectContaining({
          code: "reconciliation_drift",
          alertCount: 1,
          alertSamples: [expect.objectContaining({ provider, type: "provider_check_failed" })],
        })
      )
    }
  )

  it("alerts when Razorpay returns no payment response", async () => {
    getRazorpayClientMock.mockReturnValue({
      payments: { all: vi.fn().mockResolvedValue(null) },
    })

    const result = await runBillingReconciliation()

    expect(result.alerts).toContainEqual({
      provider: "razorpay",
      type: "provider_check_failed",
      message: "razorpay reconciliation failed; provider events were not checked",
    })
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "operator_alert",
      expect.objectContaining({ code: "reconciliation_drift", alertCount: 1 })
    )
  })

  it("scopes the unprocessed sweep to billing providers — GitHub rows are never billing drift", async () => {
    const { prisma } = await import("@lyrashield/db")

    const result = await runBillingReconciliation()

    // Every unprocessed-event query must carry the billing-provider scope; a
    // pending GitHub delivery sharing the WebhookEvent table is not revenue
    // drift and must not inflate alert counts or the backlog signal.
    for (const call of vi.mocked(prisma.webhookEvent.count).mock.calls) {
      expect(call[0]).toMatchObject({
        where: { processed: false, provider: { in: ["polar", "razorpay"] } },
      })
    }
    for (const call of vi.mocked(prisma.webhookEvent.findMany).mock.calls) {
      expect(call[0]).toMatchObject({
        where: { processed: false, provider: { in: ["polar", "razorpay"] } },
      })
    }
    expect(result.driftAlerts).toBe(0)
    expect(result.backlog).toEqual({ unprocessedBeforeCoverage: 0, deadLetterTracks: 0 })
  })

  it("keeps older unresolved Polar rows visible through the backlog signal", async () => {
    const { prisma, getSystemPrisma } = await import("@lyrashield/db")
    // First count is the coverage-windowed sweep (0 in-window rows); the second
    // is the pre-window backlog count — a 30-day-old unprocessed Polar row the
    // 24-day baseline can no longer reach.
    vi.mocked(prisma.webhookEvent.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3)
    vi.mocked(getSystemPrisma().webhookEventTrack.count).mockResolvedValue(2)

    const result = await runBillingReconciliation()

    expect(result.backlog).toEqual({ unprocessedBeforeCoverage: 3, deadLetterTracks: 2 })
    expect(vi.mocked(prisma.webhookEvent.count).mock.calls[1]?.[0]).toMatchObject({
      where: {
        processed: false,
        provider: { in: ["polar", "razorpay"] },
        createdAt: { lt: expect.any(Date) },
      },
    })
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "operator_alert",
      expect.objectContaining({
        code: "reconciliation_backlog",
        unprocessedBeforeCoverage: 3,
        deadLetterTracks: 2,
      })
    )
    // Backlog is a health signal only — it is not replayed or per-row drift.
    expect(result.driftAlerts).toBe(0)
    expect(result.completed).toBe(true)
  })

  it("skips provider listing when the durable cursor already completed today's run", async () => {
    rawQueryMock.mockResolvedValueOnce([
      {
        checked_through: new Date(),
        coverage_from: new Date(Date.now() - 24 * 24 * 60 * 60 * 1000),
        last_completed_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    ])

    const result = await runBillingReconciliation()

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("daily_complete")
    expect(result.completed).toBe(false)
    expect(getPolarClientMock).not.toHaveBeenCalled()
    expect(getRazorpayClientMock).not.toHaveBeenCalled()
    const { prisma } = await import("@lyrashield/db")
    expect(prisma.webhookEvent.findMany).not.toHaveBeenCalled()
  })

  it("runs again once the last completed run is outside the daily window", async () => {
    rawQueryMock.mockResolvedValueOnce([
      {
        checked_through: new Date(),
        coverage_from: new Date(Date.now() - 24 * 24 * 60 * 60 * 1000),
        last_completed_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    ])

    const result = await runBillingReconciliation()

    expect(result.skipped).toBe(false)
    expect(getPolarClientMock).toHaveBeenCalled()
    expect(getRazorpayClientMock).toHaveBeenCalled()
    expect(result.completed).toBe(true)
  })

  it("verifies a processed pack settlement produced its MinutePack credit", async () => {
    const { getSystemPrisma } = await import("@lyrashield/db")
    const page = {
      result: {
        items: [
          {
            id: "ord_pack",
            paid: true,
            createdAt: new Date(Date.now() - 60_000),
            metadata: { packId: "pack_100" },
          },
        ],
        pagination: { totalCount: 1, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
    lookupResults.push([{ id: "evt_pack", processed: true }])

    const result = await runBillingReconciliation()

    // The settlement was received AND applied: the internal credit exists, so
    // no drift. The credit probe is cross-workspace on the system client and
    // keyed by the provider object id — the same idempotency key creditTopUp
    // enforces — so workspace attribution loss cannot hide a real credit.
    expect(getSystemPrisma().minutePack.findFirst).toHaveBeenCalledWith({
      where: { provider: "polar", externalId: "ord_pack", deletedAt: null },
      select: { id: true },
    })
    expect(result.packCreditsVerified).toBe(1)
    expect(result.driftAlerts).toBe(0)
    expect(result.completed).toBe(true)
  })

  it.each(["polar", "razorpay"] as const)(
    "alerts when a processed %s pack settlement never produced its internal credit",
    async (provider) => {
      const { getSystemPrisma } = await import("@lyrashield/db")
      vi.mocked(getSystemPrisma().minutePack.findFirst).mockResolvedValue(null)
      if (provider === "polar") {
        const page = {
          result: {
            items: [
              {
                id: "ord_uncredited",
                paid: true,
                createdAt: new Date(Date.now() - 60_000),
                metadata: { packId: "pack_100" },
              },
            ],
            pagination: { totalCount: 1, maxPage: 1 },
          },
          next: vi.fn().mockResolvedValue(null),
          async *[Symbol.asyncIterator]() {
            yield this
          },
        }
        getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
      } else {
        const all = vi.fn().mockResolvedValueOnce({
          items: [
            {
              id: "pay_uncredited",
              status: "captured",
              created_at: Math.floor(Date.now() / 1000) - 60,
              notes: { packId: "pack_100" },
            },
          ],
        })
        getRazorpayClientMock.mockReturnValue({ payments: { all } })
      }
      lookupResults.push([{ id: "evt_done", processed: true }])

      const result = await runBillingReconciliation()

      const objectId = provider === "polar" ? "ord_uncredited" : "pay_uncredited"
      expect(result.packCreditsVerified).toBe(0)
      expect(result.driftAlerts).toBe(1)
      expect(result.alerts).toEqual([
        expect.objectContaining({
          provider,
          externalId: objectId,
          type: "settlement_credit_missing",
        }),
      ])
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "operator_alert",
        expect.objectContaining({
          code: "reconciliation_drift",
          alertSamples: [
            expect.objectContaining({ provider, type: "settlement_credit_missing" }),
          ],
        })
      )
      // Report-only: the run still completes and never replays or credits.
      expect(result.completed).toBe(true)
      expect(result.replayed).toBe(0)
    }
  )

  it("skips the credit probe for settlements that are not pack purchases", async () => {
    const { getSystemPrisma } = await import("@lyrashield/db")
    const page = {
      result: {
        items: [
          {
            id: "ord_local",
            paid: true,
            createdAt: new Date(Date.now() - 60_000),
            metadata: { productId: "local_team" },
          },
        ],
        pagination: { totalCount: 1, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
    lookupResults.push([{ id: "evt_local", processed: true }])

    const result = await runBillingReconciliation()

    expect(getSystemPrisma().minutePack.findFirst).not.toHaveBeenCalled()
    expect(result.packCreditsVerified).toBe(0)
    expect(result.driftAlerts).toBe(0)
  })

  it("leaves credit verification to the unprocessed sweep when the receipt is not applied", async () => {
    const { getSystemPrisma } = await import("@lyrashield/db")
    const page = {
      result: {
        items: [
          {
            id: "ord_pending_pack",
            paid: true,
            createdAt: new Date(Date.now() - 60_000),
            metadata: { packId: "pack_100" },
          },
        ],
        pagination: { totalCount: 1, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
    lookupResults.push([{ id: "evt_pending_pack", processed: false }])

    const result = await runBillingReconciliation()

    // The receipt exists but never applied — the unprocessed-event sweep owns
    // that signal; the credit probe must not double-count it here.
    expect(getSystemPrisma().minutePack.findFirst).not.toHaveBeenCalled()
    expect(result.packCreditsVerified).toBe(0)
    expect(result.driftAlerts).toBe(0)
  })
})
