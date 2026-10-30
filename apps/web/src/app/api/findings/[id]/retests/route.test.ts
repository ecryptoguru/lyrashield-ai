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
  prisma,
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
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    getFindingReference.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      scanId: "source-scan",
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

  it("queues a fresh scan from server-owned source-scan configuration", async () => {
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1", scanId: "attacker-selected-scan" }),
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
      })
    )
    expect(enqueueScanJob).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: "retest-scan", targetId: "target-1" })
    )
    expect(prisma.retest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scanId: "retest-scan" }) })
    )
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

  it("rejects engine-backed URL retests before creating work when the relay is unavailable", async () => {
    prisma.scan.findFirst.mockResolvedValue({
      id: "source-scan",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      policyId: null,
    })
    prisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://api.example.com",
      apiSpecUrl: null,
    })
    findCurrentDomainProof.mockResolvedValue({ domain: "api.example.com", verified: true })
    isTargetRelayWorkerAvailable.mockResolvedValue(false)
    const response = await POST(
      new Request("http://localhost/api/findings/finding-1/retests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("TARGET_RELAY_UNAVAILABLE")
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

  it("requires current domain proof for an engine-backed URL retest", async () => {
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

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(createScan).not.toHaveBeenCalled()
    expect(findCurrentDomainProof).toHaveBeenCalledWith("workspace-1", "https://api.example.com")
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
