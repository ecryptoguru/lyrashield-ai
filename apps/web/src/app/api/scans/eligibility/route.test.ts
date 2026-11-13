vi.mock("@lyrashield/integrations", () => ({
  isTargetRelayWorkerAvailable: vi.fn().mockResolvedValue(true),
  getBranchRefSha: vi.fn().mockResolvedValue("a".repeat(40)),
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  getMergeBaseSha: vi.fn().mockResolvedValue("b".repeat(40)),
}))
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

vi.mock("@lyrashield/db", () => {
  const prisma = {
    target: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    targetDomainVerification: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
    integration: { findFirst: vi.fn() },
    scanAttachment: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  }
  return {
    findCurrentDomainProof: vi.fn(async (workspaceId: string, url: string | null | undefined) => {
      const domain = url ? new URL(url).hostname.toLowerCase() : null
      if (!domain) return { domain, verified: false }
      const proof = await prisma.targetDomainVerification.findFirst({
        where: { workspaceId, domain, status: "VERIFIED", expiresAt: { gt: new Date() } },
        select: { id: true },
      })
      return { domain, verified: Boolean(proof) }
    }),
    prisma,
    withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: typeof prisma) => unknown) =>
      fn(prisma)
    ),
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
  }
})

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
  withWorkspaceRLS,
  createScan,
  resolveScanAttachments,
  resolveAuthenticatedAssessmentAuthorization,
  ScanAttachmentError,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { assertScanAllowed, evaluateScanEntitlement, isTrialAvailable } from "@lyrashield/billing"
import { getBranchRefSha } from "@lyrashield/integrations"
import {
  checkFreeUrlScanRateLimit,
  checkScanCreateRateLimit,
  checkScanEligibilityRateLimit,
  peekFreeUrlScanRateLimit,
} from "../../../../lib/rate-limit"
import { GET } from "./route"
import { GET as setupHealthGET } from "../../setup-health/route"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

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
  it("accepts a positive operator ceiling for a repository review and keeps policy amounts private", async () => {
    vi.mocked(prisma.policy.findFirst).mockResolvedValueOnce({
      id: "p",
      maxBudgetUsd: { toNumber: () => 0.47 },
    } as never)
    const response = await GET(request({ ...validQuery, engineBudgetCeilingUsd: "1" }))
    const { data } = await response.json()
    expect(data.allowed).toBe(true)
    expect(JSON.stringify(data)).not.toContain("0.47")
  })

  it.each(["REPO", "WEB_APP"])(
    "checks engine capability against zero policy on %s",
    async (type) => {
      vi.mocked(prisma.target.findFirst).mockResolvedValueOnce({
        id: "target-1",
        type,
        url: "https://app.example.com",
      } as never)
      vi.mocked(prisma.policy.findFirst).mockResolvedValueOnce({
        id: "p",
        maxBudgetUsd: { toNumber: () => 0 },
      } as never)
      const response = await GET(
        request({ ...validQuery, ...(type === "REPO" ? { engineBudgetCeilingUsd: "1" } : {}) })
      )
      const { data } = await response.json()
      expect(response.status).toBe(200)
      if (type === "REPO") {
        expect(data.allowed).toBe(false)
        expect(data.blockers).toContainEqual({
          code: "SCAN_PLAN_INVALID",
          message: expect.stringMatching(/engine spending is disabled/i),
        })
      } else expect(data.allowed).toBe(true)
    }
  )

  it.each(["0", "-1", "NaN", "Infinity", ""])(
    "rejects invalid requested engine ceiling %s",
    async (value) => {
      expect((await GET(request({ ...validQuery, engineBudgetCeilingUsd: value }))).status).toBe(
        400
      )
    }
  )
  it("rejects duplicate request ceilings instead of selecting the last amount", async () => {
    const params = new URLSearchParams({ ...validQuery, engineBudgetCeilingUsd: "1" })
    params.append("engineBudgetCeilingUsd", "2")
    expect((await GET(request(params))).status).toBe(400)
  })

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
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: "integration-1",
      status: "active",
    } as never)
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
    expect(withWorkspaceRLS).toHaveBeenCalledWith("ws-1", expect.any(Function))
    expect(prisma.target.findFirst).toHaveBeenCalledWith({
      where: { id: "target-1", workspaceId: "ws-1", deletedAt: null },
    })
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("denies eligibility reads without scan:create", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await GET(request(validQuery))

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/scans/eligibility",
      "GET"
    )
    expect(prisma.target.findFirst).not.toHaveBeenCalled()
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

  it("refuses an explicit Standard URL tier as an unsupported profile, matching POST", async () => {
    // Standard/Deep/Custom are removed from the URL/API launch offering: the
    // preflight refuses them with the same unsupported code POST returns,
    // before any entitlement, queue or provider work.
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)

    const response = await GET(request({ ...validQuery, mode: "STANDARD" }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("URL_MODE_UNSUPPORTED")
    expect(body.data.blockers).toEqual([
      { code: "URL_MODE_UNSUPPORTED", message: body.data.message },
    ])
    expect(body.data.message).toContain("Safe and Quick")
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

  it("keeps a Standard URL tier unsupported even when a current domain proof exists", async () => {
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
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("URL_MODE_UNSUPPORTED")
    expect(evaluateScanEntitlement).not.toHaveBeenCalled()
  })

  it("denies an explicit API contract review as unsupported like POST does", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "API",
      url: "https://api.example.com",
      apiSpecUrl: null,
    } as never)

    const response = await GET(request({ ...validQuery, mode: "STANDARD" }))

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("URL_MODE_UNSUPPORTED")
    expect(body.data.blockers[0].code).toBe("URL_MODE_UNSUPPORTED")
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

  it("keeps the gated beta unavailable even with the env flag and allowlist on", async () => {
    // Authenticated assessments are deferred: the shared boundary refuses them
    // regardless of the deployment flag, so no authorization is resolved.
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

    const response = await GET(
      request({ ...validQuery, workflow: "AUTHENTICATED_ASSESSMENT", authorizationRef: "authz-9" })
    )

    const body = await response.json()
    expect(body.data.allowed).toBe(false)
    expect(body.data.code).toBe("SCAN_WORKFLOW_UNAVAILABLE")
    expect(resolveAuthenticatedAssessmentAuthorization).not.toHaveBeenCalled()
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

  it("binds setup health to resolved policy, sponsor, membership and source connection", async () => {
    const member = { id: "member-1", role: "OWNER", status: "active", updatedAt: new Date(0) }
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "OWNER", member },
    } as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "REPO",
      repoFullName: "private/app",
      branch: "main",
      installationId: "123",
    } as never)
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: "connection-1",
      status: "active",
      updatedAt: new Date(0),
    } as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      id: "policy-1",
      maxBudgetUsd: { toNumber: () => 0.47 },
      blockedPaths: ["/private"],
    } as never)
    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: true,
      accountId: "private-sponsor",
      plan: "PRO",
      isTrial: false,
      remainingMinutes: 120,
    } as never)
    const check = async () =>
      (await (await setupHealthGET(request({ ...validQuery, mode: "STANDARD" }))).json()).data
    const initial = await check()
    expect(initial).toMatchObject({ status: "ready", allowed: true })
    expect(vi.mocked(withWorkspaceRLS).mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      "ws-1",
      "ws-1",
      "ws-1",
      "ws-1",
    ])
    expect(JSON.stringify(initial)).not.toContain("private-sponsor")
    expect(JSON.stringify(initial)).not.toContain("private/app")
    expect(JSON.stringify(initial)).not.toContain("0.47")

    vi.mocked(getBranchRefSha).mockResolvedValueOnce("f".repeat(40))
    const movedBranch = await check()
    expect(movedBranch.scopeFingerprint).not.toBe(initial.scopeFingerprint)
    expect(JSON.stringify(movedBranch)).not.toContain("f".repeat(40))
    vi.mocked(getBranchRefSha).mockRejectedValueOnce(new Error("provider unavailable"))
    const unavailableSource = await check()
    expect(unavailableSource).toMatchObject({ status: "unknown", allowed: false })

    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      id: "policy-1",
      maxBudgetUsd: { toNumber: () => 0.22 },
      blockedPaths: ["/private"],
    } as never)
    const policyChanged = await check()
    expect(policyChanged.scopeFingerprint).not.toBe(initial.scopeFingerprint)

    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: true,
      accountId: "another-sponsor",
      plan: "PRO",
      isTrial: false,
      remainingMinutes: 120,
    } as never)
    const sponsorChanged = await check()
    expect(sponsorChanged.scopeFingerprint).not.toBe(policyChanged.scopeFingerprint)

    member.role = "MEMBER"
    const membershipChanged = await check()
    expect(membershipChanged.scopeFingerprint).not.toBe(sponsorChanged.scopeFingerprint)

    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: "connection-1",
      status: "disabled",
      updatedAt: new Date(1),
    } as never)
    const disconnected = await check()
    expect(disconnected.scopeFingerprint).not.toBe(membershipChanged.scopeFingerprint)
    expect(disconnected).toMatchObject({ status: "unknown", allowed: false })

    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: "connection-1",
      status: "active",
      updatedAt: new Date(0),
    } as never)
    vi.mocked(requirePermission)
      .mockResolvedValueOnce({ session: { userId: "user-1" }, workspace: { member } } as never)
      .mockRejectedValueOnce(new Error("FORBIDDEN"))
    let release: ((revision: string) => void) | undefined
    vi.mocked(getBranchRefSha).mockClear()
    vi.mocked(getBranchRefSha).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const pending = setupHealthGET(request({ ...validQuery, mode: "STANDARD" }))
    await vi.waitFor(() => expect(getBranchRefSha).toHaveBeenCalledTimes(1))
    release?.("a".repeat(40))
    const revoked = await pending
    expect(revoked.status).toBe(403)
  })

  it("rechecks attachments that are revoked during source observation", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { member: { id: "member-1", role: "OWNER", status: "active" } },
    } as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "REPO",
      repoFullName: "owner/project",
      branch: "main",
      installationId: "123",
    } as never)
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: "connection-1",
      status: "active",
    } as never)
    vi.mocked(resolveScanAttachments)
      .mockResolvedValueOnce([
        { id: "attachment-1", checksum: "a".repeat(64), status: "ACTIVE", byteLength: 1 },
      ] as never)
      .mockRejectedValueOnce(
        new ScanAttachmentError("SCAN_ATTACHMENT_UNAVAILABLE", "Attachment is unavailable")
      )
    let release: ((revision: string) => void) | undefined
    vi.mocked(getBranchRefSha).mockClear()
    vi.mocked(getBranchRefSha).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const pending = setupHealthGET(
      request({ ...validQuery, mode: "STANDARD", attachmentIds: "attachment-1" })
    )
    await vi.waitFor(() => expect(getBranchRefSha).toHaveBeenCalledTimes(1))
    release?.("a".repeat(40))
    const body = await (await pending).json()
    expect(resolveScanAttachments).toHaveBeenCalledTimes(2)
    expect(body.data).toMatchObject({
      status: "blocked",
      allowed: false,
      primaryCheck: "SCAN_ATTACHMENT_UNAVAILABLE",
    })
  })
})
