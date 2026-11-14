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
  UserScanAlreadyActiveError: class UserScanAlreadyActiveError extends Error {
    readonly code = "SCAN_ALREADY_ACTIVE"
  },
  releaseUnstartedScanSlot: vi.fn().mockResolvedValue(undefined),

  WorkspaceScanConcurrencyLimitError: class WorkspaceScanConcurrencyLimitError extends Error {},
  prisma: {
    target: { findFirst: vi.fn() },
    integration: { findFirst: vi.fn() },
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
  resolveRepositoryScanSource: vi.fn(),
}))

vi.mock("@lyrashield/billing", () => ({
  assertScanAllowed: vi.fn().mockResolvedValue({ allowed: true }),
  assertTargetAllowed: vi.fn().mockResolvedValue({ allowed: true }),
}))

import { createScan as createScanInTransaction } from "@lyrashield/db/src/scan-service"
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
import {
  getBranchRefSha,
  getDefaultBranch,
  getMergeBaseSha,
  resolveRepositoryScanSource,
} from "@lyrashield/integrations"

const repositoryTarget = {
  id: "t1",
  workspaceId: "ws-1",
  type: "REPO",
  installationId: "1234",
  repoOwner: "fixture",
  repoName: "app",
  repoFullName: "fixture/app",
  branch: "main",
}
const repositoryRevision = "a".repeat(40)

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
    vi.mocked(prisma.target.findFirst).mockResolvedValue(repositoryTarget as never)
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: "connection-1",
      workspaceId: "ws-1",
      type: "GITHUB",
      externalId: "1234",
      status: "active",
      deletedAt: null,
    } as never)
    vi.mocked(resolveRepositoryScanSource).mockImplementation(async (_target, options) => {
      await options.readActiveConnection()
      return { revision: repositoryRevision }
    })
    vi.mocked(getBranchRefSha).mockResolvedValue(repositoryRevision)
    vi.mocked(getDefaultBranch).mockResolvedValue("main")
    vi.mocked(getMergeBaseSha).mockResolvedValue(repositoryRevision)
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
    // Delegated denial happens before the target lookup so an out-of-grant
    // target is never probed and no operation is claimed.
    expect(prisma.target.findFirst).not.toHaveBeenCalled()
    expect(claimOrGetAgentOperation).not.toHaveBeenCalled()
    expect(createScan).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
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
  function requestWithPolicy(policyId?: string) {
    const req = makeRequest({
      workspaceId: "ws-1",
      targetId: "t1",
      goal: "TEST_APP",
      mode: "SAFE",
      policyId,
      engineBudgetCeilingUsd: 1,
    })
    req.headers.set("Idempotency-Key", "default-race")
    return req
  }

  function useAdmissionTransaction(id: string, limit: number) {
    const tx = {
      $executeRaw: vi.fn(),
      userScanSlot: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      scanCapacityReservation: { create: vi.fn() },
      target: { findFirst: vi.fn().mockResolvedValue(repositoryTarget) },
      workspace: { findUnique: vi.fn().mockResolvedValue({ agencySponsorAccountId: null }) },
      policy: {
        findFirst: vi.fn().mockResolvedValue({ id, maxBudgetUsd: { toNumber: () => limit } }),
      },
      scan: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: "scan", createdAt: new Date() }),
      },
      scanEvent: { create: vi.fn() },
    }
    vi.mocked(createScan).mockImplementationOnce((params) =>
      createScanInTransaction(params, tx as never)
    )
    return tx
  }

  it.each([undefined, ""])(
    "refuses a newly active zero default for policyId %j without creating or enqueuing a scan",
    async (policyId) => {
      vi.mocked(prisma.policy.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "new" } as never)
      const tx = useAdmissionTransaction("new", 0)
      vi.mocked(claimOrGetAgentOperation)
        .mockResolvedValueOnce({ status: "NEW", operation: { id: "op" } } as never)
        .mockResolvedValueOnce({ status: "CONFLICT", message: "Changed policy" } as never)
      const refusal = await POST(requestWithPolicy(policyId))
      expect(refusal.status).toBe(400)
      expect((await refusal.json()).error).toMatchObject({
        code: "SCAN_PLAN_INVALID",
        message: expect.stringContaining("default scan policy changed"),
        details: { operationOutcome: "OPERATION_NOT_SUBMITTED" },
      })
      expect(tx.policy.findFirst).toHaveBeenCalledOnce()
      expect(tx.scan.create).not.toHaveBeenCalled()
      expect((await POST(requestWithPolicy(policyId))).status).toBe(409)
      expect(
        vi.mocked(claimOrGetAgentOperation).mock.calls.map(([claim]) => claim.input)
      ).toMatchObject([{ policyId: null }, { policyId: "new" }])
      expect(createScan).toHaveBeenCalledOnce()
      expect(enqueueScanJob).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, "", "selected"])(
    "binds a stable policy for policyId %j through claim, admission and queue",
    async (policyId) => {
      const id = policyId || "default"
      vi.mocked(prisma.policy.findFirst).mockResolvedValueOnce({ id } as never)
      const tx = useAdmissionTransaction(id, 0.75)
      const result = await POST(requestWithPolicy(policyId))
      expect(result.status).toBe(201)
      const where = {
        workspaceId: "ws-1",
        deletedAt: null,
        ...(policyId ? { id } : { name: "Default Policy" }),
      }
      expect(prisma.policy.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where }))
      expect(tx.policy.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where }))
      expect(vi.mocked(claimOrGetAgentOperation).mock.calls[0]?.[0].input).toMatchObject({
        policyId: id,
      })
      expect(tx.scan.create.mock.calls[0]?.[0]).toMatchObject({
        data: { policyId: id, executionPlan: { limits: { maxBudgetUsd: 0.75 } } },
      })
      expect(enqueueScanJob).toHaveBeenCalledWith(
        expect.objectContaining({ scanId: "scan", policyId: id })
      )
    }
  )

  it("binds the selected policy to operation input", async () => {
    await POST(request("policy-a"))
    await POST(request("policy-b"))
    const calls = vi.mocked(claimOrGetAgentOperation).mock.calls
    expect(calls[0]?.[0].input).not.toEqual(calls[1]?.[0].input)
    expect(calls[0]?.[0].input).toHaveProperty("policyId", "policy-a")
  })
  it("binds the requested engine ceiling to admission and operation identity, never queue authority", async () => {
    let admittedInput: string | undefined
    vi.mocked(claimOrGetAgentOperation).mockImplementation(async ({ input }) => {
      const identity = JSON.stringify(input)
      if (!admittedInput) {
        admittedInput = identity
        const claim = { status: "NEW", operation: { id: "op-1" } }
        return claim as never
      }
      const result =
        identity === admittedInput
          ? {
              status: "REPLAY",
              operation: { id: "op-1", result: { id: "new-scan" }, resultReference: "new-scan" },
            }
          : { status: "CONFLICT", message: "Request changed" }
      return result as never
    })
    const statuses: number[] = []
    for (const amount of [1, 1, 0.5]) {
      const req = makeRequest({
        workspaceId: "ws-1",
        targetId: "t1",
        goal: "TEST_APP",
        mode: "SAFE",
        engineBudgetCeilingUsd: amount,
      })
      req.headers.set("Idempotency-Key", "same-request")
      statuses.push((await POST(req)).status)
    }
    expect(statuses).toEqual([201, 200, 409])
    expect(createScan).toHaveBeenCalledOnce()
    expect(enqueueScanJob).toHaveBeenCalledOnce()
    const claims = vi.mocked(claimOrGetAgentOperation).mock.calls.map(([claim]) => claim.input)
    expect(claims[0]).toMatchObject({ engineBudgetCeilingUsd: 1 })
    expect(claims[1]).toEqual(claims[0])
    expect(claims[2]).not.toEqual(claims[0])
    expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ engineBudgetCeilingUsd: 1 }))
    for (const [job] of vi.mocked(enqueueScanJob).mock.calls)
      expect(job).not.toHaveProperty("engineBudgetCeilingUsd")
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
    vi.mocked(failAgentOperation).mockResolvedValue({} as never)
    expect((await POST(plain)).status).toBe(201)
    expect((await POST(reviewChanges)).status).toBe(201)
    const calls = vi.mocked(claimOrGetAgentOperation).mock.calls
    expect(calls[0]?.[0].input).not.toEqual(calls[1]?.[0].input)
    expect(calls[1]?.[0].input).toMatchObject({
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
    })
  })
})
