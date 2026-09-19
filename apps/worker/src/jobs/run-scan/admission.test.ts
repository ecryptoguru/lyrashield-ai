import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prisma: {
    workspaceMember: { findFirst: vi.fn() },
  },
  hasPermission: vi.fn(),
  evaluateScanEntitlement: vi.fn(),
  runWithAccountContext: vi.fn(),
  updateScanStatus: vi.fn(),
  refreshGate: vi.fn(),
  resolveAuthenticatedAssessmentAuthorization: vi.fn(),
}))

vi.mock("@lyrashield/auth/permissions", () => ({
  hasPermission: mocks.hasPermission,
  PERMISSIONS: {
    scan: { create: "scan:create" },
    schedule: { create: "schedule:create" },
    retest: { create: "retest:create" },
  },
}))
vi.mock("@lyrashield/billing", () => ({
  evaluateScanEntitlement: mocks.evaluateScanEntitlement,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: mocks.prisma,
  runWithAccountContext: mocks.runWithAccountContext,
  updateScanStatus: mocks.updateScanStatus,
  resolveAuthenticatedAssessmentAuthorization: mocks.resolveAuthenticatedAssessmentAuthorization,
  LiveAiSafetyError: class LiveAiSafetyError extends Error {
    readonly code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
}))
vi.mock("./lifecycle-utils", () => ({
  refreshGateVerdictAfterTerminalScan: mocks.refreshGate,
}))

import { buildScanExecutionPlan } from "@lyrashield/types"
import { verifyScanAdmission } from "./admission"

const scanRecord = {
  id: "scan-1",
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "goal",
  mode: "DEEP",
  policyId: null,
  determinismMode: null,
  startedAt: null,
  createdById: "user-1",
  sponsorAccountId: "sponsor-1",
  triggerType: "manual",
} as never

function params(over: Partial<Parameters<typeof verifyScanAdmission>[0]> = {}) {
  return {
    scanId: "scan-1",
    workspaceId: "ws-1",
    targetId: "target-1",
    mode: "DEEP",
    engineBacked: true,
    deterministicRetest: false,
    scanRecord,
    ...over,
  } as Parameters<typeof verifyScanAdmission>[0]
}

describe("verifyScanAdmission", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.prisma.workspaceMember.findFirst.mockResolvedValue({ role: "OWNER" })
    mocks.hasPermission.mockReturnValue(true)
    mocks.runWithAccountContext.mockImplementation(async (_id: string, fn: () => unknown) => fn())
    mocks.evaluateScanEntitlement.mockResolvedValue({ allowed: true, accountId: "sponsor-1" })
    mocks.updateScanStatus.mockResolvedValue({ id: "scan-1" })
    mocks.refreshGate.mockResolvedValue(undefined)
  })

  it("fails the scan when the creator's membership was revoked", async () => {
    mocks.prisma.workspaceMember.findFirst.mockResolvedValue(null)

    await expect(verifyScanAdmission(params())).resolves.toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "SCAN_AUTHORIZATION_REVOKED",
        errorMessage: expect.stringContaining("no longer has permission"),
      },
    })

    expect(mocks.updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "SCAN_AUTHORIZATION_REVOKED",
      errorMessage: expect.any(String),
    })
    expect(mocks.refreshGate).toHaveBeenCalledWith("ws-1", "target-1", "scan-1")
    expect(mocks.evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("fails when the creator's role no longer carries the execution permission", async () => {
    mocks.hasPermission.mockReturnValue(false)

    const outcome = await verifyScanAdmission(params())

    expect(outcome).toMatchObject({
      ok: false,
      result: { errorCategory: "SCAN_AUTHORIZATION_REVOKED" },
    })
    expect(mocks.hasPermission).toHaveBeenCalledWith("OWNER", "scan:create")
  })

  it("uses the schedule permission for scheduled scans", async () => {
    mocks.hasPermission.mockReturnValue(false)
    const scheduled = {
      ...scanRecord,
      triggerType: "schedule",
    } as never

    await verifyScanAdmission(params({ scanRecord: scheduled }))

    expect(mocks.hasPermission).toHaveBeenCalledWith("OWNER", "schedule:create")
  })

  it("fails when workspace billing sponsorship changed since queueing", async () => {
    mocks.evaluateScanEntitlement.mockResolvedValue({
      allowed: true,
      accountId: "sponsor-2",
    })

    await expect(verifyScanAdmission(params())).resolves.toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "SCAN_SPONSOR_CHANGED",
        errorMessage: expect.stringContaining("sponsorship changed"),
      },
    })

    expect(mocks.runWithAccountContext).toHaveBeenCalledWith("user-1", expect.any(Function))
    expect(mocks.evaluateScanEntitlement).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      mode: "DEEP",
      sponsorAccountId: "user-1",
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "SCAN_SPONSOR_CHANGED" })
    )
  })

  it("falls back to the creator when no sponsor was recorded", async () => {
    const unsponsored = { ...scanRecord, sponsorAccountId: null } as never
    mocks.evaluateScanEntitlement.mockResolvedValue({
      allowed: true,
      accountId: "someone-else",
    })

    const outcome = await verifyScanAdmission(params({ scanRecord: unsponsored }))

    // sponsorAccountId ?? createdById — a different entitled payer still denies.
    expect(outcome).toMatchObject({
      ok: false,
      result: { errorCategory: "SCAN_SPONSOR_CHANGED" },
    })
  })

  it("passes the entitlement denial code through when the sponsor cannot pay", async () => {
    mocks.evaluateScanEntitlement.mockResolvedValue({
      allowed: false,
      code: "SCAN_MINUTES_EXHAUSTED",
      message: "minutes exhausted",
    })

    await expect(verifyScanAdmission(params())).resolves.toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "SCAN_MINUTES_EXHAUSTED",
        errorMessage: "minutes exhausted",
      },
    })
  })

  it("admits the scan when creator and sponsor are unchanged", async () => {
    await expect(verifyScanAdmission(params())).resolves.toEqual({ ok: true })
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
    expect(mocks.refreshGate).not.toHaveBeenCalled()
  })

  it("skips the entitlement check for deterministic retests", async () => {
    await expect(verifyScanAdmission(params({ deterministicRetest: true }))).resolves.toEqual({
      ok: true,
    })
    expect(mocks.evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  describe("execution-plan admission", () => {
    const repoDeepPlan = () => buildScanExecutionPlan({ targetType: "REPO", mode: "DEEP" })

    it("admits mixed rows during drain: legacy null-plan and stored-plan scans", async () => {
      // Flag OFF (default) — a pre-plan row runs its original path.
      await expect(
        verifyScanAdmission(params({ planRequired: false }))
      ).resolves.toEqual({ ok: true })
      // A new plan-bearing row validates and admits in the same drain window.
      await expect(
        verifyScanAdmission(
          params({ executionPlan: repoDeepPlan(), targetType: "REPO", planRequired: false })
        )
      ).resolves.toEqual({ ok: true })
    })

    it("denies a legacy null-plan scan when plan admission is required", async () => {
      await expect(
        verifyScanAdmission(params({ planRequired: true }))
      ).resolves.toEqual({
        ok: false,
        result: {
          status: "failed",
          errorCategory: "SCAN_PLAN_REQUIRED",
          errorMessage: expect.stringContaining("execution plan"),
        },
      })
      expect(mocks.updateScanStatus).toHaveBeenCalledWith(
        "scan-1",
        "FAILED",
        expect.objectContaining({ errorCategory: "SCAN_PLAN_REQUIRED" })
      )
      expect(mocks.evaluateScanEntitlement).not.toHaveBeenCalled()
    })

    it("admits a stored plan that matches the current admission policy", async () => {
      await expect(
        verifyScanAdmission(
          params({ executionPlan: repoDeepPlan(), targetType: "REPO", planRequired: true })
        )
      ).resolves.toEqual({ ok: true })
    })

    it("denies when the plan target type differs from the stored target", async () => {
      await expect(
        verifyScanAdmission(
          params({ executionPlan: repoDeepPlan(), targetType: "WEB_APP" })
        )
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_PLAN_MISMATCH" },
      })
    })

    it("denies when the recorded profile does not match the stored mode", async () => {
      const quickPlan = buildScanExecutionPlan({ targetType: "REPO", mode: "QUICK" })
      await expect(
        verifyScanAdmission(
          params({ executionPlan: quickPlan, targetType: "REPO" })
        )
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_PLAN_MISMATCH" },
      })
    })

    it("denies when the plan engine capability no longer matches the scan", async () => {
      // Recorded plan claims engine, but this is a deterministic retest.
      await expect(
        verifyScanAdmission(
          params({
            executionPlan: repoDeepPlan(),
            targetType: "REPO",
            deterministicRetest: true,
          })
        )
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_PLAN_MISMATCH" },
      })
      // ...and the inverse: a plan without engine for an engine-backed scan.
      const noEngine = { ...repoDeepPlan(), capabilities: ["sca", "secrets"] }
      await expect(
        verifyScanAdmission(params({ executionPlan: noEngine, targetType: "REPO" }))
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_PLAN_MISMATCH" },
      })
    })

    it("denies when the recorded plan exceeds the limits the profile now allows", async () => {
      const inflated = {
        ...repoDeepPlan(),
        limits: { ...repoDeepPlan().limits, maxBudgetUsd: 99 },
      }
      await expect(
        verifyScanAdmission(params({ executionPlan: inflated, targetType: "REPO" }))
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_PLAN_LIMITS_EXCEEDED" },
      })
    })

    it("denies AUTHENTICATED_ASSESSMENT when the current policy allows destructive tests", async () => {
      const betaPlan = buildScanExecutionPlan({
        workflow: "AUTHENTICATED_ASSESSMENT",
        targetType: "API",
        mode: "DEEP",
        authorizationRef: "authz_1",
      })
      await expect(
        verifyScanAdmission(
          params({
            executionPlan: betaPlan,
            targetType: "API",
            destructiveTestsAllowed: true,
            authAssessmentPermitted: true,
          })
        )
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_PLAN_DENIED" },
      })
      // The same plan admits under a non-destructive policy.
      await expect(
        verifyScanAdmission(
          params({
            executionPlan: betaPlan,
            targetType: "API",
            destructiveTestsAllowed: false,
            authAssessmentPermitted: true,
          })
        )
      ).resolves.toEqual({ ok: true })
    })

    it("denies AUTHENTICATED_ASSESSMENT when the beta gate is off at execution time", async () => {
      const betaPlan = buildScanExecutionPlan({
        workflow: "AUTHENTICATED_ASSESSMENT",
        targetType: "API",
        mode: "DEEP",
        authorizationRef: "authz_1",
      })
      // authAssessmentPermitted defaults to false — flag off or workspace
      // dropped from the allowlist between queue and run fails closed.
      await expect(
        verifyScanAdmission(
          params({ executionPlan: betaPlan, targetType: "API" })
        )
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_WORKFLOW_UNAVAILABLE" },
      })
      expect(mocks.resolveAuthenticatedAssessmentAuthorization).not.toHaveBeenCalled()
      expect(mocks.evaluateScanEntitlement).not.toHaveBeenCalled()
      expect(mocks.updateScanStatus).toHaveBeenCalledWith(
        "scan-1",
        "FAILED",
        expect.objectContaining({ errorCategory: "SCAN_WORKFLOW_UNAVAILABLE" })
      )
    })

    it("fails AUTHENTICATED_ASSESSMENT when the recorded authorization was revoked mid-run", async () => {
      const betaPlan = buildScanExecutionPlan({
        workflow: "AUTHENTICATED_ASSESSMENT",
        targetType: "API",
        mode: "DEEP",
        authorizationRef: "authz_1",
      })
      const { LiveAiSafetyError } = await import("@lyrashield/db")
      mocks.resolveAuthenticatedAssessmentAuthorization.mockRejectedValue(
        new LiveAiSafetyError("AUTH_ASSESSMENT_AUTH_NOT_READY")
      )
      await expect(
        verifyScanAdmission(
          params({
            executionPlan: betaPlan,
            targetType: "API",
            authAssessmentPermitted: true,
          })
        )
      ).resolves.toMatchObject({
        ok: false,
        result: { errorCategory: "SCAN_AUTHORIZATION_REVOKED" },
      })
      expect(mocks.resolveAuthenticatedAssessmentAuthorization).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        targetId: "target-1",
        authorizationRef: "authz_1",
      })
      expect(mocks.updateScanStatus).toHaveBeenCalledWith(
        "scan-1",
        "FAILED",
        expect.objectContaining({ errorCategory: "SCAN_AUTHORIZATION_REVOKED" })
      )
      expect(mocks.evaluateScanEntitlement).not.toHaveBeenCalled()
    })

    it("re-verifies the recorded authorization before admitting the beta", async () => {
      const betaPlan = buildScanExecutionPlan({
        workflow: "AUTHENTICATED_ASSESSMENT",
        targetType: "API",
        mode: "DEEP",
        authorizationRef: "authz_1",
      })
      mocks.resolveAuthenticatedAssessmentAuthorization.mockResolvedValue({
        planId: "authz_1",
        credentialId: "cred-1",
      })
      await expect(
        verifyScanAdmission(
          params({
            executionPlan: betaPlan,
            targetType: "API",
            authAssessmentPermitted: true,
          })
        )
      ).resolves.toEqual({ ok: true })
    })
  })
})
