import { beforeEach, describe, expect, it, vi } from "vitest"

const configMocks = vi.hoisted(() => ({
  authAssessment: { enabled: "0", allowlist: "" },
}))

// Real config module (including the allowlist parser); only the beta env
// values are stubbed so each test controls the gate deterministically.
vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "LYRASHIELD_AUTH_ASSESSMENT_ENABLED") {
          return configMocks.authAssessment.enabled
        }
        if (prop === "LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST") {
          return configMocks.authAssessment.allowlist
        }
        return Reflect.get(target, prop)
      },
    }),
  }
})

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    targetDomainVerification: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
    scanAttachment: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  createScan: vi.fn(),
  resolveScanAttachments: vi.fn().mockResolvedValue([]),
  resolveAuthenticatedAssessmentAuthorization: vi.fn().mockResolvedValue({ id: "authz-1" }),
  LiveAiSafetyError: class LiveAiSafetyError extends Error {
    readonly code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
  ScanAttachmentError: class ScanAttachmentError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock("@lyrashield/auth/server", () => ({
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission: vi.fn(),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { create: "scan:create" } },
}))

vi.mock("@lyrashield/billing", () => ({
  evaluateScanEntitlement: vi.fn(),
  isTrialAvailable: vi.fn(),
  assertScanAllowed: vi.fn(),
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
  checkFreeUrlScanRateLimit: vi.fn(async () => ({
    limited: false,
    remaining: 3,
    retryAfter: 0,
  })),
  checkScanCreateRateLimit: vi.fn(async () => ({
    limited: false,
    remaining: 5,
    retryAfter: 0,
  })),
  clientIpFromRequest: () => "127.0.0.1",
}))

import {
  prisma,
  createScan,
  resolveScanAttachments,
  resolveAuthenticatedAssessmentAuthorization,
  LiveAiSafetyError,
  ScanAttachmentError,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { assertScanAllowed, evaluateScanEntitlement, isTrialAvailable } from "@lyrashield/billing"
import {
  checkFreeUrlScanRateLimit,
  checkScanCreateRateLimit,
  checkScanEligibilityRateLimit,
  peekFreeUrlScanRateLimit,
} from "../../../../lib/rate-limit"
import { GET } from "./route"

function request(params: Record<string, string> | URLSearchParams) {
  const url = new URL("http://localhost/api/scans/eligibility")
  const entries = params instanceof URLSearchParams ? params.entries() : Object.entries(params)
  for (const [key, value] of entries) url.searchParams.append(key, value)
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
    configMocks.authAssessment.enabled = "0"
    configMocks.authAssessment.allowlist = ""
    vi.mocked(isTrialAvailable).mockResolvedValue(false)
    vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user-1" } } as never)
    // Per-test mockResolvedValue overrides persist across tests, so the
    // rate-limit defaults are re-established here, not only at mock creation.
    vi.mocked(checkScanEligibilityRateLimit).mockResolvedValue({
      limited: false,
      remaining: 29,
      retryAfter: 0,
    } as never)
    vi.mocked(peekFreeUrlScanRateLimit).mockResolvedValue({
      limited: false,
      remaining: Number.POSITIVE_INFINITY,
      retryAfter: 0,
    } as never)
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
    vi.mocked(resolveScanAttachments).mockResolvedValue([] as never)
    vi.mocked(resolveAuthenticatedAssessmentAuthorization).mockResolvedValue({
      id: "authz-1",
    } as never)
  })

  it("uses the scan creation schema for goal and mode validation", async () => {
    const response = await GET(request({ ...validQuery, goal: "NOT_A_SCAN_GOAL" }))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_PARAM")
    expect(requirePermission).not.toHaveBeenCalled()
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("rejects cross-field workflow combinations POST would reject", async () => {
    const response = await GET(request({ ...validQuery, baseRef: "main" }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_PARAM")

    const missingBase = await GET(request({ ...validQuery, workflow: "REVIEW_CHANGES" }))
    expect(missingBase.status).toBe(400)
    expect((await missingBase.json()).error.message).toContain("baseRef")
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

  it("enforces the delegated OAuth scope assertion POST applies", async () => {
    const response = await GET(request(validQuery))

    expect(response.status).toBe(200)
    expect(assertOAuthDelegatedScope).toHaveBeenCalledWith({ userId: "user-1" }, "target-1", "SAFE")
  })

  it("returns a rate-limit error without mutating anything", async () => {
    vi.mocked(checkScanEligibilityRateLimit).mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfter: 12,
    } as never)

    const response = await GET(request(validQuery))

    expect(response.status).toBe(429)
    expect((await response.json()).error.code).toBe("ELIGIBILITY_RATE_LIMITED")
    expect(response.headers.get("Retry-After")).toBe("12")
    expect(prisma.target.findFirst).not.toHaveBeenCalled()
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
    expect(body.data.blockers).toEqual([
      {
        code: "DOMAIN_VERIFICATION_REQUIRED",
        message: "Verify control of this domain once to enable engine-backed reviews.",
      },
    ])
    expect(body.data.remediation.txtName).toBe("_lyrashield.app.example.com")
    expect(body.data.supportedModes.length).toBeGreaterThan(0)
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
    expect(body.data.canonicalMode).toBe("STANDARD")
    expect(body.data.canonicalProfileId).toBe("WEB_APP_STANDARD")
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

  it("denies an API contract review without an OpenAPI document like POST does", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "API",
      url: "https://api.example.com",
      apiSpecUrl: null,
    } as never)

    const response = await GET(request({ ...validQuery, mode: "STANDARD" }))

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("API_SPEC_REQUIRED")
    expect(body.data.blockers[0].code).toBe("API_SPEC_REQUIRED")
    expect(body.data.supportedModes.length).toBeGreaterThan(0)
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("denies an unsupported target type like POST does", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "SATELLITE",
    } as never)

    const response = await GET(request(validQuery))

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("TARGET_TYPE_UNSUPPORTED")
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
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
    expect(await response.json()).toEqual({
      success: true,
      data: {
        allowed: true,
        code: null,
        message: null,
        plan: "PRO",
        isTrial: false,
        remainingMinutes: 120,
        blockers: [],
        supportedModes: expect.any(Array),
        canonicalMode: "QUICK",
        canonicalProfileId: "REPO_QUICK",
        expectedScannerFamilies: expect.any(Array),
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

  it("performs no billing, scan, attachment or audit mutation on repeated reads", async () => {
    // FREE-plan WEB_APP exercises the free-URL peek path — the only meter a
    // preflight may touch, and only ever as a read.
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "FREE" } as never)

    await GET(request({ ...validQuery, mode: "SAFE" }))
    await GET(request({ ...validQuery, mode: "SAFE" }))

    expect(assertScanAllowed).not.toHaveBeenCalled()
    expect(createScan).not.toHaveBeenCalled()
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
    expect(evaluateScanEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({ mutateOnTrialExpiry: false })
    )
    // The preflight may peek at the free-URL budget but must never consume
    // the POST meter or the scan-create meter.
    expect(peekFreeUrlScanRateLimit).toHaveBeenCalled()
    expect(checkFreeUrlScanRateLimit).not.toHaveBeenCalled()
    expect(checkScanCreateRateLimit).not.toHaveBeenCalled()
  })

  it("validates attachment ids read-only and reports unknown ones as blockers", async () => {
    vi.mocked(resolveScanAttachments).mockRejectedValue(
      new ScanAttachmentError("SCAN_ATTACHMENT_NOT_FOUND", "Attachment not found in this workspace")
    )

    const params = new URLSearchParams(validQuery)
    params.append("attachmentIds", "att_1")
    params.append("attachmentIds", "att_2")
    const response = await GET(request(params))

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("SCAN_ATTACHMENT_NOT_FOUND")
    expect(body.data.blockers).toEqual([
      { code: "SCAN_ATTACHMENT_NOT_FOUND", message: "Attachment not found in this workspace" },
    ])
    expect(resolveScanAttachments).toHaveBeenCalledWith("ws-1", ["att_1", "att_2"])
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("accepts valid attachment ids without blocking the verdict", async () => {
    const params = new URLSearchParams(validQuery)
    params.append("attachmentIds", "att_1")

    const response = await GET(request(params))

    expect((await response.json()).data.allowed).toBe(true)
    expect(resolveScanAttachments).toHaveBeenCalledWith("ws-1", ["att_1"])
  })

  it("rejects attachment lists over the plan cap at validation", async () => {
    const params = new URLSearchParams(validQuery)
    for (let i = 0; i < 21; i++) params.append("attachmentIds", `att_${i}`)

    const response = await GET(request(params))

    expect(response.status).toBe(400)
    expect(resolveScanAttachments).not.toHaveBeenCalled()
  })

  it("labels REVIEW_CHANGES ref resolution as a limitation, not a denial", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "REPO",
      installationId: 42,
      repoOwner: "ecryptoguru",
      repoName: "lyrashield-ai",
      repoFullName: "ecryptoguru/lyrashield-ai",
    } as never)

    const response = await GET(
      request({ ...validQuery, workflow: "REVIEW_CHANGES", baseRef: "main", headRef: "feat" })
    )

    const body = await response.json()
    expect(body.data.allowed).toBe(true)
    expect(body.data.limitations).toEqual([
      "Comparison refs and merge base resolve to immutable revisions only when the scan is submitted.",
    ])
    // No ref resolution, no GitHub calls, no mutation on a GET.
    expect(createScan).not.toHaveBeenCalled()
  })

  it("denies REVIEW_CHANGES on a non-repository target like POST does", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)

    const response = await GET(
      request({ ...validQuery, workflow: "REVIEW_CHANGES", baseRef: "main" })
    )

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("SCAN_PLAN_INVALID")
    expect(body.data.blockers[0].code).toBe("SCAN_PLAN_INVALID")
  })

  it("denies AUTHENTICATED_ASSESSMENT when the beta flag is off, like POST", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)

    const response = await GET(
      request({ ...validQuery, workflow: "AUTHENTICATED_ASSESSMENT", authorizationRef: "authz-1" })
    )

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("SCAN_WORKFLOW_UNAVAILABLE")
    expect(resolveAuthenticatedAssessmentAuthorization).not.toHaveBeenCalled()
  })

  it("reports a recorded authorization failure for the gated beta", async () => {
    configMocks.authAssessment.enabled = "1"
    configMocks.authAssessment.allowlist = "ws-1:target-1"
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      id: "default-policy",
      destructiveTestsAllowed: false,
    } as never)
    vi.mocked(resolveAuthenticatedAssessmentAuthorization).mockRejectedValue(
      new LiveAiSafetyError("AUTH_ASSESSMENT_AUTH_NOT_FOUND")
    )

    const response = await GET(
      request({ ...validQuery, workflow: "AUTHENTICATED_ASSESSMENT", authorizationRef: "authz-9" })
    )

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("AUTH_ASSESSMENT_AUTH_NOT_FOUND")
    expect(resolveAuthenticatedAssessmentAuthorization).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      authorizationRef: "authz-9",
    })
    // Read-only check — the policy lookup is a find, never a write.
    expect(prisma.policy.findFirst).toHaveBeenCalled()
  })

  it("keeps the entitlement verdict first when workflow gates would also fail", async () => {
    // POST evaluates the entitlement gate before workflow gates — a caller
    // out of minutes gets the billing denial even on an invalid workflow.
    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 0,
    } as never)

    const response = await GET(
      request({ ...validQuery, workflow: "AUTHENTICATED_ASSESSMENT", authorizationRef: "a" })
    )

    const body = await response.json()
    expect(body.data.code).toBe("NO_MINUTES_REMAINING")
    // Both known reasons are reported without a second call.
    expect(body.data.blockers.map((b: { code: string }) => b.code)).toEqual([
      "NO_MINUTES_REMAINING",
      "SCAN_WORKFLOW_UNAVAILABLE",
    ])
  })
})
