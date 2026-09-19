import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prisma: {
    target: { findFirst: vi.fn() },
  },
  updateScanStatus: vi.fn(),
  runPreflight: vi.fn(),
  checkInstructionSafety: vi.fn(),
  assertEvidenceStorageConfigured: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: mocks.prisma,
  updateScanStatus: mocks.updateScanStatus,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("@lyrashield/security", () => ({
  checkInstructionSafety: mocks.checkInstructionSafety,
}))
vi.mock("../preflight.job", () => ({
  runPreflight: mocks.runPreflight,
}))
vi.mock("../../engine/evidence-storage", () => ({
  assertEvidenceStorageConfigured: mocks.assertEvidenceStorageConfigured,
}))

import { buildScanExecutionPlan, type ScanExecutionPlan } from "@lyrashield/types"
import { prepareScanExecution } from "./preparation"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const MERGE_BASE = "c".repeat(40)

const repoTarget = {
  id: "target-1",
  type: "REPO",
  name: "app",
  url: null,
  repoFullName: "acme/app",
  branch: "main",
  apiSpecUrl: null,
  environment: null,
  installationId: "1234",
  repoProvider: "github",
}

const diffPlan = () =>
  buildScanExecutionPlan({
    workflow: "REVIEW_CHANGES",
    targetType: "REPO",
    mode: "STANDARD",
    source: { revision: HEAD, baseRevision: BASE, mergeBaseRevision: MERGE_BASE },
  })

function params(over: Partial<Parameters<typeof prepareScanExecution>[0]> = {}) {
  return {
    scanId: "scan-1",
    targetId: "target-1",
    goal: "CHECK_PR",
    mode: "STANDARD",
    ...over,
  } as Parameters<typeof prepareScanExecution>[0]
}

describe("prepareScanExecution Review Changes guard", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.runPreflight.mockResolvedValue({ passed: true, checks: [] })
    mocks.prisma.target.findFirst.mockResolvedValue(repoTarget)
    mocks.checkInstructionSafety.mockReturnValue({ safe: true, detectedPatterns: [] })
    mocks.assertEvidenceStorageConfigured.mockReturnValue(undefined)
    mocks.updateScanStatus.mockResolvedValue({ id: "scan-1" })
  })

  it("admits a DIFF-scope plan carrying all three resolved revisions", async () => {
    const result = await prepareScanExecution(params({ executionPlan: diffPlan() }))

    expect(result).toMatchObject({ ok: true })
    expect(mocks.updateScanStatus).not.toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.anything()
    )
  })

  it("fails with a named preflight category when the plan lacks the merge base", async () => {
    // Schema validation normally rejects this; the worker boundary still
    // fails closed rather than scanning a different change set than the plan
    // recorded.
    const malformed = {
      ...diffPlan(),
      source: { revision: HEAD, baseRevision: BASE },
    } as ScanExecutionPlan

    const result = await prepareScanExecution(params({ executionPlan: malformed }))

    expect(result).toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "SCAN_PLAN_INVALID",
        errorMessage: expect.stringContaining("immutable source revisions"),
      },
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "SCAN_PLAN_INVALID",
      errorMessage: expect.any(String),
    })
  })

  it("fails closed when a DIFF-scope plan lands on a non-repository target", async () => {
    mocks.prisma.target.findFirst.mockResolvedValue({
      ...repoTarget,
      type: "WEB_APP",
      url: "https://app.example.com",
    })

    const result = await prepareScanExecution(params({ executionPlan: diffPlan() }))

    expect(result).toMatchObject({
      ok: false,
      result: { errorCategory: "SCAN_PLAN_INVALID" },
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "SCAN_PLAN_INVALID" })
    )
  })

  it("keeps legacy null-plan rows on their original path", async () => {
    const result = await prepareScanExecution(params({ executionPlan: null }))

    expect(result).toMatchObject({ ok: true })
  })
})
