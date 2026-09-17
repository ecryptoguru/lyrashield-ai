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
}))
vi.mock("./lifecycle-utils", () => ({
  refreshGateVerdictAfterTerminalScan: mocks.refreshGate,
}))

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
})
