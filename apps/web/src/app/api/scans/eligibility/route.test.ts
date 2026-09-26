import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    targetDomainVerification: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
  },
  resolveScanAttachments: vi.fn(),
  resolveAuthenticatedAssessmentAuthorization: vi.fn(),
  ScanAttachmentError: class ScanAttachmentError extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message)
    }
  },
  LiveAiSafetyError: class LiveAiSafetyError extends Error {
    constructor(public code: string) {
      super(code)
    }
  },
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn(),
  assertOAuthDelegatedScope: vi.fn(),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { create: "scan:create" } },
}))

vi.mock("@lyrashield/billing", () => ({
  evaluateScanEntitlement: vi.fn(),
  isTrialAvailable: vi.fn(),
  resolveWorkspaceScanSponsor: vi.fn(async (_workspaceId: string, actorId: string) => ({
    accountId: actorId,
    agency: false,
    agencyActive: false,
  })),
  // Sponsor account billing is the plan source now; the tests' existing
  // `workspace.findUnique → { plan }` fixtures stand in for it.
  resolveAccountBilling: vi.fn(async () => {
    const ws = await prisma.workspace.findUnique({
      where: { id: "ws-1" },
      select: { plan: true },
    })
    const plan = (ws as { plan?: string } | null)?.plan ?? "FREE"
    return { effectivePlan: plan, currentPlan: plan }
  }),
}))

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../__tests__/mocks")).loggerModule()
)

vi.mock("@lyrashield/config", () => ({
  env: { LYRASHIELD_AUTH_ASSESSMENT_ENABLED: "0", LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST: "" },
  evaluateAuthAssessmentAdmission: vi.fn(() => ({ allowed: false })),
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

import { prisma, resolveScanAttachments, ScanAttachmentError } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { evaluateScanEntitlement, isTrialAvailable } from "@lyrashield/billing"
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
    vi.mocked(isTrialAvailable).mockResolvedValue(false)
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

  it("rejects malformed Review Changes refs and repeated scalar inputs before reads", async () => {
    const invalid = await GET(
      request({ ...validQuery, workflow: "REVIEW_CHANGES", baseRef: "bad..ref" })
    )
    expect(invalid.status).toBe(400)

    const repeatedUrl = new URL(request(validQuery).url)
    repeatedUrl.searchParams.append("targetId", "target-2")
    const repeated = await GET(new Request(repeatedUrl))
    expect(repeated.status).toBe(400)
    expect(requirePermission).not.toHaveBeenCalled()
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

  it("mirrors the POST domain-verification gate for engine-backed remote targets", async () => {
    // Preflight parity: a paid WEB_APP target without a verified domain must
    // report DOMAIN_VERIFICATION_REQUIRED on an engine-backed tier here, not
    // an allowed verdict that POST would then reject with a raw error.
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)

    const response = await GET(request({ ...validQuery, mode: "STANDARD" }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(body.data.remediation.txtName).toBe("_lyrashield.app.example.com")
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("does not require domain proof for the deterministic-only tier", async () => {
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
    expect(body.data.allowed).toBe(true)
    expect(evaluateScanEntitlement).toHaveBeenCalled()
    expect(prisma.targetDomainVerification.findFirst).not.toHaveBeenCalled()
  })

  it("reports an engine-backed target as allowed once a current domain proof exists", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)

    const response = await GET(request({ ...validQuery, mode: "STANDARD" }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.allowed).toBe(true)
    expect(evaluateScanEntitlement).toHaveBeenCalled()
    expect(prisma.targetDomainVerification.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        domain: "app.example.com",
        status: "VERIFIED",
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    })
  })

  it("evaluates entitlement without mutating trial state", async () => {
    const response = await GET(request(validQuery))

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(evaluateScanEntitlement).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sponsorAccountId: "user-1",
      mode: "QUICK",
      mutateOnTrialExpiry: false,
    })
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        version: "lyrashield-scan-eligibility/1.0.0",
        advisory: true,
        allowed: true,
        profile: { id: "REPO_QUICK", canonicalMode: "QUICK", scope: "expected" },
        code: null,
        message: null,
        plan: "PRO",
        isTrial: false,
        remainingMinutes: 120,
      },
    })
  })

  it("validates workflow refs and attachment IDs before entitlement without mutating", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "REPO",
      installationId: 4,
      repoFullName: "owner/repo",
    } as never)
    const url = new URL(request(validQuery).url)
    url.searchParams.set("workflow", "REVIEW_CHANGES")
    url.searchParams.set("baseRef", "main")
    url.searchParams.append("attachmentId", "attachment-1")
    url.searchParams.append("attachmentId", "attachment-2")
    const response = await GET(new Request(url))
    expect(response.status).toBe(200)
    expect((await response.json()).data.allowed).toBe(true)
    expect(resolveScanAttachments).toHaveBeenCalledWith("ws-1", ["attachment-1", "attachment-2"])
  })

  it("reports cross-workspace attachment denial without disclosing ownership", async () => {
    vi.mocked(resolveScanAttachments).mockRejectedValueOnce(
      new ScanAttachmentError("SCAN_ATTACHMENT_NOT_FOUND", "Attachment not found in this workspace")
    )
    const url = new URL(request(validQuery).url)
    url.searchParams.append("attachmentId", "other-attachment")
    const response = await GET(new Request(url))
    expect((await response.json()).data).toMatchObject({
      allowed: false,
      code: "SCAN_ATTACHMENT_NOT_FOUND",
    })
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("reports the feature-gated assessment as unavailable without opening a session", async () => {
    const response = await GET(
      request({
        ...validQuery,
        workflow: "AUTHENTICATED_ASSESSMENT",
        authorizationRef: "auth-1",
      })
    )
    expect((await response.json()).data).toMatchObject({
      allowed: false,
      code: "SCAN_WORKFLOW_UNAVAILABLE",
    })
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
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
    vi.mocked(isTrialAvailable).mockResolvedValue(true)

    const response = await GET(request(validQuery))

    expect((await response.json()).data).toMatchObject({
      allowed: false,
      code: "TRIAL_AVAILABLE",
      message: "Start your 7-day trial to receive 60 agent-minutes.",
    })
    expect(isTrialAvailable).toHaveBeenCalledWith("ws-1", "user-1")
    vi.mocked(isTrialAvailable).mockResolvedValue(false)
    const exhausted = await GET(request(validQuery))
    expect((await exhausted.json()).data.code).toBe("NO_MINUTES_REMAINING")
  })
})
