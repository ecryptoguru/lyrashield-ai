import { describe, it, expect, vi, beforeEach } from "vitest"

const getPolarClientMock = vi.hoisted(() => vi.fn(() => null as unknown))
const getRazorpayClientMock = vi.hoisted(() => vi.fn(() => null as unknown))
const rawQueryMock = vi.hoisted(() => vi.fn())
const rawExecuteMock = vi.hoisted(() => vi.fn())
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
  const systemPrisma = { webhookEvent, $queryRaw: rawQueryMock, $executeRaw: rawExecuteMock }
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
    rawQueryMock.mockResolvedValue([
      {
        checked_through: new Date(),
        coverage_from: new Date(Date.now() - 24 * 24 * 60 * 60 * 1000),
        last_completed_at: null,
      },
    ])
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
    const { prisma } = await import("@lyrashield/db")
    const findFirst = vi.mocked(prisma.webhookEvent.findFirst)
    findFirst
      .mockResolvedValueOnce({ id: "evt_1", processed: true } as never)
      .mockResolvedValueOnce(null)

    const result = await runBillingReconciliation()

    expect(list).toHaveBeenCalledWith({ limit: 100, sorting: ["-created_at"] })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        provider: "polar",
        eventType: "order.paid",
        payload: { path: ["data", "id"], equals: "ord_1" },
      },
      select: { id: true },
    })
    expect(findFirst).toHaveBeenCalledTimes(2)
    expect(findFirst).toHaveBeenLastCalledWith({
      where: {
        provider: "polar",
        eventType: "order.paid",
        payload: { path: ["data", "id"], equals: "ord_late_paid" },
      },
      select: { id: true },
    })
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
    const { prisma } = await import("@lyrashield/db")
    const findFirst = vi.mocked(prisma.webhookEvent.findFirst)
    findFirst
      .mockResolvedValueOnce({ id: "evt_1", processed: true } as never)
      .mockResolvedValueOnce(null)

    const result = await runBillingReconciliation()

    expect(all).toHaveBeenCalledWith({ count: 50, skip: 0, from: sinceSeconds, to: nowSeconds })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        provider: "razorpay",
        eventType: "payment.captured",
        payload: {
          path: ["payload", "payment", "entity", "id"],
          equals: "pay_1",
        },
      },
      select: { id: true },
    })
    expect(findFirst).toHaveBeenCalledTimes(2)
    expect(findFirst).toHaveBeenLastCalledWith({
      where: {
        provider: "razorpay",
        eventType: "payment.captured",
        payload: {
          path: ["payload", "payment", "entity", "id"],
          equals: "pay_late_captured",
        },
      },
      select: { id: true },
    })
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
        items: [{ id: "ord_missing", paid: true, createdAt: new Date() }],
        pagination: { totalCount: 1, maxPage: 1 },
      },
      next: vi.fn().mockResolvedValue(null),
      async *[Symbol.asyncIterator]() {
        yield this
      },
    }
    getPolarClientMock.mockReturnValue({ orders: { list: vi.fn().mockResolvedValue(page) } })
    const { prisma } = await import("@lyrashield/db")
    vi.mocked(prisma.webhookEvent.findFirst).mockResolvedValue(null)

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
    expect(prisma.webhookEvent.findFirst).toHaveBeenCalledTimes(1)
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
    vi.mocked(prisma.webhookEvent.findFirst).mockResolvedValue({ id: "evt_pending" } as never)
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

    expect(prisma.webhookEvent.count).toHaveBeenCalledWith({ where: { processed: false } })
    expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith({
      where: { processed: false },
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
})
