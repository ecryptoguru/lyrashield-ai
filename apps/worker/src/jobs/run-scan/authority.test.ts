import { beforeEach, describe, expect, it, vi } from "vitest"

const systemScanFindUnique = vi.hoisted(() => vi.fn())
const updateScanStatusMock = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/db", async () => {
  // Keep the real stored-plan verifier (hash + contract) — mock only Prisma.
  const planModule = await vi.importActual<typeof import("@lyrashield/db/src/scan-execution-plan")>(
    "@lyrashield/db/src/scan-execution-plan"
  )
  return {
    getSystemPrisma: () => ({ scan: { findUnique: systemScanFindUnique } }),
    updateScanStatus: updateScanStatusMock,
    verifyStoredScanExecutionPlan: planModule.verifyStoredScanExecutionPlan,
  }
})

vi.mock("@lyrashield/security", () => ({
  containsPromptInjection: vi.fn(() => false),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

import { buildScanExecutionPlan } from "@lyrashield/types"
import { computeScanExecutionPlanHash } from "@lyrashield/db/src/scan-execution-plan"
import { verifyScanJobAuthority } from "./authority"

function makeJob(overrides: { id?: string; data?: Record<string, unknown> } = {}) {
  return {
    id: "scan-1",
    data: {
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "SAFE",
      ...overrides.data,
    },
    ...("id" in overrides ? { id: overrides.id } : {}),
  } as never
}

function storedScan(overrides: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "TEST_APP",
    mode: "SAFE",
    policyId: null,
    determinismMode: null,
    startedAt: null,
    createdById: "user-1",
    sponsorAccountId: null,
    triggerType: "manual",
    executionPlan: null,
    executionPlanHash: null,
    ...overrides,
  }
}

function storedPlanFor(mode: string, targetType: "REPO" | "WEB_APP" | "API" = "REPO") {
  const plan = buildScanExecutionPlan({ targetType, mode })
  return { plan, hash: computeScanExecutionPlanHash(plan) }
}

describe("verifyScanJobAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateScanStatusMock.mockResolvedValue({ id: "scan-1" })
  })

  it("rejects a queue spoof where the BullMQ job id differs from the scan id", async () => {
    systemScanFindUnique.mockResolvedValue(storedScan())
    const result = await verifyScanJobAuthority(makeJob({ id: "forged-job-id" }))
    expect(result).toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "INVALID_JOB",
        errorMessage: "Scan job ID does not match the scan ID",
      },
    })
  })

  it("rejects a payload that does not match the stored scan record", async () => {
    systemScanFindUnique.mockResolvedValue(storedScan())
    const result = await verifyScanJobAuthority(makeJob({ data: { goal: "DIFFERENT_GOAL" } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.result.errorCategory).toBe("INVALID_JOB")
  })

  it("reads the stored plan through the privileged scan row", async () => {
    systemScanFindUnique.mockResolvedValue(storedScan())
    await verifyScanJobAuthority(makeJob())
    expect(systemScanFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          executionPlan: true,
          executionPlanHash: true,
        }),
      })
    )
  })

  it("drains a legacy row with a null plan unchanged", async () => {
    systemScanFindUnique.mockResolvedValue(storedScan())
    const result = await verifyScanJobAuthority(makeJob())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.executionPlan).toBeNull()
  })

  it("accepts a stored plan whose hash verifies", async () => {
    const { plan, hash } = storedPlanFor("QUICK")
    systemScanFindUnique.mockResolvedValue(
      storedScan({ mode: "QUICK", executionPlan: plan, executionPlanHash: hash })
    )
    const result = await verifyScanJobAuthority(makeJob({ data: { mode: "QUICK" } }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.executionPlan).toEqual(plan)
  })

  it("fails closed on a plan hash mismatch and marks the scan FAILED", async () => {
    const { plan } = storedPlanFor("QUICK")
    const tampered = { ...plan, capabilities: [...plan.capabilities, "extra_cap"] }
    systemScanFindUnique.mockResolvedValue(
      storedScan({
        mode: "QUICK",
        executionPlan: tampered,
        executionPlanHash: computeScanExecutionPlanHash(plan),
      })
    )
    const result = await verifyScanJobAuthority(makeJob({ data: { mode: "QUICK" } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.result.errorCategory).toBe("SCAN_PLAN_HASH_MISMATCH")
    expect(updateScanStatusMock).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "SCAN_PLAN_HASH_MISMATCH" }),
      "ws-1"
    )
  })

  it("fails closed on an unsupported plan version", async () => {
    const { plan } = storedPlanFor("QUICK")
    systemScanFindUnique.mockResolvedValue(
      storedScan({
        mode: "QUICK",
        executionPlan: { ...plan, version: "lyrashield-scan-plan/2.0.0" },
        executionPlanHash: "a".repeat(64),
      })
    )
    const result = await verifyScanJobAuthority(makeJob({ data: { mode: "QUICK" } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.result.errorCategory).toBe("SCAN_PLAN_VERSION_UNSUPPORTED")
  })

  it("fails closed on an inconsistent scope/workflow contract", async () => {
    systemScanFindUnique.mockResolvedValue(
      storedScan({
        mode: "QUICK",
        executionPlan: {
          version: "lyrashield-scan-plan/1.0.0",
          workflow: "REVIEW_CHANGES",
          targetType: "REPO",
          depth: "QUICK",
          profileId: "REPO_QUICK",
          scope: "SNAPSHOT",
          limits: {
            maxDurationMs: 900_000,
            maxEngineMs: 720_000,
            scannerReserveMs: 180_000,
            maxBudgetUsd: 1.2,
          },
          capabilities: [],
          attachmentIds: [],
        },
        executionPlanHash: "a".repeat(64),
      })
    )
    const result = await verifyScanJobAuthority(makeJob({ data: { mode: "QUICK" } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.result.errorCategory).toBe("SCAN_PLAN_INVALID")
  })

  it("fails closed when the plan is stored without its hash", async () => {
    const { plan } = storedPlanFor("QUICK")
    systemScanFindUnique.mockResolvedValue(
      storedScan({ mode: "QUICK", executionPlan: plan, executionPlanHash: null })
    )
    const result = await verifyScanJobAuthority(makeJob({ data: { mode: "QUICK" } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.result.errorCategory).toBe("SCAN_PLAN_INTEGRITY")
  })

  it("fails closed when the recorded plan depth disagrees with the stored mode", async () => {
    const { plan, hash } = storedPlanFor("QUICK")
    systemScanFindUnique.mockResolvedValue(
      storedScan({ mode: "STANDARD", executionPlan: plan, executionPlanHash: hash })
    )
    const result = await verifyScanJobAuthority(makeJob({ data: { mode: "STANDARD" } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.result.errorCategory).toBe("SCAN_PLAN_MISMATCH")
  })
})
