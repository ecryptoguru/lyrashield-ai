import { describe, it, expect, vi, beforeEach } from "vitest"

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

vi.mock("@lyrashield/db", () => ({
  WorkspaceScanConcurrencyLimitError: class WorkspaceScanConcurrencyLimitError extends Error {},
  prisma: {
    target: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    targetDomainVerification: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
    scan: { count: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  createScan: vi.fn(),
  listScans: vi.fn(),
  updateScanStatus: vi.fn(),
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
}))

vi.mock("@lyrashield/auth/server", () => ({
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  }),
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
  checkFreeUrlScanRateLimit: vi
    .fn()
    .mockResolvedValue({ limited: false, remaining: 3, retryAfter: 0 }),
  clientIpFromRequest: vi.fn().mockReturnValue("203.0.113.9"),
}))

vi.mock("../../../lib/queue", () => ({
  enqueueScanJob: vi.fn().mockResolvedValue("job-1"),
  assertScanWorkerAvailable: vi.fn().mockResolvedValue(undefined),
  ScanWorkerUnavailableError: class ScanWorkerUnavailableError extends Error {},
}))

vi.mock("@lyrashield/integrations", () => ({
  getBranchRefSha: vi.fn(),
  getDefaultBranch: vi.fn(),
  getMergeBaseSha: vi.fn(),
}))

vi.mock("@lyrashield/billing", () => ({
  assertScanAllowed: vi.fn().mockResolvedValue({ allowed: true }),
  assertTargetAllowed: vi.fn().mockResolvedValue({ allowed: true }),
  resolveWorkspaceScanSponsor: vi.fn(async (_workspaceId: string, actorId: string) => ({
    accountId: actorId,
    agency: false,
    agencyActive: false,
  })),
  // The sponsor's account billing is the plan source now; the tests' existing
  // `workspace.findUnique → { plan }` fixtures stand in for it.
  resolveAccountBilling: vi.fn(async () => {
    const ws = await prisma.workspace.findUnique({ where: { id: "ws" }, select: { plan: true } })
    const plan = (ws as { plan?: string } | null)?.plan ?? "FREE"
    return { effectivePlan: plan, currentPlan: plan }
  }),
}))

import { POST, GET } from "./route"
import {
  prisma,
  createScan,
  listScans,
  updateScanStatus,
  resolveScanAttachments,
  resolveAuthenticatedAssessmentAuthorization,
  LiveAiSafetyError,
  ScanAttachmentError,
  WorkspaceScanConcurrencyLimitError,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../lib/queue"
import { checkFreeUrlScanRateLimit } from "../../../lib/rate-limit"
import { assertScanAllowed } from "@lyrashield/billing"
import { getBranchRefSha, getMergeBaseSha } from "@lyrashield/integrations"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function makeGetRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost:3000/api/scans")
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url, { method: "GET" })
}

/** A listScans() row as the service now returns it: Date objects, flat findingCount. */
function scanListItem(id: string) {
  return {
    id,
    status: "COMPLETED",
    goal: "audit",
    mode: "SAFE",
    triggerType: "manual",
    startedAt: null,
    endedAt: null,
    summary: null,
    errorCategory: null,
    errorMessage: null,
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
    findingCount: 0,
    target: null,
  }
}

function defaultAuthMock() {
  vi.mocked(requirePermission).mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  } as never)
}

describe("POST /api/scans", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMocks.authAssessment.enabled = "0"
    configMocks.authAssessment.allowlist = ""
    defaultAuthMock()
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(enqueueScanJob).mockResolvedValue("job-1")
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({ id: "default-policy" } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "FREE" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(assertScanAllowed).mockResolvedValue({ allowed: true } as never)
  })

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost:3000/api/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.code).toBe("INVALID_JSON")
  })

  it("returns 400 for validation errors (missing targetId)", async () => {
    const res = await POST(makeRequest({ workspaceId: "ws-1", goal: "TEST_APP" }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 404 when target not found in workspace", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "missing-target",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error.code).toBe("TARGET_NOT_FOUND")
  })

  it("returns 404 when policy not found", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1" } as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
        policyId: "missing-policy",
      })
    )

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error.code).toBe("POLICY_NOT_FOUND")
  })

  it("returns 409 when scan already in progress", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(1 as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error.code).toBe("SCAN_IN_PROGRESS")
  })

  it("returns 409 when a concurrent request wins the active-scan constraint", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockRejectedValue(new Error("Target already has an active scan") as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("SCAN_IN_PROGRESS")
  })

  it("creates scan and enqueues job successfully", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-1",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      targetId: "t1",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.id).toBe("scan-1")
    expect(enqueueScanJob).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        workspaceId: "ws-1",
        targetId: "t1",
        policyId: "default-policy",
      })
    )
    expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ policyId: "default-policy" }))
  })

  it("persists the canonical URL profile instead of its Quick compatibility alias", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "web-1",
      type: "WEB_APP",
      apiSpecUrl: null,
    } as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-url-quick",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      targetId: "web-1",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-url-quick",
        targetId: "web-1",
        goal: "TEST_APP",
        mode: "QUICK",
      })
    )

    expect(res.status).toBe(201)
    expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ mode: "SAFE" }))
    expect(enqueueScanJob).toHaveBeenCalledWith(expect.objectContaining({ mode: "SAFE" }))
  })

  it("requires a current domain proof before an engine-backed remote scan", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "web-verified",
      type: "WEB_APP",
      url: "https://staging.example.com/safety",
      apiSpecUrl: null,
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-paid-proof",
        targetId: "web-verified",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(createScan).not.toHaveBeenCalled()
    expect(prisma.targetDomainVerification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ domain: "staging.example.com", status: "VERIFIED" }),
      })
    )
  })

  it("allows a paid deterministic surface review without domain proof", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "web-safe",
      type: "WEB_APP",
      url: "https://staging.example.com",
      apiSpecUrl: null,
    } as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-safe-noproof",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      targetId: "web-safe",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-safe-noproof",
        targetId: "web-safe",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(201)
    expect(prisma.targetDomainVerification.findFirst).not.toHaveBeenCalled()
  })

  it("skips domain verification for the free plan on an engine-backed tier", async () => {
    // FREE never reaches the verification gate for STANDARD/DEEP — the
    // entitlement gate (minutes/DEEP plan) is the denial path instead.
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "web-free-std",
      type: "WEB_APP",
      url: "https://free.example.com",
      apiSpecUrl: null,
    } as never)
    vi.mocked(assertScanAllowed).mockResolvedValue({
      allowed: false,
      code: "DEEP_NOT_ALLOWED",
      message: "Upgrade required",
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-free-std",
        targetId: "web-free-std",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(prisma.targetDomainVerification.findFirst).not.toHaveBeenCalled()
    expect((await res.json()).error.code).toBe("DEEP_NOT_ALLOWED")
  })

  /**
   * The Trust Runs page prepends this response straight into its scan list and
   * validates it against the list-item schema. When POST returned only
   * {id,status,goal,mode,targetId,createdAt}, that validation failed and the
   * user saw "Response validation failed" — on a scan that HAD been created and
   * enqueued. Asserting the full contract here keeps the two shapes from
   * drifting apart again.
   */
  it("returns the full scan-list-item shape the client validates against", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      name: "Staging Site",
      type: "WEB_APP",
      url: "https://example.com",
      apiSpecUrl: null,
      repoFullName: null,
    } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-shape",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      triggerType: "manual",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      summary: null,
      errorCategory: null,
      errorMessage: null,
      targetId: "t1",
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    } as never)

    // Distinct workspace on purpose: POST is rate-limited per workspace and the
    // limiter is shared across tests in this file, so reusing ws-1 would spend
    // another request from its budget and push a later test into a 429.
    const res = await POST(
      makeRequest({ workspaceId: "ws-shape", targetId: "t1", goal: "TEST_APP", mode: "SAFE" })
    )

    expect(res.status).toBe(201)
    const { data } = await res.json()

    // Every field the client's scanItemSchema requires must be present.
    expect(data).toMatchObject({
      id: "scan-shape",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      triggerType: "manual",
      startedAt: null,
      endedAt: null,
      summary: null,
      errorCategory: null,
      errorMessage: null,
    })
    // `target` must be the nested object, not a bare targetId.
    expect(data.target).toEqual({
      id: "t1",
      name: "Staging Site",
      type: "WEB_APP",
      url: "https://example.com",
      apiSpecUrl: null,
      repoFullName: null,
    })
    // Dates serialize to ISO strings, matching the SSR-rendered payload.
    expect(data.createdAt).toBe("2026-08-03T00:00:00.000Z")
    expect(prisma.auditLog.create).toHaveBeenCalled()
  })

  it("returns 503 without creating a scan when no worker is available", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(assertScanWorkerAvailable).mockRejectedValue(new ScanWorkerUnavailableError())

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("SCAN_SERVICE_UNAVAILABLE")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("returns 409 when the transactional workspace scan cap wins a race", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1", type: "REPO" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockRejectedValue(new WorkspaceScanConcurrencyLimitError())

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("SCAN_CONCURRENCY_LIMIT")
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("returns 503 when enqueue fails", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-2",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      targetId: "t1",
      createdAt: new Date(),
    } as never)
    vi.mocked(enqueueScanJob).mockRejectedValue(new Error("Redis down") as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.error.code).toBe("SCAN_SERVICE_UNAVAILABLE")
    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-2",
      "FAILED",
      expect.objectContaining({ errorCategory: "QUEUE" })
    )
  })

  it("returns 403 when user lacks scan.create permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN") as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    )

    expect(res.status).toBe(403)
  })

  describe("execution plan workflow inputs", () => {
    const repoTarget = {
      id: "repo-1",
      type: "REPO",
      installationId: "1234",
      repoOwner: "acme",
      repoName: "app",
      repoFullName: "acme/app",
      branch: "main",
    }

    it("rejects refs without workflow REVIEW_CHANGES", async () => {
      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "repo-1",
          goal: "TEST_APP",
          baseRef: "main",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects REVIEW_CHANGES without a baseRef", async () => {
      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "repo-1",
          goal: "CHECK_PR",
          workflow: "REVIEW_CHANGES",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects AUTHENTICATED_ASSESSMENT when the beta flag is off", async () => {
      configMocks.authAssessment.enabled = "0"
      configMocks.authAssessment.allowlist = "ws-1:web-1"
      const webTarget = {
        id: "web-1",
        type: "WEB_APP",
        url: "https://staging.example.com",
        environment: "STAGING",
        apiSpecUrl: null,
      }
      vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-1",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_1",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("SCAN_WORKFLOW_UNAVAILABLE")
      expect(createScan).not.toHaveBeenCalled()
      expect(resolveAuthenticatedAssessmentAuthorization).not.toHaveBeenCalled()
    })

    it("rejects AUTHENTICATED_ASSESSMENT when the workspace/target is not allowlisted", async () => {
      configMocks.authAssessment.enabled = "1"
      // Allowlist present but names a different workspace/target pair.
      configMocks.authAssessment.allowlist = "ws-other:t-9,ws-1:other-target"
      const webTarget = {
        id: "web-1",
        type: "WEB_APP",
        url: "https://staging.example.com",
        environment: "STAGING",
        apiSpecUrl: null,
      }
      vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-1",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_1",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("SCAN_WORKFLOW_UNAVAILABLE")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects AUTHENTICATED_ASSESSMENT with a malformed allowlist — fail closed", async () => {
      configMocks.authAssessment.enabled = "1"
      configMocks.authAssessment.allowlist = "ws-1, bogus!!"
      const webTarget = {
        id: "web-1",
        type: "WEB_APP",
        url: "https://staging.example.com",
        environment: "STAGING",
        apiSpecUrl: null,
      }
      vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-1",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_1",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("SCAN_WORKFLOW_UNAVAILABLE")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects AUTHENTICATED_ASSESSMENT without an authorizationRef at the schema", async () => {
      configMocks.authAssessment.enabled = "1"
      configMocks.authAssessment.allowlist = "ws-1"

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects an authorization reference that does not resolve for the target", async () => {
      configMocks.authAssessment.enabled = "1"
      configMocks.authAssessment.allowlist = "ws-1:web-1"
      const webTarget = {
        id: "web-1",
        type: "WEB_APP",
        url: "https://staging.example.com",
        environment: "STAGING",
        apiSpecUrl: null,
      }
      vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
      vi.mocked(resolveAuthenticatedAssessmentAuthorization).mockRejectedValue(
        new LiveAiSafetyError("AUTH_ASSESSMENT_AUTH_NOT_FOUND")
      )

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-1",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_missing",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("AUTH_ASSESSMENT_AUTH_NOT_FOUND")
      expect(resolveAuthenticatedAssessmentAuthorization).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        targetId: "web-1",
        authorizationRef: "authz_missing",
      })
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects AUTHENTICATED_ASSESSMENT on a production target", async () => {
      configMocks.authAssessment.enabled = "1"
      configMocks.authAssessment.allowlist = "ws-1"
      const prodTarget = {
        id: "web-prod",
        type: "WEB_APP",
        url: "https://example.com",
        environment: "PRODUCTION",
        apiSpecUrl: null,
      }
      vi.mocked(prisma.target.findFirst).mockResolvedValue(prodTarget as never)
      vi.mocked(resolveAuthenticatedAssessmentAuthorization).mockRejectedValue(
        new LiveAiSafetyError("AUTH_ASSESSMENT_PRODUCTION_DENIED")
      )

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-prod",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_1",
        })
      )
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe("AUTH_ASSESSMENT_PRODUCTION_DENIED")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("admits the authenticated staging beta under flag + allowlist + recorded authorization", async () => {
      configMocks.authAssessment.enabled = "1"
      configMocks.authAssessment.allowlist = "ws-1:web-1"
      const webTarget = {
        id: "web-1",
        type: "WEB_APP",
        url: "https://staging.example.com",
        environment: "STAGING",
        apiSpecUrl: null,
      }
      vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
      vi.mocked(resolveAuthenticatedAssessmentAuthorization).mockResolvedValue({
        planId: "authz_1",
        credentialId: "cred-1",
      } as never)
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-beta",
        status: "QUEUED",
        goal: "TEST_APP",
        mode: "DEEP",
        targetId: "web-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-1",
          goal: "TEST_APP",
          mode: "DEEP",
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_1",
        })
      )
      expect(res.status).toBe(201)
      expect(createScan).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: "AUTHENTICATED_ASSESSMENT",
          authorizationRef: "authz_1",
        })
      )
      expect(enqueueScanJob).toHaveBeenCalledWith(expect.objectContaining({ scanId: "scan-beta" }))
    })

    it("rejects REVIEW_CHANGES on a non-repository target", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue({
        id: "web-1",
        type: "WEB_APP",
        url: "https://example.com",
        apiSpecUrl: null,
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "web-1",
          goal: "CHECK_PR",
          mode: "SAFE",
          workflow: "REVIEW_CHANGES",
          baseRef: "main",
        })
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("SCAN_PLAN_INVALID")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects REVIEW_CHANGES when the repo is not connected via the GitHub App", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue({
        ...repoTarget,
        installationId: null,
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-1",
          targetId: "repo-1",
          goal: "CHECK_PR",
          mode: "SAFE",
          workflow: "REVIEW_CHANGES",
          baseRef: "main",
        })
      )
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe("SCAN_SOURCE_UNAVAILABLE")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("resolves immutable revisions through the authorized integration before createScan", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(getBranchRefSha)
        .mockResolvedValueOnce("a".repeat(40)) // head (target.branch)
        .mockResolvedValueOnce("b".repeat(40)) // base ref
      vi.mocked(getMergeBaseSha).mockResolvedValue("c".repeat(40))
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-rc",
        status: "QUEUED",
        goal: "CHECK_PR",
        mode: "QUICK",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-rc",
          targetId: "repo-1",
          goal: "CHECK_PR",
          mode: "QUICK",
          workflow: "REVIEW_CHANGES",
          baseRef: "release/1",
        })
      )

      expect(res.status).toBe(201)
      expect(getMergeBaseSha).toHaveBeenCalledWith(
        1234,
        "acme",
        "app",
        "b".repeat(40),
        "a".repeat(40)
      )
      expect(createScan).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: "REVIEW_CHANGES",
          source: {
            revision: "a".repeat(40),
            baseRevision: "b".repeat(40),
            mergeBaseRevision: "c".repeat(40),
          },
        })
      )
    })

    it("denies REVIEW_CHANGES when refs cannot be resolved", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(getBranchRefSha).mockRejectedValue(new Error("Failed to get branch ref: 404"))

      const res = await POST(
        makeRequest({
          workspaceId: "ws-rc-fail",
          targetId: "repo-1",
          goal: "CHECK_PR",
          mode: "QUICK",
          workflow: "REVIEW_CHANGES",
          baseRef: "no-such-branch",
        })
      )

      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("SCAN_REF_UNRESOLVED")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("denies REVIEW_CHANGES when the refs share no merge base", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(getBranchRefSha)
        .mockResolvedValueOnce("a".repeat(40))
        .mockResolvedValueOnce("b".repeat(40))
      vi.mocked(getMergeBaseSha).mockResolvedValue(null)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-rc-nomb",
          targetId: "repo-1",
          goal: "CHECK_PR",
          mode: "QUICK",
          workflow: "REVIEW_CHANGES",
          baseRef: "release/1",
        })
      )

      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe("SCAN_NO_MERGE_BASE")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("resolves an explicit headRef instead of the target branch", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(getBranchRefSha)
        .mockResolvedValueOnce("e".repeat(40)) // headRef "feature/42"
        .mockResolvedValueOnce("b".repeat(40)) // baseRef
      vi.mocked(getMergeBaseSha).mockResolvedValue("c".repeat(40))
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-rc-head",
        status: "QUEUED",
        goal: "CHECK_PR",
        mode: "QUICK",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-rc-head",
          targetId: "repo-1",
          goal: "CHECK_PR",
          mode: "QUICK",
          workflow: "REVIEW_CHANGES",
          baseRef: "release/1",
          headRef: "feature/42",
        })
      )

      expect(res.status).toBe(201)
      expect(getBranchRefSha).toHaveBeenNthCalledWith(1, 1234, "acme", "app", "feature/42")
      expect(getBranchRefSha).toHaveBeenNthCalledWith(2, 1234, "acme", "app", "release/1")
      expect(createScan).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: "REVIEW_CHANGES",
          source: {
            revision: "e".repeat(40),
            baseRevision: "b".repeat(40),
            mergeBaseRevision: "c".repeat(40),
          },
        })
      )
    })

    it("passes a full-SHA headRef through without a ref lookup", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      const headSha = "f".repeat(40)
      vi.mocked(getBranchRefSha).mockResolvedValue("b".repeat(40)) // baseRef only
      vi.mocked(getMergeBaseSha).mockResolvedValue("c".repeat(40))
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-rc-sha",
        status: "QUEUED",
        goal: "CHECK_PR",
        mode: "QUICK",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-rc-sha",
          targetId: "repo-1",
          goal: "CHECK_PR",
          mode: "QUICK",
          workflow: "REVIEW_CHANGES",
          baseRef: "release/1",
          headRef: headSha,
        })
      )

      expect(res.status).toBe(201)
      // A full object ID is already immutable — no branch-ref resolution call.
      expect(getBranchRefSha).toHaveBeenCalledTimes(1)
      expect(getMergeBaseSha).toHaveBeenCalledWith(1234, "acme", "app", "b".repeat(40), headSha)
      expect(createScan).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({ revision: headSha }),
        })
      )
    })

    it("pins the head revision for a plain repo scan when resolvable", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(getBranchRefSha).mockResolvedValue("d".repeat(40))
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-pin",
        status: "QUEUED",
        goal: "TEST_APP",
        mode: "QUICK",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-pin",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "QUICK",
        })
      )

      expect(res.status).toBe(201)
      expect(getBranchRefSha).toHaveBeenCalledWith(1234, "acme", "app", "main")
      expect(createScan).toHaveBeenCalledWith(
        expect.objectContaining({ source: { revision: "d".repeat(40) } })
      )
    })

    it("still creates the scan when head pinning is unavailable", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(getBranchRefSha).mockRejectedValue(new Error("GitHub API unreachable"))
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-nopin",
        status: "QUEUED",
        goal: "TEST_APP",
        mode: "QUICK",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-nopin",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "QUICK",
        })
      )

      expect(res.status).toBe(201)
      const call = vi.mocked(createScan).mock.calls[0]![0]
      expect(call).not.toHaveProperty("source")
    })
  })

  const webTarget = {
    id: "web-1",
    name: "Example",
    type: "WEB_APP",
    url: "https://example.com",
    repoFullName: null,
    apiSpecUrl: null,
  }

  it.each(["CUSTOM"])("normalizes %s to DEEP for a URL target", async (mode) => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-web-custom",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "DEEP",
      targetId: "web-1",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "web-1",
        goal: "TEST_APP",
        mode,
      })
    )

    expect(res.status).toBe(201)
    expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ mode: "DEEP" }))
  })

  it("allows Safe and legacy Quick for a web target", async () => {
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-web",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "SAFE",
      triggerType: "manual",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      summary: null,
      errorCategory: null,
      errorMessage: null,
      targetId: "web-1",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-safe",
        targetId: "web-1",
        goal: "TEST_APP",
        mode: "QUICK",
      })
    )

    expect(res.status).toBe(201)
    expect(enqueueScanJob).toHaveBeenCalled()
  })

  it("allows STANDARD for a web target", async () => {
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-web-std",
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
      targetId: "web-1",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-safe",
        targetId: "web-1",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(res.status).toBe(201)
    expect(enqueueScanJob).toHaveBeenCalled()
  })

  it("allows DEEP for a web target", async () => {
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(createScan).mockResolvedValue({
      id: "scan-web-deep",
      status: "QUEUED",
      goal: "FULL_PENTEST",
      mode: "DEEP",
      triggerType: "manual",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      summary: null,
      errorCategory: null,
      errorMessage: null,
      targetId: "web-1",
      createdAt: new Date(),
    } as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-safe",
        targetId: "web-1",
        goal: "FULL_PENTEST",
        mode: "DEEP",
      })
    )

    expect(res.status).toBe(201)
    expect(enqueueScanJob).toHaveBeenCalled()
  })
})

describe("GET /api/scans", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultAuthMock()
  })

  it("returns 400 when workspaceId is missing", async () => {
    const res = await GET(makeGetRequest({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("MISSING_PARAM")
  })

  it("returns paginated scans", async () => {
    vi.mocked(listScans).mockResolvedValue({
      items: [scanListItem("scan-1"), scanListItem("scan-2")],
      nextCursor: "scan-2",
    } as never)

    const res = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.items).toHaveLength(2)
    expect(json.data.nextCursor).toBe("scan-2")
    // Dates are serialized to ISO strings so the polled payload matches the
    // SSR-rendered shape the client's ScanItem type expects.
    expect(json.data.items[0].createdAt).toBe("2026-07-25T10:00:00.000Z")
    expect(json.data.items[0].startedAt).toBeNull()
    expect(json.data.items[0].findingCount).toBe(0)
  })

  it("returns 304 when the client's ETag still matches the list", async () => {
    vi.mocked(listScans).mockResolvedValue({
      items: [scanListItem("scan-1")],
      nextCursor: null,
    } as never)

    const first = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    expect(first.status).toBe(200)
    const etag = first.headers.get("ETag")
    expect(etag).toBeTruthy()

    const request = new Request(`http://localhost/api/scans?workspaceId=ws-1`, {
      headers: { "if-none-match": etag! },
    })
    const second = await GET(request)
    expect(second.status).toBe(304)
    expect(second.headers.get("ETag")).toBe(etag)
  })

  it("changes the ETag when any rendered field changes, not just status", async () => {
    // The ETag hashes the whole representation. A summary or error message can
    // change while status/counts stay put; a partial hash would serve a 304 and
    // freeze stale text on screen.
    vi.mocked(listScans).mockResolvedValue({
      items: [scanListItem("scan-1")],
      nextCursor: null,
    } as never)
    const first = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    const firstEtag = first.headers.get("ETag")

    vi.mocked(listScans).mockResolvedValue({
      items: [{ ...scanListItem("scan-1"), summary: "now has a summary" }],
      nextCursor: null,
    } as never)
    const second = await GET(makeGetRequest({ workspaceId: "ws-1" }))

    expect(second.headers.get("ETag")).not.toBe(firstEtag)
  })

  it("changes the ETag when only nextCursor changes", async () => {
    vi.mocked(listScans).mockResolvedValue({
      items: [scanListItem("scan-1")],
      nextCursor: null,
    } as never)
    const firstEtag = (await GET(makeGetRequest({ workspaceId: "ws-1" }))).headers.get("ETag")

    vi.mocked(listScans).mockResolvedValue({
      items: [scanListItem("scan-1")],
      nextCursor: "scan-1",
    } as never)
    const secondEtag = (await GET(makeGetRequest({ workspaceId: "ws-1" }))).headers.get("ETag")

    expect(secondEtag).not.toBe(firstEtag)
  })

  it("passes targetId and status filters to listScans", async () => {
    vi.mocked(listScans).mockResolvedValue({ items: [], nextCursor: null } as never)

    await GET(makeGetRequest({ workspaceId: "ws-1", targetId: "t1", status: "COMPLETED" }))

    expect(listScans).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        targetId: "t1",
        status: "COMPLETED",
      })
    )
  })

  it("intersects a single legacy status with the state filter", async () => {
    vi.mocked(listScans).mockResolvedValue({ items: [], nextCursor: null } as never)

    await GET(makeGetRequest({ workspaceId: "ws-1", state: "ACTIVE", status: "RUNNING" }))

    expect(listScans).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", statuses: ["RUNNING"] })
    )
  })

  it("returns an empty page when single status and state filters cannot intersect", async () => {
    const response = await GET(
      makeGetRequest({ workspaceId: "ws-1", state: "ACTIVE", status: "COMPLETED" })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: { items: [], nextCursor: null },
    })
    expect(listScans).not.toHaveBeenCalled()
  })

  it("passes at most three validated scan IDs to the scoped list query", async () => {
    vi.mocked(listScans).mockResolvedValue({ items: [], nextCursor: null } as never)

    const response = await GET(makeGetRequest({ workspaceId: "ws-1", ids: "scan-1,scan-2,scan-3" }))

    expect(response.status).toBe(200)
    expect(listScans).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", scanIds: ["scan-1", "scan-2", "scan-3"] })
    )
  })

  it("rejects an oversized scan-ID status query", async () => {
    const response = await GET(
      makeGetRequest({ workspaceId: "ws-1", ids: "scan-1,scan-2,scan-3,scan-4" })
    )

    expect(response.status).toBe(400)
    expect(listScans).not.toHaveBeenCalled()
  })

  it("returns 403 when user lacks scan.view permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN") as never)

    const res = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    expect(res.status).toBe(403)
  })
})

describe("FREE-plan URL scan per-IP limit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultAuthMock()
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(enqueueScanJob).mockResolvedValue("job-1")
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({ id: "default-policy" } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "FREE" } as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0 as never)
    vi.mocked(checkFreeUrlScanRateLimit).mockResolvedValue({
      limited: false,
      remaining: 3,
      retryAfter: 0,
    } as never)
  })

  const freeScanBody = {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "TEST_APP",
    mode: "SAFE",
  }

  it("429s and never creates the scan when the free URL limit is exhausted", async () => {
    vi.mocked(checkFreeUrlScanRateLimit).mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfter: 1800,
    } as never)
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://example.com",
      apiSpecUrl: null,
    } as never)

    const response = await POST(makeRequest(freeScanBody))
    const body = (await response.json()) as { error?: { code?: string } }

    expect(response.status).toBe(429)
    expect(body.error?.code).toBe("FREE_URL_SCAN_RATE_LIMITED")
    expect(response.headers.get("Retry-After")).toBe("1800")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("checks the limit by client IP for FREE-plan URL targets", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://example.com",
      apiSpecUrl: null,
    } as never)

    await POST(makeRequest(freeScanBody))

    expect(checkFreeUrlScanRateLimit).toHaveBeenCalledWith("203.0.113.9")
  })

  it("does not apply the free limit to paid plans (domain verification governs instead)", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://example.com",
      apiSpecUrl: null,
    } as never)
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ plan: "PRO" } as never)

    await POST(makeRequest(freeScanBody))

    expect(checkFreeUrlScanRateLimit).not.toHaveBeenCalled()
  })

  describe("scan attachments", () => {
    const repoTarget = {
      id: "repo-1",
      type: "REPO",
      installationId: "1234",
      repoOwner: "acme",
      repoName: "app",
      repoFullName: "acme/app",
      branch: "main",
    }

    it("passes validated attachmentIds into createScan", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(resolveScanAttachments).mockResolvedValue([{ id: "att-1" }] as never)
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-att",
        status: "QUEUED",
        goal: "TEST_APP",
        mode: "STANDARD",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-att",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "STANDARD",
          attachmentIds: ["att-1"],
        })
      )

      expect(res.status).toBe(201)
      expect(resolveScanAttachments).toHaveBeenCalledWith("ws-att", ["att-1"])
      expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["att-1"] }))
    })

    it("rejects a cross-workspace or unknown attachment id", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(resolveScanAttachments).mockRejectedValue(
        new ScanAttachmentError("SCAN_ATTACHMENT_NOT_FOUND", "not found") as never
      )

      const res = await POST(
        makeRequest({
          workspaceId: "ws-att-x",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "STANDARD",
          attachmentIds: ["att-foreign"],
        })
      )

      expect(res.status).toBe(404)
      expect((await res.json()).error.code).toBe("SCAN_ATTACHMENT_NOT_FOUND")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects a deleted or stale attachment", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(resolveScanAttachments).mockRejectedValue(
        new ScanAttachmentError("SCAN_ATTACHMENT_UNAVAILABLE", "deleted") as never
      )

      const res = await POST(
        makeRequest({
          workspaceId: "ws-att-del",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "STANDARD",
          attachmentIds: ["att-deleted"],
        })
      )

      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("SCAN_ATTACHMENT_UNAVAILABLE")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("rejects more attachment IDs than the plan cap", async () => {
      const ids = Array.from({ length: 21 }, (_, i) => `att-${i}`)
      const res = await POST(
        makeRequest({
          workspaceId: "ws-att-many",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "STANDARD",
          attachmentIds: ids,
        })
      )

      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
      expect(createScan).not.toHaveBeenCalled()
    })

    it("deduplicates attachment IDs before recording them on the plan", async () => {
      vi.mocked(prisma.target.findFirst).mockResolvedValue(repoTarget as never)
      vi.mocked(resolveScanAttachments).mockResolvedValue([{ id: "att-1" }] as never)
      vi.mocked(createScan).mockResolvedValue({
        id: "scan-att-dup",
        status: "QUEUED",
        goal: "TEST_APP",
        mode: "STANDARD",
        targetId: "repo-1",
        createdAt: new Date(),
      } as never)

      const res = await POST(
        makeRequest({
          workspaceId: "ws-att-dup",
          targetId: "repo-1",
          goal: "TEST_APP",
          mode: "STANDARD",
          attachmentIds: ["att-1", "att-1"],
        })
      )

      expect(res.status).toBe(201)
      expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["att-1"] }))
    })
  })
})
