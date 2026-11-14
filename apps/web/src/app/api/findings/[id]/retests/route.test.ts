import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

const getFindingReference = vi.fn()
const createScan = vi.fn()
const requirePermission = vi.fn()
const enqueueScanJob = vi.fn()
const assertScanWorkerAvailable = vi.fn()
const updateScanStatus = vi.fn()
const assertScanAllowed = vi.fn()
const findCurrentDomainProof = vi.fn()
const isTargetRelayWorkerAvailable = vi.hoisted(() => vi.fn())
const resolveRepositoryScanSource = vi.hoisted(() => vi.fn())
const claimOrGetAgentOperation = vi.fn()
const completeAgentOperation = vi.fn()
const failAgentOperation = vi.fn()
const checkFreeUrlScanRateLimit = vi.fn()
const checkScanCreateRateLimit = vi.fn()
const clientIpFromRequest = vi.fn()
class ScanWorkerUnavailableError extends Error {}
class WorkspaceScanConcurrencyLimitError extends Error {}
const prisma = {
  scan: { findFirst: vi.fn(), update: vi.fn() },
  findingCandidate: { findMany: vi.fn() },
  retest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  target: { findFirst: vi.fn() },
}

vi.mock("@lyrashield/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/integrations")>()),
  isTargetRelayWorkerAvailable,
  resolveRepositoryScanSource,
}))

vi.mock("@lyrashield/db", () => ({
  UserScanAlreadyActiveError: class UserScanAlreadyActiveError extends Error {
    readonly code = "SCAN_ALREADY_ACTIVE"
  },
  releaseUnstartedScanSlot: vi.fn().mockResolvedValue(undefined),

  findCurrentDomainProof,
  getFindingReference,
  createScan,
  updateScanStatus,
  WorkspaceScanConcurrencyLimitError,
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
  toJsonObject: (value: object) => JSON.parse(JSON.stringify(value)),
  prisma,
  withDelegatedReadAuthority: async (
    _params: unknown,
    run: (tx: unknown, authority: { targetId: string; allowedProfiles: string[] }) => unknown
  ) =>
    run(
      {
        scan: { findFirst: prisma.scan.findFirst },
        retest: { create: prisma.retest.create },
      },
      { targetId: "target-1", allowedProfiles: ["SAFE"] }
    ),
}))
vi.mock("@lyrashield/billing", () => ({
  assertScanAllowed,
  resolveWorkspaceScanSponsor: vi.fn(async (_workspaceId: string, actorId: string) => ({
    accountId: actorId,
    agency: false,
    agencyActive: false,
  })),
  resolveAccountBilling: vi.fn(async () => ({ effectivePlan: "FREE", currentPlan: "FREE" })),
}))
vi.mock("@lyrashield/auth/server", () => ({
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission,
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { retest: { create: "retest:create" } } }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))
vi.mock("@/lib/delegated-target-read-scope", () => ({
  delegatedReadPrincipal: (session: {
    userId?: string
    oauth?: { connectionId?: string; authorizationVersion?: number }
  }) =>
    session.oauth?.connectionId
      ? {
          workspaceId: "workspace-1",
          userId: session.userId ?? "user-1",
          memberId: "member-1",
          memberRole: "OWNER",
          memberUpdatedAt: new Date("2026-11-05T10:00:00Z"),
          connectionId: session.oauth.connectionId,
          authorizationVersion: session.oauth.authorizationVersion ?? 2,
        }
      : null,
  resolveDelegatedTargetReadScope: vi.fn().mockResolvedValue({}),
}))
vi.mock("../../../../../lib/queue", () => ({
  enqueueScanJob,
  assertScanWorkerAvailable,
  ScanWorkerUnavailableError,
}))
vi.mock("../../../../../lib/rate-limit", () => ({
  checkFreeUrlScanRateLimit,
  checkScanCreateRateLimit,
  clientIpFromRequest,
}))

const { POST } = await import("./route")

describe("POST /api/findings/[id]/retests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTargetRelayWorkerAvailable.mockResolvedValue(true)
    resolveRepositoryScanSource.mockImplementation(async (target) =>
      target.type === "REPO" ? { revision: "b".repeat(40) } : undefined
    )
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    getFindingReference.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      scanId: "source-scan",
      scan: { mode: "SAFE" },
    })
    prisma.scan.findFirst.mockResolvedValue({
      id: "source-scan",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "SAFE",
      policyId: null,
    })
    prisma.retest.findFirst.mockResolvedValue(null)
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "engine" }])
    createScan.mockResolvedValue({ id: "retest-scan", status: "QUEUED" })
    completeAgentOperation.mockResolvedValue({})
    failAgentOperation.mockResolvedValue({})
    prisma.retest.create.mockResolvedValue({
      id: "retest-1",
      scanId: "retest-scan",
      status: "pending",
    })
    enqueueScanJob.mockResolvedValue("job-1")
    assertScanWorkerAvailable.mockResolvedValue(undefined)
    assertScanAllowed.mockResolvedValue({
      allowed: true,
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 10,
    })
    findCurrentDomainProof.mockResolvedValue({ domain: "api.example.com", verified: false })
    checkFreeUrlScanRateLimit.mockResolvedValue({ limited: false, retryAfter: 0 })
    checkScanCreateRateLimit.mockResolvedValue({ limited: false, retryAfter: 0 })
    clientIpFromRequest.mockReturnValue("203.0.113.8")
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "REPO",
      url: null,
      apiSpecUrl: null,
    })
  })

  it("pins the trusted current repository source before creating a retest plan", async () => {
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", revision: "attacker-sha" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(201)
    expect(resolveRepositoryScanSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "target-1", type: "REPO" }),
      expect.objectContaining({ readActiveConnection: expect.any(Function) })
    )
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({ source: { revision: "b".repeat(40) } })
    )
    expect(resolveRepositoryScanSource.mock.invocationCallOrder[0]).toBeLessThan(
      createScan.mock.invocationCallOrder[0]!
    )
  })

  it("leaves a retest unsubmitted when the trusted current source cannot be resolved", async () => {
    resolveRepositoryScanSource.mockRejectedValueOnce(new Error("provider unavailable"))
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(409)
    expect(createScan).not.toHaveBeenCalled()
    expect(prisma.retest.create).not.toHaveBeenCalled()
  })

  it("queues a fresh scan from server-owned source-scan configuration", async () => {
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          scanId: "attacker-selected-scan",
          createdById: "attacker-selected-user",
        }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(201)
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
        triggerType: "retest",
        createdById: "user-1",
      })
    )
    expect(enqueueScanJob).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: "retest-scan", targetId: "target-1" })
    )
    expect(prisma.retest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scanId: "retest-scan" }) })
    )
  })

  it("binds a recorded delegated retest to its outer operation and nested scan", async () => {
    requirePermission.mockResolvedValueOnce({
      session: {
        userId: "user-1",
        oauth: { connectionId: "conn-1", authorizationVersion: 3 },
      },
      workspace: {
        id: "workspace-1",
        member: { id: "member-1", role: "OWNER", updatedAt: new Date() },
      },
    })
    claimOrGetAgentOperation.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "retest-op" },
      admissionProof: "server-proof",
    })

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "retest-key",
        },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(201)
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({
        delegatedConnection: { connectionId: "conn-1", authorizationVersion: 3 },
        delegatedOperation: {
          operationId: "retest-op",
          operationName: "retest.create",
          admissionProof: "server-proof",
          connectionId: "conn-1",
          authorizationVersion: 3,
        },
      }),
      expect.any(Object)
    )
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "retest.create",
        idempotencyKey: "retest-key",
        connectionId: "conn-1",
        authorizationVersion: 3,
      })
    )
    expect(completeAgentOperation).toHaveBeenCalledWith(
      "retest-op",
      "workspace-1",
      expect.objectContaining({ resultReference: "retest-scan" })
    )
  })

  it("returns an opaque user-slot conflict without creating or enqueueing a retest", async () => {
    const { UserScanAlreadyActiveError } = await import("@lyrashield/db")
    createScan.mockRejectedValueOnce(new UserScanAlreadyActiveError())
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe("SCAN_ALREADY_ACTIVE")
    expect(body.error.details).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("source-scan")
    expect(prisma.retest.create).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("fails the retest record when queue submission fails", async () => {
    enqueueScanJob.mockRejectedValue(new Error("Redis unavailable"))

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(503)
    expect(updateScanStatus).toHaveBeenCalledWith(
      "retest-scan",
      "FAILED",
      expect.objectContaining({ errorCategory: "QUEUE" })
    )
    expect(prisma.retest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error" }) })
    )
  })

  it("does not create a retest when no worker is available", async () => {
    assertScanWorkerAvailable.mockRejectedValue(new ScanWorkerUnavailableError())

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("SCAN_SERVICE_UNAVAILABLE")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("refuses an expired-trial deterministic retest before creating any records", async () => {
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "url" }])
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })
    assertScanAllowed.mockResolvedValue({
      allowed: false,
      code: "TRIAL_EXPIRED",
      message: "Your trial has expired. Upgrade to continue scanning.",
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 0,
    })

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("TRIAL_EXPIRED")
    expect(createScan).not.toHaveBeenCalled()
    expect(prisma.retest.create).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("returns RETEST_UNAVAILABLE for a removed engine-backed URL source scan", async () => {
    prisma.scan.findFirst.mockResolvedValue({
      id: "source-scan",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      policyId: null,
    })
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "engine" }])
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("RETEST_UNAVAILABLE")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("keeps deterministic URL retests available without a live relay", async () => {
    prisma.scan.findFirst.mockResolvedValue({
      id: "source-scan",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      policyId: null,
    })
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "url" }])
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })
    isTargetRelayWorkerAvailable.mockResolvedValue(false)
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(201)
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({ determinismMode: "targeted_scanner", mode: "SAFE" })
    )
    expect(isTargetRelayWorkerAvailable).not.toHaveBeenCalled()
  })

  it("does not consult domain proof for a removed engine-backed URL retest", async () => {
    prisma.scan.findFirst.mockResolvedValue({
      id: "source-scan",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      policyId: null,
    })
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "engine" }])
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("RETEST_UNAVAILABLE")
    expect(createScan).not.toHaveBeenCalled()
    expect(findCurrentDomainProof).not.toHaveBeenCalled()
  })

  it("applies the existing free deterministic URL limit and Retry-After", async () => {
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "url" }])
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })
    checkFreeUrlScanRateLimit.mockResolvedValue({ limited: true, retryAfter: 23 })

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("23")
    expect((await response.json()).error.code).toBe("FREE_URL_SCAN_RATE_LIMITED")
    expect(clientIpFromRequest).toHaveBeenCalledWith(expect.any(Request))
    expect(createScan).not.toHaveBeenCalled()
  })

  it("applies the shared workspace create limit before retest persistence", async () => {
    checkScanCreateRateLimit.mockResolvedValue({ limited: true, retryAfter: 7 })

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("7")
    expect((await response.json()).error.code).toBe("SCAN_RATE_LIMITED")
    expect(createScan).not.toHaveBeenCalled()
    expect(prisma.retest.create).not.toHaveBeenCalled()
  })

  it("returns API_SPEC_REQUIRED when the target no longer supports the source mode", async () => {
    prisma.scan.findFirst.mockResolvedValue({
      id: "source-scan",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      policyId: null,
    })
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "API",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })
    prisma.findingCandidate.findMany.mockResolvedValue([{ scannerSource: "engine" }])

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("API_SPEC_REQUIRED")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("reports an active target scan as an in-progress retest", async () => {
    createScan.mockRejectedValue(new Error("Target already has an active scan"))

    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(409)
    expect(prisma.retest.create).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })
})
