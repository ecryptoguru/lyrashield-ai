import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyWebhookSignature = vi.fn()
const tx = {
  webhookEvent: { create: vi.fn() },
  integration: { update: vi.fn() },
  target: { updateMany: vi.fn() },
}
const systemPrisma = {
  webhookEvent: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  integration: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}
const prisma = { auditLog: { create: vi.fn() } }
const handleMerged = vi.fn()
const assertScanAllowed = vi.fn()
const assertScanWorkerAvailable = vi.fn()
const enqueueScanJob = vi.fn()
const recordDeferredLoopClosure = vi.fn()
const completeLoopClosure = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => systemPrisma,
  prisma,
  handleFixPrMergedAndReevaluate: handleMerged,
  recordDeferredLoopClosure: vi.fn(() => Promise.resolve()),
  completeLoopClosure: vi.fn(() => Promise.resolve()),
  classifyLoopClosureError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "NO_MINUTES_REMAINING") return "RETEST_NOT_ENTITLED"
    if (message === "worker outage") return "WORKER_UNAVAILABLE"
    return "UNEXPECTED_ERROR"
  },
}))
vi.mock("@lyrashield/billing", () => ({ assertScanAllowed }))
vi.mock("@/lib/queue", () => ({ assertScanWorkerAvailable, enqueueScanJob }))
vi.mock("@lyrashield/integrations", () => ({
  verifyWebhookSignature,
  // The route imports enqueueScanJob via @/lib/queue, which re-exports
  // `enqueueScan` AS `enqueueScanJob` from this package — so the mock must
  // define the ORIGINAL export name.
  enqueueScan: vi.fn(async () => "queued-job-id"),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { POST } = await import("./route")

function installationDeletedRequest() {
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": "sha256=valid",
      "x-github-event": "installation",
      "x-github-delivery": "delivery-1",
    },
    body: JSON.stringify({
      action: "deleted",
      installation: { id: 42, account: { login: "acme" } },
    }),
  })
}

describe("GitHub installation webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyWebhookSignature.mockReturnValue(true)
    systemPrisma.webhookEvent.findUnique.mockResolvedValue(null)
    systemPrisma.integration.findFirst.mockResolvedValue({
      id: "integration-1",
      workspaceId: "workspace-1",
    })
    systemPrisma.$transaction.mockImplementation(async (callback) => callback(tx))
  })
  it("returns 500 and clears the delivery marker when automatic retest delivery fails", async () => {
    handleMerged.mockRejectedValueOnce(new Error("deferred"))
    systemPrisma.webhookEvent.deleteMany.mockResolvedValue({ count: 1 })
    const response = await POST(
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "pull_request",
          "x-github-delivery": "retry-1",
        },
        body: JSON.stringify({
          action: "closed",
          installation: { id: 42 },
          repository: { full_name: "test/repo", id: 1 },
          pull_request: {
            number: 1,
            merged: true,
            head: { ref: "lyrashield/fix-test" },
            base: { ref: "main" },
          },
        }),
      }) as never
    )
    expect(response.status).toBe(500)
    expect(systemPrisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { provider: "github", externalId: "retry-1" },
    })
  })

  it("records the delivery atomically before disconnecting an installation", async () => {
    const response = await POST(installationDeletedRequest() as never)

    expect(response.status).toBe(200)
    expect(tx.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-1",
          externalId: "delivery-1",
          eventType: "installation.deleted",
        }),
      })
    )
    expect(tx.integration.update).toHaveBeenCalled()
    expect(tx.target.updateMany).toHaveBeenCalled()
    expect(prisma.auditLog.create).toHaveBeenCalled()
  })

  it("treats a concurrent delivery as an idempotent success", async () => {
    systemPrisma.$transaction.mockRejectedValue({ code: "P2002" })

    const response = await POST(installationDeletedRequest() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { duplicate: true } })
  })

  it("removes the delivery marker and retries when audit retention fails", async () => {
    prisma.auditLog.create.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await POST(installationDeletedRequest() as never)

    expect(response.status).toBe(500)
    expect(systemPrisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { provider: "github", externalId: "delivery-1" },
    })
  })

  it("rejects a signed malformed pull request payload without retrying", async () => {
    const request = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=valid",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-2",
      },
      body: JSON.stringify({ action: "opened" }),
    })

    const response = await POST(request as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_PAYLOAD" } })
    expect(systemPrisma.webhookEvent.findUnique).toHaveBeenCalled()
    expect(systemPrisma.$transaction).not.toHaveBeenCalled()
  })
})

function pullRequestRequest(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": "sha256=valid",
      "x-github-event": "pull_request",
      "x-github-delivery": "merge-1",
    },
    body: JSON.stringify({
      action: "closed",
      installation: { id: 42 },
      repository: { full_name: "test/repo", id: 1 },
      pull_request: {
        number: 7,
        merged: true,
        head: { ref: "lyrashield/fix-finding-1" },
        base: { ref: "main" },
        ...overrides,
      },
    }),
  })
}

describe("GitHub fix-PR merge loop closure (W3-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyWebhookSignature.mockReturnValue(true)
    systemPrisma.webhookEvent.findUnique.mockResolvedValue(null)
    systemPrisma.integration.findFirst.mockResolvedValue({
      id: "integration-1",
      workspaceId: "workspace-1",
    })
    systemPrisma.webhookEvent.create.mockResolvedValue({})
    handleMerged.mockResolvedValue({
      retestId: "retest-1",
      findingId: "finding-1",
      retestScanId: "scan-retest",
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      policyId: null,
    })
    assertScanAllowed.mockResolvedValue({ allowed: true })
    assertScanWorkerAvailable.mockResolvedValue(undefined)
    enqueueScanJob.mockResolvedValue("job-1")
  })

  it("enqueues exactly one retest scan for a trusted merge", async () => {
    const response = await POST(pullRequestRequest() as never)
    expect(response.status).toBe(200)
    expect(enqueueScanJob).toHaveBeenCalledOnce()
    expect(enqueueScanJob).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: "scan-retest", workspaceId: "workspace-1" })
    )
    expect(completeLoopClosure).toHaveBeenCalledWith("workspace-1", "lyrashield/fix-finding-1")
  })

  it("replays a duplicate delivery without enqueueing a second retest", async () => {
    systemPrisma.webhookEvent.findUnique.mockResolvedValueOnce({ id: "seen" })
    const response = await POST(pullRequestRequest() as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { duplicate: true } })
    expect(handleMerged).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("treats a merge of an unrelated branch as a no-op", async () => {
    handleMerged.mockResolvedValue(null)
    const response = await POST(pullRequestRequest() as never)
    expect(response.status).toBe(200)
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("does not enqueue a retest for a closed-unmerged pull request", async () => {
    const response = await POST(pullRequestRequest({ merged: false }) as never)
    expect(response.status).toBe(200)
    expect(handleMerged).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("records a durable deferred closure and returns 200 when the retest is not entitled", async () => {
    // GitHub never redelivers a failed delivery automatically. An entitlement
    // deferral must persist a LoopClosure record the worker sweep retries —
    // not clear the marker and rethrow into a silent loss.
    assertScanAllowed.mockResolvedValue({ allowed: false, code: "NO_MINUTES_REMAINING" })
    // The route passes an entitlement callback into the loop-closure handler;
    // the mock must exercise it the way the real handler does.
    handleMerged.mockImplementation(
      async (
        _ws: unknown,
        _ref: unknown,
        _pr: unknown,
        ensure: (mode: string) => Promise<void>
      ) => {
        await ensure("STANDARD")
        return null
      }
    )

    const response = await POST(pullRequestRequest() as never)

    expect(response.status).toBe(200)
    expect(recordDeferredLoopClosure).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        branchName: "lyrashield/fix-finding-1",
        prNumber: 7,
        reason: "RETEST_NOT_ENTITLED",
      })
    )
    // The delivery marker stays: the closure is durably recorded, so the
    // delivery itself is acknowledged (no redelivery will ever come).
    expect(systemPrisma.webhookEvent.deleteMany).not.toHaveBeenCalled()
    expect(enqueueScanJob).not.toHaveBeenCalled()
  })

  it("records a durable deferred closure when the scan worker is unavailable", async () => {
    handleMerged.mockImplementation(async () => {
      throw new Error("worker outage")
    })

    const response = await POST(pullRequestRequest() as never)

    expect(response.status).toBe(200)
    expect(recordDeferredLoopClosure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "WORKER_UNAVAILABLE" })
    )
    expect(systemPrisma.webhookEvent.deleteMany).not.toHaveBeenCalled()
  })

  it("clears the delivery marker and returns 500 only for genuinely unexpected errors", async () => {
    handleMerged.mockImplementation(async () => {
      throw new Error("database connection exploded")
    })
    systemPrisma.webhookEvent.deleteMany.mockResolvedValue({ count: 1 })

    const response = await POST(pullRequestRequest() as never)

    expect(response.status).toBe(500)
    expect(systemPrisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { provider: "github", externalId: "merge-1" },
    })
    expect(recordDeferredLoopClosure).not.toHaveBeenCalled()
  })

  it("never merges: the route contains no merge call", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const source = readFileSync(join(__dirname, "route.ts"), "utf8")
    expect(source).not.toMatch(/mergePullRequest|octokit\.pulls\.merge|\.merge\(/)
  })
})
