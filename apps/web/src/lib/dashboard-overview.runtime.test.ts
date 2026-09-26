import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "../../../../packages/db/src/generated/prisma"

const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const ownerUrl = process.env.DATABASE_SYSTEM_URL

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
    },
  }
})

import { createBoundedPgAdapter, prisma } from "@lyrashield/db"
import { getDashboardOverview } from "./dashboard-overview"

const owner = new PrismaClient({
  adapter: createBoundedPgAdapter(
    ownerUrl ?? "postgresql://test:test@127.0.0.1:5432/unused_test_database"
  ),
})
const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `dash-ws-${suffix}`
const foreignWorkspaceId = `dash-foreign-ws-${suffix}`
const prefix = `dash-${suffix}`
const targetA = `${prefix}-target-a`
const targetB = `${prefix}-target-b`
const targetC = `${prefix}-target-c`
const targetD = `${prefix}-target-d`
const deletedTarget = `${prefix}-target-deleted`
const foreignTarget = `${prefix}-target-foreign`
const createdWorkspaceIds: string[] = []

function scanRow(id: string, targetId: string, createdAt: Date) {
  return {
    id,
    workspaceId,
    targetId,
    goal: "LAUNCH_REVIEW" as const,
    mode: "SAFE" as const,
    status: "COMPLETED" as const,
    createdById: `${prefix}-actor`,
    createdAt,
    endedAt: new Date(createdAt.getTime() + 1_000),
  }
}

function scoreRow(
  scanId: string,
  targetId: string,
  score: number,
  grade: "A_PLUS" | "A" | "B",
  computedAt: Date,
  expiresAt: Date
) {
  return {
    id: `${prefix}-snapshot-${scanId}`,
    workspaceId,
    targetId,
    scanId,
    modelVersion: "dashboard-overview-runtime-test",
    score,
    grade,
    breakdown: {},
    scanMode: "SAFE" as const,
    computedAt,
    expiresAt,
  }
}

describe.skipIf(!runtimeUrl || !ownerUrl)(
  "dashboard overview per-target evidence against PostgreSQL RLS",
  () => {
    beforeAll(async () => {
      const [role] = await prisma.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })

      await owner.workspace.create({
        data: { id: workspaceId, name: "Dashboard fixture", slug: `${prefix}-workspace` },
      })
      createdWorkspaceIds.push(workspaceId)
      await owner.workspace.create({
        data: {
          id: foreignWorkspaceId,
          name: "Foreign dashboard fixture",
          slug: `${prefix}-foreign-workspace`,
        },
      })
      createdWorkspaceIds.push(foreignWorkspaceId)
      await owner.target.createMany({
        data: [
          { id: targetA, workspaceId, type: "REPO", name: "Busy target" },
          { id: targetB, workspaceId, type: "REPO", name: "Quiet target B" },
          { id: targetC, workspaceId, type: "REPO", name: "Quiet target C" },
          { id: targetD, workspaceId, type: "REPO", name: "Missing receipt target" },
          {
            id: deletedTarget,
            workspaceId,
            type: "REPO",
            name: "Deleted target",
            deletedAt: new Date(),
          },
        ],
      })
      await owner.target.create({
        data: {
          id: foreignTarget,
          workspaceId: foreignWorkspaceId,
          type: "REPO",
          name: "Foreign target",
        },
      })

      const base = Date.UTC(2026, 0, 1)
      const olderTargetScans = [
        scanRow(`${prefix}-a-usable`, targetA, new Date(base)),
        scanRow(`${prefix}-b-complete`, targetB, new Date(base + 10_000)),
        scanRow(`${prefix}-c-complete`, targetC, new Date(base + 20_000)),
        scanRow(`${prefix}-d-no-receipt`, targetD, new Date(base + 30_000)),
        scanRow(`${prefix}-deleted-scan`, deletedTarget, new Date(base - 10_000)),
      ]
      const busyTargetScans = Array.from({ length: 205 }, (_, index) =>
        scanRow(`${prefix}-a-busy-${index}`, targetA, new Date(base + 100_000 + index * 1_000))
      )
      const foreignScan = {
        ...scanRow(`${prefix}-foreign-scan`, foreignTarget, new Date(base + 900_000)),
        workspaceId: foreignWorkspaceId,
      }
      await owner.scan.createMany({ data: [...olderTargetScans, ...busyTargetScans, foreignScan] })

      await owner.scanCoverageReceipt.createMany({
        data: [
          {
            scanId: `${prefix}-a-usable`,
            scanner: "fixture",
            controlId: "fixture:usable",
            status: "COMPLETED",
          },
          {
            scanId: `${prefix}-b-complete`,
            scanner: "fixture",
            controlId: "fixture:usable",
            status: "COMPLETED",
          },
          {
            scanId: `${prefix}-c-complete`,
            scanner: "fixture",
            controlId: "fixture:usable",
            status: "COMPLETED",
          },
          {
            scanId: `${prefix}-deleted-scan`,
            scanner: "fixture",
            controlId: "fixture:usable",
            status: "COMPLETED",
          },
          ...busyTargetScans.map((scan) => ({
            scanId: scan.id,
            scanner: "fixture",
            controlId: "fixture:not-applicable",
            status: "NOT_APPLICABLE" as const,
          })),
          {
            scanId: foreignScan.id,
            scanner: "fixture",
            controlId: "fixture:usable",
            status: "COMPLETED" as const,
          },
        ],
      })

      await owner.scoreSnapshot.createMany({
        data: [
          scoreRow(
            `${prefix}-b-complete`,
            targetB,
            80,
            "B",
            new Date(base + 300_000),
            new Date(Date.UTC(2030, 0, 1))
          ),
          scoreRow(
            `${prefix}-c-complete`,
            targetC,
            90,
            "A",
            new Date(base + 310_000),
            new Date(Date.UTC(2020, 0, 1))
          ),
          ...busyTargetScans
            .slice(-25)
            .map((scan, index) =>
              scoreRow(
                scan.id,
                targetA,
                100,
                "A_PLUS",
                new Date(base + 500_000 + index * 1_000),
                new Date(Date.UTC(2030, 0, 1))
              )
            ),
          {
            ...scoreRow(
              foreignScan.id,
              foreignTarget,
              99,
              "A_PLUS",
              new Date(base + 910_000),
              new Date(Date.UTC(2030, 0, 1))
            ),
            workspaceId: foreignWorkspaceId,
          },
        ],
      })
    }, 30_000)

    afterAll(async () => {
      for (const id of createdWorkspaceIds) {
        await owner.workspace.deleteMany({ where: { id } }).catch(() => {})
      }
      await owner.$disconnect()
      await prisma.$disconnect()
    })

    it("keeps quiet targets and their usable snapshots outside the global top-200/top-20 windows", async () => {
      const overview = await getDashboardOverview(workspaceId)

      expect(overview.targets).toEqual({
        total: 4,
        assessed: 3,
        partiallyAssessed: 0,
        unassessed: 1,
        expiredAssessments: 1,
      })
      expect(overview.latestRun?.id).toBe(`${prefix}-a-busy-204`)
      expect(overview.latestRun?.coverageState).toBe("NONE")
      expect(overview.lastEvaluatedAssessment).toMatchObject({
        scanId: `${prefix}-c-complete`,
        targetId: targetC,
        score: 90,
      })
      expect(overview.scoreHistory.map((snapshot) => snapshot.scanId)).toEqual(
        expect.arrayContaining([`${prefix}-b-complete`, `${prefix}-c-complete`])
      )
      expect(overview.scoreHistory).toHaveLength(2)
      expect(overview.scoreHistory.map((snapshot) => snapshot.scanId)).not.toContain(
        `${prefix}-foreign-scan`
      )
    })
  }
)
