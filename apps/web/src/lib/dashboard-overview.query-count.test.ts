import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  calls: [] as string[],
  targets: [] as { id: string; name: string }[],
  evidence: [] as {
    targetId: string
    latestTerminalScanId: string | null
    latestUsableScanId: string | null
    latestEvaluatedSnapshotId: string | null
  }[],
  scanRows: [] as {
    id: string
    targetId: string
    status: string
    mode: string
    createdAt: Date
    endedAt: Date
    summary: null
    errorCategory: null
    errorMessage: null
    target: { id: string; name: string }
    _count: { findings: number }
  }[],
}))

vi.mock("@lyrashield/db", () => {
  const record = (name: string, result: () => unknown) => async () => {
    state.calls.push(name)
    return result()
  }

  return {
    Prisma: {
      join: (parts: unknown[]) => parts,
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    },
    prisma: {
      target: { findMany: record("target.findMany", () => state.targets) },
      scan: {
        findMany: async (args: unknown) => {
          state.calls.push("scan.findMany")
          const query = args as { where?: { id?: { in?: unknown[] } } }
          return query.where?.id?.in ? state.scanRows : []
        },
        count: record("scan.count", () => 0),
        findFirst: record("scan.findFirst", () => null),
      },
      finding: { groupBy: record("finding.groupBy", () => []) },
      scoreSnapshot: { findMany: record("scoreSnapshot.findMany", () => []) },
      report: { count: record("report.count", () => 0) },
      project: { findFirst: record("project.findFirst", () => null) },
    },
    withWorkspaceRLS: async (
      _workspaceId: string,
      callback: (tx: {
        $queryRaw: (...args: unknown[]) => Promise<unknown>
        scanCoverageReceipt: { findMany: (...args: unknown[]) => Promise<unknown> }
      }) => Promise<unknown>
    ) => {
      state.calls.push("withWorkspaceRLS")
      return callback({
        $queryRaw: async () => {
          state.calls.push("$queryRaw")
          return state.evidence
        },
        scanCoverageReceipt: {
          findMany: async () => {
            state.calls.push("scanCoverageReceipt.findMany")
            return state.scanRows.map((scan) => ({
              scanId: scan.id,
              status: "COMPLETED",
              controlId: "unit-test",
            }))
          },
        },
      })
    },
  }
})

import { getDashboardOverview } from "./dashboard-overview"

function populateScenario(targetCount: number) {
  state.calls.length = 0
  state.targets = Array.from({ length: targetCount }, (_, index) => ({
    id: `target-${index}`,
    name: `Target ${index}`,
  }))
  state.evidence = state.targets.map((target) => ({
    targetId: target.id,
    latestTerminalScanId: `scan-${target.id}`,
    latestUsableScanId: `scan-${target.id}`,
    latestEvaluatedSnapshotId: null,
  }))
  state.scanRows = state.targets.map((target) => ({
    id: `scan-${target.id}`,
    targetId: target.id,
    status: "COMPLETED",
    mode: "SAFE",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    endedAt: new Date("2026-08-01T10:10:00Z"),
    summary: null,
    errorCategory: null,
    errorMessage: null,
    target,
    _count: { findings: 0 },
  }))
}

describe("dashboard overview read count", () => {
  beforeEach(() => populateScenario(1))

  it("keeps database read operations bounded as active target count grows", async () => {
    await getDashboardOverview("workspace-test")
    const oneTargetCalls = [...state.calls]

    populateScenario(250)
    await getDashboardOverview("workspace-test")
    const manyTargetCalls = [...state.calls]

    expect(manyTargetCalls).toEqual(oneTargetCalls)
    expect(manyTargetCalls.filter((call) => call === "$queryRaw")).toHaveLength(1)
    expect(manyTargetCalls.filter((call) => call === "scan.findMany")).toHaveLength(2)
  })
})
