import { beforeEach, describe, expect, it, vi } from "vitest"

const getFinding = vi.fn()
const createScan = vi.fn()
const requirePermission = vi.fn()
const enqueueScanJob = vi.fn()
const assertScanWorkerAvailable = vi.fn()
const updateScanStatus = vi.fn()
class ScanWorkerUnavailableError extends Error {}
const prisma = {
  scan: { findFirst: vi.fn(), update: vi.fn() },
  findingCandidate: { findMany: vi.fn() },
  retest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
}

vi.mock("@lyrashield/db", () => ({ getFinding, createScan, updateScanStatus, prisma }))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { retest: { create: "retest:create" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("../../../../../lib/queue", () => ({
  enqueueScanJob,
  assertScanWorkerAvailable,
  ScanWorkerUnavailableError,
}))

const { POST } = await import("./route")

describe("POST /api/findings/[id]/retests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    getFinding.mockResolvedValue({ id: "finding-1", targetId: "target-1", scanId: "source-scan" })
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
