import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    targetDomainVerification: { findFirst: vi.fn() },
  },
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn(),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { create: "scan:create" } },
}))

vi.mock("@lyrashield/billing", () => ({
  evaluateScanEntitlement: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

vi.mock("../../../../lib/rate-limit", () => ({
  checkScanEligibilityRateLimit: vi.fn(async () => ({
    limited: false,
    remaining: 29,
    retryAfter: 0,
  })),
  peekFreeUrlScanRateLimit: vi.fn(async () => ({
    limited: false,
    remaining: Number.POSITIVE_INFINITY,
    retryAfter: 0,
  })),
  clientIpFromRequest: () => "127.0.0.1",
}))

import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { evaluateScanEntitlement } from "@lyrashield/billing"
import { GET } from "./route"

function request(params: Record<string, string>) {
  const url = new URL("http://localhost/api/scans/eligibility")
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return new Request(url)
}

const validQuery = {
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "SAFE",
}

describe("GET /api/scans/eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user-1" } } as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "REPO",
    } as never)
    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: true,
      plan: "PRO",
      isTrial: false,
      remainingMinutes: 120,
    } as never)
  })

  it("uses the scan creation schema for goal and mode validation", async () => {
    const response = await GET(request({ ...validQuery, goal: "NOT_A_SCAN_GOAL" }))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_PARAM")
    expect(requirePermission).not.toHaveBeenCalled()
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("checks the same workspace permission and target ownership as creation", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null as never)

    const response = await GET(request(validQuery))

    expect(response.status).toBe(404)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:create")
    expect(prisma.target.findFirst).toHaveBeenCalledWith({
      where: { id: "target-1", workspaceId: "ws-1", deletedAt: null },
    })
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("mirrors the POST domain-verification gate for paid remote targets", async () => {
    // Preflight parity: a paid WEB_APP target without a verified domain must
    // report DOMAIN_VERIFICATION_REQUIRED here, not an allowed verdict that
    // POST would then reject with a raw error.
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)

    const response = await GET(request({ ...validQuery, mode: "SAFE" }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("reports a paid target as allowed once a current domain proof exists", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)

    const response = await GET(request({ ...validQuery, mode: "SAFE" }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.allowed).toBe(true)
    expect(evaluateScanEntitlement).toHaveBeenCalled()
  })

  it("evaluates entitlement without mutating trial state", async () => {
    const response = await GET(request(validQuery))

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(evaluateScanEntitlement).toHaveBeenCalledWith("ws-1", "QUICK", {
      mutateOnTrialExpiry: false,
    })
    expect(await response.json()).toEqual({
      success: true,
      data: {
        allowed: true,
        code: null,
        message: null,
        plan: "PRO",
        isTrial: false,
        remainingMinutes: 120,
      },
    })
  })

  it("offers an unstarted free workspace its trial before an upgrade", async () => {
    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 0,
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ trialStartedAt: null } as never)

    const response = await GET(request(validQuery))

    expect((await response.json()).data).toMatchObject({
      allowed: false,
      code: "TRIAL_AVAILABLE",
      message: "Start your 14-day trial to receive 100 agent-minutes.",
    })
  })
})
