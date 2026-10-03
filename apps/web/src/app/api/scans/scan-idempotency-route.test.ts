import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

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
  claimOrGetAgentOperation: vi.fn(),
  completeAgentOperation: vi.fn(),
  failAgentOperation: vi.fn().mockResolvedValue({}),
  toJsonObject: (value: object) => JSON.parse(JSON.stringify(value)),
  createScan: vi.fn(),
  listScans: vi.fn(),
  updateScanStatus: vi.fn(),
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

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

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
}))

import { POST } from "./route"
import {
  prisma,
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
  createScan,
  WorkspaceScanConcurrencyLimitError,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { ScanExecutionPlanInputError } from "@lyrashield/types"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../lib/queue"
import { checkScanCreateRateLimit } from "../../../lib/rate-limit"
import { assertScanAllowed } from "@lyrashield/billing"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function defaultAuthMock() {
  vi.mocked(requirePermission).mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  } as never)
}

describe("scan operation route regressions", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(failAgentOperation).mockResolvedValue({} as never)
    defaultAuthMock()
    vi.mocked(checkScanCreateRateLimit).mockResolvedValue({
      limited: false,
      remaining: 5,
      retryAfter: 0,
    })
    vi.mocked(prisma.target.findFirst).mockResolvedValue({ id: "t1", type: "REPO" } as never)
    vi.mocked(prisma.policy.findFirst).mockImplementation((async (args: {
      where?: { id?: string }
    }) => {
      const policy = { id: args?.where?.id ?? "policy-a" }
      return policy as never
    }) as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(0)
    vi.mocked(assertScanAllowed).mockResolvedValue({ allowed: true } as never)
    vi.mocked(createScan).mockResolvedValue({ id: "new-scan", createdAt: new Date() } as never)
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op-1" },
    } as never)
  })
  function request(policyId = "policy-a") {
    const req = makeRequest({
      workspaceId: "ws-1",
      targetId: "t1",
      goal: "TEST_APP",
      mode: "SAFE",
      policyId,
    })
    req.headers.set("Idempotency-Key", "review-probe")
    return req
  }
  it("never executes a failed claim again", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "FAILED",
      operation: { id: "op-1" },
    } as never)
    const res = await POST(request())
    expect(res.status).toBe(409)
    expect(createScan).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
    expect(completeAgentOperation).not.toHaveBeenCalled()
  })
  it("checks current delegated scope before replay", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "REPLAY",
      operation: { id: "op-1", resultReference: "old-scan" },
    } as never)
    vi.mocked(assertOAuthDelegatedScope).mockImplementation(() => {
      throw new Error("FORBIDDEN")
    })
    const res = await POST(request())
    expect(res.status).toBe(403)
    expect(assertOAuthDelegatedScope).toHaveBeenCalledOnce()
    expect(prisma.target.findFirst).toHaveBeenCalledOnce()
  })
  it("does not claim a rejected target", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null)
    const res = await POST(request())
    expect(res.status).toBe(404)
    expect((await res.json()).error.details.operationOutcome).toBe("OPERATION_NOT_SUBMITTED")
    expect(claimOrGetAgentOperation).not.toHaveBeenCalled()
    expect(failAgentOperation).not.toHaveBeenCalled()
    expect(completeAgentOperation).not.toHaveBeenCalled()
  })
  it("records a concurrency refusal as not submitted and exposes that outcome", async () => {
    vi.mocked(createScan).mockRejectedValue(new WorkspaceScanConcurrencyLimitError() as never)

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect((await res.json()).error.details).toMatchObject({
      operationOutcome: "OPERATION_NOT_SUBMITTED",
      refusal: { reason: "concurrency_limit" },
    })
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_NOT_SUBMITTED" })
    )
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })
  it.each([
    [
      "duplicate active scan",
      Object.assign(new Error("unique target scan"), { code: "P2002" }),
      "scan_in_progress",
      409,
    ],
    [
      "target removed before creation",
      new Error("Target not found in this workspace"),
      "target_not_found",
      404,
    ],
    [
      "invalid execution plan",
      new ScanExecutionPlanInputError("Plan inputs are invalid"),
      "plan_invalid",
      400,
    ],
  ])("marks %s as not submitted", async (_label, rejection, reason, expectedStatus) => {
    vi.mocked(createScan).mockRejectedValue(rejection as never)

    const res = await POST(request())

    expect(res.status).toBe(expectedStatus)
    expect((await res.json()).error.details).toMatchObject({
      operationOutcome: "OPERATION_NOT_SUBMITTED",
      refusal: { reason },
    })
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_NOT_SUBMITTED" })
    )
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })
  it("marks a rate-limit refusal as not submitted", async () => {
    vi.mocked(checkScanCreateRateLimit).mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfter: 10,
    } as never)

    const res = await POST(request())

    expect(res.status).toBe(429)
    expect((await res.json()).error.details).toMatchObject({
      operationOutcome: "OPERATION_NOT_SUBMITTED",
      refusal: { reason: "rate_limited" },
    })
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_NOT_SUBMITTED" })
    )
  })
  it("marks an unavailable worker refusal as not submitted", async () => {
    vi.mocked(assertScanWorkerAvailable).mockRejectedValue(new ScanWorkerUnavailableError())

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect((await res.json()).error.details).toMatchObject({
      operationOutcome: "OPERATION_NOT_SUBMITTED",
      refusal: { reason: "worker_unavailable" },
    })
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_NOT_SUBMITTED" })
    )
  })
  it("keeps an enqueue failure recoverable and does not claim it was not submitted", async () => {
    vi.mocked(enqueueScanJob).mockRejectedValueOnce(new Error("queue unavailable"))

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect((await res.json()).error.details?.operationOutcome).toBeUndefined()
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_OUTCOME_UNKNOWN", resultReference: "new-scan" })
    )
  })
  it("keeps an ambiguous scan creation failure recoverable", async () => {
    vi.mocked(createScan).mockRejectedValueOnce(new Error("database connection lost") as never)

    const res = await POST(request())

    expect(res.status).toBe(500)
    expect((await res.json()).error.details?.operationOutcome).toBeUndefined()
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_OUTCOME_UNKNOWN" })
    )
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })
  it("binds the selected policy to operation input", async () => {
    await POST(request("policy-a"))
    await POST(request("policy-b"))
    const calls = vi.mocked(claimOrGetAgentOperation).mock.calls
    expect(calls[0]?.[0].input).not.toEqual(calls[1]?.[0].input)
    expect(calls[0]?.[0].input).toHaveProperty("policyId", "policy-a")
  })
  it("binds workflow inputs to operation input", async () => {
    const plain = request()
    const reviewChanges = makeRequest({
      workspaceId: "ws-1",
      targetId: "t1",
      goal: "TEST_APP",
      mode: "SAFE",
      policyId: "policy-a",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
    })
    reviewChanges.headers.set("Idempotency-Key", "review-probe")
    // REVIEW_CHANGES on this target short-circuits after the claim (no
    // GitHub-connected repo) — the claim input binding is what we assert.
    vi.mocked(failAgentOperation).mockResolvedValue({} as never)
    await POST(plain)
    await POST(reviewChanges)
    const calls = vi.mocked(claimOrGetAgentOperation).mock.calls
    expect(calls[0]?.[0].input).not.toEqual(calls[1]?.[0].input)
    expect(calls[1]?.[0].input).toMatchObject({
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
    })
  })
})
