import { beforeEach, describe, expect, it, vi } from "vitest"

const { findMany, findEvents, findMyraMessages, findReservations } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findEvents: vi.fn(),
  findMyraMessages: vi.fn(),
  findReservations: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
    callback({
      scan: { findMany },
      scanEvent: { findMany: findEvents },
      myraMessage: { findMany: findMyraMessages },
      myraGenerationReservation: { findMany: findReservations },
    })
  ),
}))

import { withWorkspaceRLS } from "@lyrashield/db"
import { reviewWorkspaceCacheEconomics } from "./review-cache-economics"

const from = new Date("2026-10-01T00:00:00.000Z")
const to = new Date("2026-10-02T00:00:00.000Z")

const modelPricingBuckets = [
  {
    model: "azure/gpt-6-luna",
    standardInputTokens: 1_000,
    standardCachedInputTokens: 400,
    standardCacheWriteInputTokens: 100,
    standardOutputTokens: 50,
    longInputTokens: 0,
    longCachedInputTokens: 0,
    longCacheWriteInputTokens: 0,
    longOutputTokens: 0,
  },
]

function completedScan() {
  return {
    id: "private-scan-id",
    mode: "SAFE",
    status: "COMPLETED",
  }
}

function events(scanId = "private-scan-id") {
  return [
    {
      scanId,
      stage: "llm_usage",
      metadata: {
        accountingComplete: true,
        requestCount: 2,
        inputTokens: 1_000,
        cachedInputTokens: 400,
        cacheWriteInputTokens: 100,
        outputTokens: 50,
        modelPricingBuckets,
        modelTokenCostUsd: 0.0000915,
        webSearchCostUsd: 0.001,
        prompt: "must not appear in report",
        evidence: "must not appear in report",
      },
    },
    {
      scanId,
      stage: "ai_security_triage",
      metadata: {
        cacheOperations: { readCommands: 1, writeCommands: 3, bytesRead: 128, bytesWritten: 512 },
      },
    },
  ]
}

describe("workspace cache-economics review", () => {
  beforeEach(() => {
    findMany.mockReset()
    findEvents
      .mockReset()
      .mockImplementation(async ({ where }: { where: { scanId: { in: string[] } } }) =>
        where.scanId.in.includes("private-scan-id") ? events() : []
      )
    findMyraMessages.mockReset().mockResolvedValue([])
    findReservations.mockReset().mockResolvedValue([])
  })

  it("uses RLS, explicit date filters and only the latest usage event", async () => {
    findMany.mockResolvedValue([completedScan()])

    const report = await reviewWorkspaceCacheEconomics({ workspaceId: "ws-private", from, to })

    expect(withWorkspaceRLS).toHaveBeenCalledWith("ws-private", expect.any(Function))
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "ws-private",
          deletedAt: null,
          createdAt: { gte: from, lt: to },
        },
        take: 501,
        select: { id: true, mode: true, status: true },
      })
    )
    expect(findEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          scanId: { in: ["private-scan-id"] },
          stage: { in: ["llm_usage", "ai_security_triage"] },
          deletedAt: null,
        },
        distinct: ["scanId", "stage"],
        select: { scanId: true, stage: true, metadata: true },
      })
    )
    expect(report.totals).toMatchObject({
      scans: 1,
      completedScans: 1,
      fullyAccountedScans: 1,
      requests: 2,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 100,
      outputTokens: 50,
      webSearchCostUsd: 0.001,
      cacheMetricsScans: 1,
      cacheReadCommands: 1,
      cacheWriteCommands: 3,
      cacheBytesRead: 128,
      cacheBytesWritten: 512,
    })
    expect(report.byMode.SAFE).toMatchObject({ scans: 1, fullyAccountedScans: 1 })
    expect(JSON.stringify(report)).not.toContain("private-scan-id")
    expect(JSON.stringify(report)).not.toContain("must not appear")
    expect(report.cacheOperationCostStatus).toBe("not_metered")
  })

  it("keeps missing usage and incomplete scans visible and declines misleading unit cost", async () => {
    findMany.mockResolvedValue([
      completedScan(),
      { id: "partial-scan-id", mode: "DEEP", status: "PARTIAL" },
    ])

    const report = await reviewWorkspaceCacheEconomics({ workspaceId: "ws-private", from, to })

    expect(report.totals).toMatchObject({
      scans: 2,
      completedScans: 1,
      incompleteScans: 1,
      missingUsageScans: 1,
      incompleteAccountingScans: 1,
      totalVariableCostUsd: null,
      costPerCompletedScanUsd: null,
    })
  })

  it("includes workspace-scoped Myra reservation costs without returning trace identifiers", async () => {
    findMany.mockResolvedValue([])
    findMyraMessages.mockResolvedValue([
      { traceId: "private-trace-settled" },
      { traceId: "private-trace-open" },
    ])
    findReservations.mockResolvedValue([
      {
        traceId: "private-trace-settled",
        status: "SETTLED",
        actualUsd: 0.001395,
        reservedUsd: 0.05,
      },
      { traceId: "private-trace-open", status: "RESERVED", actualUsd: null, reservedUsd: 0.05 },
    ])

    const report = await reviewWorkspaceCacheEconomics({ workspaceId: "ws-private", from, to })

    expect(findMyraMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { gte: from, lt: to },
          traceId: { not: null },
          conversation: { is: { workspaceId: "ws-private" } },
        },
      })
    )
    expect(findReservations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          traceId: { in: ["private-trace-settled", "private-trace-open"] },
          createdAt: { gte: from, lt: to },
        }),
      })
    )
    expect(report.myraGenerationCosts).toMatchObject({
      tracesIncluded: 2,
      reservations: 2,
      settledReservations: 1,
      openReservations: 1,
      settledCostUsd: 0.001395,
      openReservedUsd: 0.05,
      truncated: false,
    })
    expect(JSON.stringify(report)).not.toContain("private-trace")
  })

  it("caps samples and makes cost-per-completed unavailable when truncated", async () => {
    findMany.mockResolvedValue([completedScan(), completedScan()])

    const report = await reviewWorkspaceCacheEconomics({
      workspaceId: "ws-private",
      from,
      to,
      maxScans: 1,
    })

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }))
    expect(report.sample).toEqual({ scansIncluded: 1, maxScans: 1, truncated: true })
    expect(report.totals.costPerCompletedScanUsd).toBeNull()
    expect(report.byMode.SAFE.costPerCompletedScanUsd).toBeNull()
  })

  it("rejects invalid ranges and sample caps before querying", async () => {
    await expect(
      reviewWorkspaceCacheEconomics({ workspaceId: "ws-private", from: to, to: from })
    ).rejects.toThrow("to must be a valid date after from")
    await expect(
      reviewWorkspaceCacheEconomics({ workspaceId: "ws-private", from, to, maxScans: 501 })
    ).rejects.toThrow("maxScans must be an integer")
    expect(findMany).not.toHaveBeenCalled()
  })
})
