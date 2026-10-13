import { beforeEach, describe, expect, it, vi } from "vitest"

const configMocks = vi.hoisted(() => ({
  authAssessment: { enabled: "0", allowlist: "" },
}))

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
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
    scan: { count: vi.fn(), update: vi.fn() },
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
    WorkspaceScanConcurrencyLimitError: class WorkspaceScanConcurrencyLimitError extends Error {},
    prisma,
    createScan: vi.fn(),
    listScans: vi.fn(),
    updateScanStatus: vi.fn(),
    claimOrGetAgentOperation: vi.fn(),
    completeAgentOperation: vi.fn(),
    failAgentOperation: vi.fn(),
    resolveScanAttachments: vi.fn().mockResolvedValue([]),
    resolveAuthenticatedAssessmentAuthorization: vi.fn(),
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
  PERMISSIONS: {
    scan: { view: "scan:view", create: "scan:create", cancel: "scan:cancel", retry: "scan:retry" },
  },
}))

vi.mock("@lyrashield/logger", async () => (await import("../../../__tests__/mocks")).loggerModule())

vi.mock("../../../lib/rate-limit", () => ({
  checkScanCreateRateLimit: vi
    .fn()
    .mockResolvedValue({ limited: false, remaining: 5, retryAfter: 0 }),
  checkScanEligibilityRateLimit: vi
    .fn()
    .mockResolvedValue({ limited: false, remaining: 29, retryAfter: 0 }),
  checkFreeUrlScanRateLimit: vi
    .fn()
    .mockResolvedValue({ limited: false, remaining: 3, retryAfter: 0 }),
  peekFreeUrlScanRateLimit: vi.fn(async () => ({
    limited: false,
    remaining: Number.POSITIVE_INFINITY,
    retryAfter: 0,
  })),
  clientIpFromRequest: vi.fn().mockReturnValue("203.0.113.9"),
}))

vi.mock("../../../lib/queue", () => ({
  enqueueScanJob: vi.fn().mockResolvedValue("job-1"),
  assertScanWorkerAvailable: vi.fn().mockResolvedValue(undefined),
  ScanWorkerUnavailableError: class ScanWorkerUnavailableError extends Error {},
}))

vi.mock("@lyrashield/integrations", () => ({
  isTargetRelayWorkerAvailable: vi.fn().mockResolvedValue(true),
  getBranchRefSha: vi.fn(),
  getDefaultBranch: vi.fn(),
  getMergeBaseSha: vi.fn(),
}))

vi.mock("@lyrashield/billing", () => ({
  assertScanAllowed: vi.fn(),
  evaluateScanEntitlement: vi.fn(),
  isTrialAvailable: vi.fn(),
  resolveWorkspaceScanSponsor: vi.fn(async (_workspaceId: string, actorId: string) => ({
    accountId: actorId,
    agency: false,
    agencyActive: false,
  })),
  resolveAccountBilling: vi.fn(async () => ({ effectivePlan: "PRO", currentPlan: "PRO" })),
}))

import { isTargetRelayWorkerAvailable } from "@lyrashield/integrations"
import { prisma, createScan } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import {
  assertScanAllowed,
  evaluateScanEntitlement,
  resolveAccountBilling,
} from "@lyrashield/billing"
import { GET as eligibilityGET } from "./eligibility/route"
import { POST as scansPOST } from "./route"

function eligibilityRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/scans/eligibility")
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return new Request(url)
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const query = {
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "STANDARD",
}

describe("preflight → POST parity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTargetRelayWorkerAvailable).mockResolvedValue(true)
    configMocks.authAssessment.enabled = "0"
    configMocks.authAssessment.allowlist = ""
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    } as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "REPO",
    } as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      id: "default-policy",
      destructiveTestsAllowed: false,
    } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: true,
      plan: "PRO",
      isTrial: false,
      remainingMinutes: 120,
    } as never)
    vi.mocked(assertScanAllowed).mockResolvedValue({ allowed: true } as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-1",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "STANDARD",
      triggerType: "manual",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      summary: null,
      errorCategory: null,
      errorMessage: null,
      createdAt: new Date("2026-09-25T00:00:00Z"),
      executionPlan: null,
      executionPlanHash: null,
    } as never)
  })

  it.each(["WEB_APP", "API"])(
    "refuses unavailable relay-dependent %s reviews before mutation",
    async (type) => {
      vi.mocked(isTargetRelayWorkerAvailable).mockResolvedValue(false)
      vi.mocked(prisma.target.findFirst).mockResolvedValue({
        id: "target-1",
        type,
        url: "https://app.example.com",
        apiSpecUrl: "https://app.example.com/openapi.json",
      } as never)
      for (const mode of ["STANDARD", "DEEP", "CUSTOM"]) {
        const preflight = await eligibilityGET(eligibilityRequest({ ...query, mode }))
        const advisory = (await preflight.json()).data
        expect(advisory).toMatchObject({ allowed: false, code: "TARGET_RELAY_UNAVAILABLE" })
        expect(
          advisory.supportedModes
            .filter((option: { usesAi: boolean }) => option.usesAi)
            .every((option: { available: boolean }) => !option.available)
        ).toBe(true)
        expect(
          advisory.supportedModes.some(
            (option: { usesAi: boolean; available: boolean }) => !option.usesAi && option.available
          )
        ).toBe(true)
        const post = await scansPOST(postRequest({ ...query, mode }))
        expect(post.status).toBe(503)
        expect((await post.json()).error.code).toBe("TARGET_RELAY_UNAVAILABLE")
      }
      expect(createScan).not.toHaveBeenCalled()
      expect(assertScanAllowed).not.toHaveBeenCalled()
      expect(evaluateScanEntitlement).not.toHaveBeenCalled()
    }
  )

  it("keeps repository and surface reviews available without a relay", async () => {
    vi.mocked(isTargetRelayWorkerAvailable).mockResolvedValue(false)
    for (const [type, mode] of [
      ["REPO", "STANDARD"],
      ["WEB_APP", "SAFE"],
      ["API", "QUICK"],
    ] as const) {
      vi.mocked(prisma.target.findFirst).mockResolvedValue({
        id: "target-1",
        type,
        url: "https://app.example.com",
      } as never)
      const preflight = await eligibilityGET(eligibilityRequest({ ...query, mode }))
      expect((await preflight.json()).data.allowed).toBe(true)
    }
  })

  it("an allowed preflight never guarantees admission — POST re-gates on fresh state", async () => {
    // Preflight passes while the account has minutes…
    const preflight = await eligibilityGET(eligibilityRequest(query))
    expect(preflight.status).toBe(200)
    expect((await preflight.json()).data.allowed).toBe(true)

    // …then the balance changes before submission. The mutation gate must
    // deny with the same code family the preflight would now report.
    vi.mocked(assertScanAllowed).mockResolvedValue({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 0,
    } as never)

    const post = await scansPOST(postRequest(query))
    expect(post.status).toBe(403)
    expect((await post.json()).error.code).toBe("NO_MINUTES_REMAINING")

    // A repeated preflight now reports the identical denial — the advisory
    // verdict always tracks current state, never a cached pass.
    vi.mocked(evaluateScanEntitlement).mockResolvedValue({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 0,
    } as never)
    const recheck = await eligibilityGET(eligibilityRequest(query))
    expect((await recheck.json()).data).toMatchObject({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
    })
  })

  it("both routes report the same policy code for the same failing gate", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)

    const preflight = await eligibilityGET(eligibilityRequest(query))
    const post = await scansPOST(postRequest(query))

    const preflightBody = await preflight.json()
    const postBody = await post.json()
    expect(preflightBody.data.allowed).toBe(false)
    expect(preflightBody.data.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(post.status).toBe(403)
    expect(postBody.error.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
  })

  it("keeps engine-backed proof requirements consistent for an expired-trial FREE account", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue({
      effectivePlan: "FREE",
      currentPlan: "FREE",
    } as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://trial.example.com",
    } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)

    const preflight = await eligibilityGET(eligibilityRequest(query))
    const post = await scansPOST(postRequest(query))

    expect((await preflight.json()).data).toMatchObject({
      allowed: false,
      code: "DOMAIN_VERIFICATION_REQUIRED",
    })
    expect(post.status).toBe(403)
    expect((await post.json()).error.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("repeated preflights invoke no mutation code paths", async () => {
    await eligibilityGET(eligibilityRequest(query))
    await eligibilityGET(eligibilityRequest(query))
    await eligibilityGET(eligibilityRequest(query))

    expect(assertScanAllowed).not.toHaveBeenCalled()
    expect(createScan).not.toHaveBeenCalled()
    expect(prisma.scan.count).not.toHaveBeenCalled()
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
    expect(evaluateScanEntitlement).toHaveBeenCalledTimes(3)
    expect(evaluateScanEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({ mutateOnTrialExpiry: false })
    )
  })

  it("uses the explicitly selected policy for authenticated-assessment preflight", async () => {
    configMocks.authAssessment.enabled = "1"
    configMocks.authAssessment.allowlist = "ws-1:target-1"
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://app.example.com",
    } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      id: "selected-policy",
      destructiveTestsAllowed: true,
    } as never)

    const response = await eligibilityGET(
      eligibilityRequest({
        ...query,
        workflow: "AUTHENTICATED_ASSESSMENT",
        authorizationRef: "authz-1",
        policyId: "selected-policy",
      })
    )

    expect((await response.json()).data).toMatchObject({
      allowed: false,
      code: "SCAN_PLAN_DENIED",
    })
    expect(prisma.policy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "selected-policy", workspaceId: "ws-1", deletedAt: null },
      })
    )
  })

  it("reports an explicit policy outside the workspace as POLICY_NOT_FOUND", async () => {
    vi.mocked(prisma.policy.findFirst).mockResolvedValue(null as never)

    const response = await eligibilityGET(
      eligibilityRequest({ ...query, policyId: "foreign-policy" })
    )

    expect((await response.json()).data).toMatchObject({
      allowed: false,
      code: "POLICY_NOT_FOUND",
      blockers: [expect.objectContaining({ code: "POLICY_NOT_FOUND" })],
    })
    expect(prisma.policy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign-policy", workspaceId: "ws-1", deletedAt: null },
      })
    )
  })
})
