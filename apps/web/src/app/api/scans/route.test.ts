import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
    scan: { count: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  createScan: vi.fn(),
  listScans: vi.fn(),
  updateScanStatus: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock("../../../lib/queue", () => ({
  enqueueScanJob: vi.fn().mockResolvedValue("job-1"),
  assertScanWorkerAvailable: vi.fn().mockResolvedValue(undefined),
  ScanWorkerUnavailableError: class ScanWorkerUnavailableError extends Error {},
}))

import { POST, GET } from "./route"
import { prisma, createScan, listScans, updateScanStatus } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../lib/queue"

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

function defaultAuthMock() {
  vi.mocked(requirePermission).mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  } as never)
}

describe("POST /api/scans", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultAuthMock()
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({ id: "default-policy" } as never)
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
      items: [{ id: "scan-1" }, { id: "scan-2" }],
      nextCursor: "scan-2",
    } as never)

    const res = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.items).toHaveLength(2)
    expect(json.data.nextCursor).toBe("scan-2")
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

  it("returns 403 when user lacks scan.view permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN") as never)

    const res = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    expect(res.status).toBe(403)
  })
})
