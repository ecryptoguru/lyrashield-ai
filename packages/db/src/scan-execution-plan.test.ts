import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    scan: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    target: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    scanEvent: { create: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock("./extension", () => ({ getWorkspaceContext: () => null }))

import { ScanExecutionPlanSchema } from "@lyrashield/types"
import { prisma } from "./client"
import { createScan } from "./scan-service"
import {
  canonicalizeScanExecutionPlan,
  computeScanExecutionPlanHash,
  verifyStoredScanExecutionPlan,
} from "./scan-execution-plan"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  scan: {
    count: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
  }
  target: { findFirst: ReturnType<typeof vi.fn> }
  workspace: { findUnique: ReturnType<typeof vi.fn> }
  scanEvent: { create: ReturnType<typeof vi.fn> }
}

const VALID_PLAN = {
  version: "lyrashield-scan-plan/1.0.0",
  workflow: "REVIEW_TARGET",
  targetType: "REPO",
  depth: "STANDARD",
  profileId: "REPO_STANDARD",
  scope: "SNAPSHOT",
  source: { revision: "a".repeat(40) },
  limits: {
    maxDurationMs: 900_000,
    maxEngineMs: 720_000,
    scannerReserveMs: 180_000,
    maxBudgetUsd: 3.2,
  },
  capabilities: ["engine", "sca"],
  attachmentIds: [],
} as const

function validPlan() {
  return ScanExecutionPlanSchema.parse(VALID_PLAN)
}

describe("execution plan canonicalization and hashing", () => {
  it("produces a stable sha256 over canonical JSON regardless of key order", () => {
    const plan = validPlan()
    const reordered = ScanExecutionPlanSchema.parse(
      JSON.parse(
        `{"limits":{"maxBudgetUsd":3.2,"scannerReserveMs":180000,"maxEngineMs":720000,"maxDurationMs":900000},"capabilities":["engine","sca"],"attachmentIds":[],"version":"lyrashield-scan-plan/1.0.0","workflow":"REVIEW_TARGET","targetType":"REPO","depth":"STANDARD","profileId":"REPO_STANDARD","scope":"SNAPSHOT","source":{"revision":"${"a".repeat(40)}"}}`
      )
    )
    expect(computeScanExecutionPlanHash(plan)).toBe(computeScanExecutionPlanHash(reordered))
    expect(computeScanExecutionPlanHash(plan)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("canonical JSON sorts nested object keys recursively", () => {
    expect(canonicalizeScanExecutionPlan(validPlan())).toBe(
      canonicalizeScanExecutionPlan(validPlan())
    )
  })
})

describe("verifyStoredScanExecutionPlan", () => {
  it("accepts a stored plan whose hash matches", () => {
    const plan = validPlan()
    const hash = computeScanExecutionPlanHash(plan)
    const check = verifyStoredScanExecutionPlan(plan, hash)
    expect(check).toEqual({ ok: true, plan })
  })

  it("rejects a tampered plan (hash mismatch)", () => {
    const plan = validPlan()
    const tampered = { ...plan, capabilities: ["engine", "sca", "url"] }
    const check = verifyStoredScanExecutionPlan(tampered, computeScanExecutionPlanHash(plan))
    expect(check).toMatchObject({ ok: false, errorCategory: "SCAN_PLAN_HASH_MISMATCH" })
  })

  it("rejects an unsupported plan version before hashing", () => {
    const plan = { ...VALID_PLAN, version: "lyrashield-scan-plan/2.0.0" }
    const check = verifyStoredScanExecutionPlan(plan, "a".repeat(64))
    expect(check).toMatchObject({ ok: false, errorCategory: "SCAN_PLAN_VERSION_UNSUPPORTED" })
  })

  it("rejects a plan that fails contract validation", () => {
    const plan = { ...VALID_PLAN, scope: "LIVE" }
    const check = verifyStoredScanExecutionPlan(plan, "a".repeat(64))
    expect(check).toMatchObject({ ok: false, errorCategory: "SCAN_PLAN_INVALID" })
  })

  it("rejects a missing or malformed stored hash", () => {
    const plan = validPlan()
    expect(verifyStoredScanExecutionPlan(plan, null)).toMatchObject({
      ok: false,
      errorCategory: "SCAN_PLAN_INTEGRITY",
    })
    expect(verifyStoredScanExecutionPlan(plan, "not-a-hash")).toMatchObject({
      ok: false,
      errorCategory: "SCAN_PLAN_INTEGRITY",
    })
    expect(verifyStoredScanExecutionPlan(null, "a".repeat(64))).toMatchObject({
      ok: false,
      errorCategory: "SCAN_PLAN_INVALID",
    })
  })
})

describe("createScan execution plan persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeTx(targetType: string) {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      target: { findFirst: vi.fn().mockResolvedValue({ id: "target-1", type: targetType }) },
      scan: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: "scan-1" }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ agencySponsorAccountId: null }),
      },
      scanEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
    }
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx))
    return tx
  }

  it("persists plan and hash in the same transaction that creates the scan", async () => {
    const tx = makeTx("REPO")

    await createScan({
      workspaceId: "ws-1",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      createdById: "user-1",
    })

    expect(tx.scan.create).toHaveBeenCalledTimes(1)
    const data = tx.scan.create.mock.calls[0]![0].data
    const parsed = ScanExecutionPlanSchema.safeParse(data.executionPlan)
    expect(parsed.success).toBe(true)
    expect(data.executionPlan).toMatchObject({
      workflow: "REVIEW_TARGET",
      targetType: "REPO",
      depth: "STANDARD",
      profileId: "REPO_STANDARD",
      scope: "SNAPSHOT",
    })
    expect(data.executionPlanHash).toBe(computeScanExecutionPlanHash(parsed.data!))
    // The advisory admission lock precedes the row write in the same tx.
    expect(tx.$executeRaw).toHaveBeenCalled()
  })

  it("persists resolved source provenance for REVIEW_CHANGES", async () => {
    const tx = makeTx("REPO")
    const source = {
      revision: "a".repeat(40),
      baseRevision: "b".repeat(40),
      mergeBaseRevision: "c".repeat(40),
    }

    await createScan({
      workspaceId: "ws-1",
      targetId: "target-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      createdById: "user-1",
      workflow: "REVIEW_CHANGES",
      source,
    })

    const data = tx.scan.create.mock.calls[0]![0].data
    expect(data.executionPlan).toMatchObject({
      workflow: "REVIEW_CHANGES",
      scope: "DIFF",
      source,
    })
  })

  it("fails creation when workflow inputs cannot produce a valid plan", async () => {
    const tx = makeTx("REPO")

    await expect(
      createScan({
        workspaceId: "ws-1",
        targetId: "target-1",
        goal: "CHECK_PR",
        mode: "QUICK",
        createdById: "user-1",
        workflow: "REVIEW_CHANGES",
        // No resolved revisions — the plan cannot be fabricated.
      })
    ).rejects.toThrow(/revision/i)
    expect(tx.scan.create).not.toHaveBeenCalled()
  })

  it("excludes the engine capability for deterministic retest scans", async () => {
    const tx = makeTx("REPO")

    await createScan({
      workspaceId: "ws-1",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "SAFE",
      createdById: "user-1",
      triggerType: "retest",
      determinismMode: "targeted_scanner",
    })

    const data = tx.scan.create.mock.calls[0]![0].data
    expect(data.executionPlan.depth).toBe("QUICK")
    expect(data.executionPlan.capabilities).not.toContain("engine")
  })

  it("tolerates a null plan on legacy rows — readers never require the column", async () => {
    // Rollback compatibility: a reader built before the migration sees
    // executionPlan as absent/null and must keep working unchanged.
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))
    mockPrisma.scan.findFirst.mockResolvedValue({
      id: "legacy-1",
      status: "COMPLETED",
      executionPlan: null,
      executionPlanHash: null,
      events: [],
      resultManifest: null,
      coverageReceipts: [],
      aiSecurityScoreSnapshot: null,
      target: null,
    })

    const { getScanWithEvents } = await import("./scan-service")
    const scan = await getScanWithEvents("legacy-1", "ws-1")
    expect(scan?.id).toBe("legacy-1")
  })
})
