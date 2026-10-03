import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getScanQualitySurface: vi.fn(),
  withWorkspaceRLS: (workspaceId: string, callback: (tx: unknown) => unknown) =>
    withWorkspaceRLSMock(workspaceId, callback),
}))

const scanFindFirstMock = vi.fn()
const withWorkspaceRLSMock = vi.fn((workspaceId: string, callback: (tx: unknown) => unknown) =>
  callback({ scan: { findFirst: scanFindFirstMock } })
)
const assertOAuthDelegatedScopeMock = vi.fn(
  (
    session: {
      oauth?: {
        connectionId?: string
        scopes?: string[]
        allTargets?: boolean
        allowedTargetIds?: string[]
      }
    },
    targetId: string | null | undefined
  ) => {
    const connection = session.oauth
    if (
      connection?.connectionId &&
      !connection.allTargets &&
      (!targetId || !connection.allowedTargetIds?.includes(targetId))
    ) {
      throw new Error("FORBIDDEN")
    }
  }
)

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
  assertOAuthDelegatedScope: (
    session: {
      oauth?: {
        connectionId?: string
        scopes?: string[]
        allTargets?: boolean
        allowedTargetIds?: string[]
      }
    },
    targetId: string | null | undefined
  ) => assertOAuthDelegatedScopeMock(session, targetId),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { view: "scan:view" } },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { error: vi.fn() },
}))

import { GET } from "./route"
import { getScanQualitySurface } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"

const routeParams = { params: Promise.resolve({ id: "scan-1" }) }

function request(workspaceId?: string) {
  const url = workspaceId
    ? `http://localhost/api/scans/scan-1/quality?workspaceId=${workspaceId}`
    : "http://localhost/api/scans/scan-1/quality"
  return new Request(url)
}

describe("/api/scans/[id]/quality", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the measured quality surface for a workspace scan", async () => {
    vi.mocked(getScanQualitySurface).mockResolvedValue({
      version: "lyrashield-scan-quality/1.0.0",
      facts: {
        scanStatus: "COMPLETED",
        scanMode: "STANDARD",
        deterministicRun: false,
        durationMs: 1000,
        llmRequests: 5,
        findings: {
          total: 2,
          byVerificationStatus: { DETECTED: 1, VERIFIED: 1 },
          bySeverity: { HIGH: 2 },
          validatedCount: 0,
          verifiedCount: 1,
          nonConclusiveCount: 0,
        },
        coverage: {
          receiptsTotal: 3,
          byStatus: { COMPLETED: 3 },
          byScanner: { sast: 3 },
          engineDeclaredReceipts: 0,
          connectorReceipts: 0,
        },
        evidence: {
          manifestPresent: true,
          manifestChecksum: "abc",
          ingestionWarningCount: 0,
          attachmentCount: null,
        },
      },
      estimates: {
        assessedReceiptRatio: { kind: "heuristic", value: 1, basis: "test" },
        verifiedFindingRatio: { kind: "heuristic", value: 0.5, basis: "test" },
      },
      parity: {},
      surfaceChecksum: "deadbeef",
    } as never)

    const res = await GET(request("ws-1"), routeParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.version).toBe("lyrashield-scan-quality/1.0.0")
    expect(body.data.facts.findings.verifiedCount).toBe(1)
    expect(body.data.estimates.verifiedFindingRatio.kind).toBe("heuristic")
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:view")
    expect(getScanQualitySurface).toHaveBeenCalledWith("scan-1", "ws-1")
    expect(withWorkspaceRLSMock).not.toHaveBeenCalled()
  })

  it("resolves the scan target and permits a connection scoped to that target", async () => {
    const session = {
      userId: "user-1",
      oauth: {
        connectionId: "connection-1",
        scopes: ["lyrashield.read", "lyrashield.write"],
        allTargets: false,
        allowedTargetIds: ["target-1"],
      },
    }
    vi.mocked(requirePermission).mockResolvedValueOnce({ session } as never)
    scanFindFirstMock.mockResolvedValueOnce({ targetId: "target-1" })
    vi.mocked(getScanQualitySurface).mockResolvedValueOnce({
      version: "lyrashield-scan-quality/1.0.0",
      surfaceChecksum: "delegated-surface",
    } as never)

    const res = await GET(request("ws-1"), routeParams)

    expect(res.status).toBe(200)
    expect(withWorkspaceRLSMock).toHaveBeenCalledWith("ws-1", expect.any(Function))
    expect(scanFindFirstMock).toHaveBeenCalledWith({
      where: { id: "scan-1", workspaceId: "ws-1", deletedAt: null },
      select: { targetId: true },
    })
    expect(assertOAuthDelegatedScopeMock).toHaveBeenCalledWith(session, "target-1")
    expect(getScanQualitySurface).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("denies a connection-scoped caller when the resolved scan target is outside its grant", async () => {
    const session = {
      userId: "user-1",
      oauth: {
        connectionId: "connection-1",
        scopes: ["lyrashield.read", "lyrashield.write"],
        allTargets: false,
        allowedTargetIds: ["target-allowed"],
      },
    }
    vi.mocked(requirePermission).mockResolvedValueOnce({ session } as never)
    scanFindFirstMock.mockResolvedValueOnce({ targetId: "target-forbidden" })

    const res = await GET(request("ws-1"), routeParams)

    expect(res.status).toBe(403)
    expect(assertOAuthDelegatedScopeMock).toHaveBeenCalledWith(session, "target-forbidden")
    expect(getScanQualitySurface).not.toHaveBeenCalled()
  })

  it("does not reveal a cross-workspace or missing scan to a connection-bound caller", async () => {
    const session = {
      userId: "user-1",
      oauth: {
        connectionId: "connection-1",
        scopes: ["lyrashield.read", "lyrashield.write"],
        allTargets: false,
        allowedTargetIds: ["target-1"],
      },
    }
    vi.mocked(requirePermission).mockResolvedValueOnce({ session } as never)
    scanFindFirstMock.mockResolvedValueOnce(null)

    const res = await GET(request("ws-1"), routeParams)

    expect(res.status).toBe(404)
    expect(assertOAuthDelegatedScopeMock).not.toHaveBeenCalled()
    expect(getScanQualitySurface).not.toHaveBeenCalled()
  })

  it("keeps workspace-wide read-only OAuth access without a target grant", async () => {
    const session = {
      userId: "user-1",
      oauth: {
        connectionId: "read-only-connection",
        scopes: ["lyrashield.read"],
        allTargets: false,
        allowedTargetIds: [],
      },
    }
    vi.mocked(requirePermission).mockResolvedValueOnce({ session } as never)
    vi.mocked(getScanQualitySurface).mockResolvedValueOnce({
      version: "lyrashield-scan-quality/1.0.0",
      surfaceChecksum: "workspace-read-surface",
    } as never)

    const res = await GET(request("ws-1"), routeParams)

    expect(res.status).toBe(200)
    expect(withWorkspaceRLSMock).not.toHaveBeenCalled()
    expect(assertOAuthDelegatedScopeMock).not.toHaveBeenCalled()
    expect(getScanQualitySurface).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("rejects a missing workspaceId", async () => {
    const res = await GET(request(), routeParams)
    expect(res.status).toBe(400)
    expect(getScanQualitySurface).not.toHaveBeenCalled()
  })

  it("404s when the scan has no stored evidence in this workspace", async () => {
    vi.mocked(getScanQualitySurface).mockResolvedValue(null)
    const res = await GET(request("ws-1"), routeParams)
    expect(res.status).toBe(404)
  })

  it("fails closed on auth errors", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("forbidden"))
    const res = await GET(request("ws-1"), routeParams)
    expect([401, 403, 500]).toContain(res.status)
    expect(getScanQualitySurface).not.toHaveBeenCalled()
  })

  it("returns an ETag on 200 and a bodyless 304 for a matching If-None-Match (W2.4)", async () => {
    vi.mocked(getScanQualitySurface).mockResolvedValue({
      version: "lyrashield-scan-quality/1.0.0",
      surfaceChecksum: "deadbeef",
    } as never)

    const first = await GET(request("ws-1"), routeParams)
    expect(first.status).toBe(200)
    const etag = first.headers.get("ETag")
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    const conditional = new Request("http://localhost/api/scans/scan-1/quality?workspaceId=ws-1", {
      headers: { "If-None-Match": etag! },
    })
    const second = await GET(conditional, routeParams)
    expect(second.status).toBe(304)
    expect(second.headers.get("ETag")).toBe(etag)
    expect(await second.text()).toBe("")
  })
})
