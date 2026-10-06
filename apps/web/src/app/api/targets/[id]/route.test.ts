import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((callback) => callback),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

const {
  TargetNotFoundErrorMock,
  TargetHasActiveScanErrorMock,
  softDeleteTargetMock,
  targetFindFirstMock,
  targetUpdateMock,
  auditLogCreateMock,
  withWorkspaceRLSMock,
  checkScanUrlSafeMock,
} = vi.hoisted(() => {
  class TargetNotFoundErrorMock extends Error {
    readonly code = "TARGET_NOT_FOUND"
  }
  class TargetHasActiveScanErrorMock extends Error {
    readonly code = "TARGET_HAS_ACTIVE_SCAN"
  }
  return {
    TargetNotFoundErrorMock,
    TargetHasActiveScanErrorMock,
    softDeleteTargetMock: vi.fn(),
    targetFindFirstMock: vi.fn(),
    targetUpdateMock: vi.fn(),
    auditLogCreateMock: vi.fn(),
    withWorkspaceRLSMock: vi.fn(),
    checkScanUrlSafeMock: vi.fn(),
  }
})
const purgeAiResultCacheWorkspaceEntriesMock = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/integrations", () => ({
  purgeAiResultCacheWorkspaceEntries: (...args: unknown[]) =>
    purgeAiResultCacheWorkspaceEntriesMock(...args),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    auditLog: { create: auditLogCreateMock },
    target: { findFirst: targetFindFirstMock, update: targetUpdateMock },
  },
  withWorkspaceRLS: withWorkspaceRLSMock,
  softDeleteTarget: (...args: unknown[]) => softDeleteTargetMock(...args),
  TargetNotFoundError: TargetNotFoundErrorMock,
  TargetHasActiveScanError: TargetHasActiveScanErrorMock,
}))

vi.mock("../../../../lib/ssrf", () => ({ checkScanUrlSafe: checkScanUrlSafeMock }))

const requirePermission = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(),
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { target: { delete: "target:delete", update: "target:update" } },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { DELETE, PATCH } from "./route"

function req(id: string, workspaceId?: string): Request {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""
  return new Request(`http://localhost:3000/api/targets/${id}${qs}`, { method: "DELETE" })
}

function patchReq(body: unknown): Request {
  return new Request("http://localhost:3000/api/targets/t-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describe("DELETE /api/targets/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    purgeAiResultCacheWorkspaceEntriesMock.mockResolvedValue({
      available: true,
      targetsVisited: 1,
      entriesDeleted: 0,
    })
  })

  it("returns 204 on success and routes through target.delete", async () => {
    softDeleteTargetMock.mockResolvedValue({ id: "t-1" })

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(204)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "target:delete")
    expect(softDeleteTargetMock).toHaveBeenCalledWith("ws-1", "t-1", "user-1")
    expect(purgeAiResultCacheWorkspaceEntriesMock).toHaveBeenCalledWith("ws-1", ["t-1"])
  })

  it("keeps target deletion successful if the best-effort cache purge fails", async () => {
    softDeleteTargetMock.mockResolvedValue({ id: "t-1" })
    purgeAiResultCacheWorkspaceEntriesMock.mockRejectedValue(new Error("Redis unavailable"))

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(204)
  })

  it("returns 409 with TARGET_HAS_ACTIVE_SCAN when a scan is queued or running", async () => {
    softDeleteTargetMock.mockRejectedValue(new TargetHasActiveScanErrorMock())

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe("TARGET_HAS_ACTIVE_SCAN")
  })

  it("returns 404 when the target is missing or already deleted", async () => {
    softDeleteTargetMock.mockRejectedValue(new TargetNotFoundErrorMock())

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("TARGET_NOT_FOUND")
  })

  it("returns 403 when the caller lacks target.delete", async () => {
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(403)
    expect(softDeleteTargetMock).not.toHaveBeenCalled()
  })

  it("returns 400 without workspaceId", async () => {
    const res = await DELETE(req("t-1"), ctx("t-1"))

    expect(res.status).toBe(400)
    expect(softDeleteTargetMock).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/targets/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    auditLogCreateMock.mockResolvedValue({})
    targetUpdateMock.mockResolvedValue({
      id: "t-1",
      type: "API",
      apiSpecUrl: "https://api.example.test/openapi.json",
    })
    checkScanUrlSafeMock.mockResolvedValue({ safe: true })

    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      target: {
        findFirst: targetFindFirstMock,
        update: targetUpdateMock,
      },
    }
    withWorkspaceRLSMock.mockImplementation(async (...args: unknown[]) => {
      const callback = args[1] as (transaction: typeof tx) => Promise<unknown>
      return callback(tx)
    })
  })

  it("updates a repository ref only after target.update permission and workspace scoping", async () => {
    targetFindFirstMock.mockResolvedValueOnce({
      id: "t-1",
      type: "REPO",
      branch: "main",
      _count: { scans: 0 },
    })

    const response = await PATCH(
      patchReq({ workspaceId: "ws-1", branch: "release/v2" }),
      ctx("t-1")
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: "t-1", type: "REPO", branch: "release/v2" },
    })
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "target:update")
    expect(withWorkspaceRLSMock).toHaveBeenCalledWith("ws-1", expect.any(Function))
    expect(targetFindFirstMock).toHaveBeenCalledWith({
      where: { id: "t-1", workspaceId: "ws-1", deletedAt: null },
      select: { id: true, type: true, branch: true, _count: { select: { scans: true } } },
    })
    expect(targetUpdateMock).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { branch: "release/v2" },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        actorUserId: "user-1",
        action: "target.repo_ref_updated",
        resourceId: "t-1",
        metadata: { previousRef: "main", ref: "release/v2" },
      }),
    })
  })

  it("does not enter the workspace transaction when target.update permission is denied", async () => {
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await PATCH(
      patchReq({ workspaceId: "ws-1", branch: "release/v2" }),
      ctx("t-1")
    )

    expect(response.status).toBe(403)
    expect(withWorkspaceRLSMock).not.toHaveBeenCalled()
    expect(targetFindFirstMock).not.toHaveBeenCalled()
    expect(targetUpdateMock).not.toHaveBeenCalled()
  })

  it("does not update a target outside the authorized workspace", async () => {
    targetFindFirstMock.mockResolvedValueOnce(null)

    const response = await PATCH(
      patchReq({ workspaceId: "ws-1", branch: "release/v2" }),
      ctx("t-1")
    )

    expect(response.status).toBe(404)
    expect(targetFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1", workspaceId: "ws-1", deletedAt: null } })
    )
    expect(targetUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("keeps repository refs immutable after the first scan", async () => {
    targetFindFirstMock.mockResolvedValueOnce({
      id: "t-1",
      type: "REPO",
      branch: "main",
      _count: { scans: 1 },
    })

    const response = await PATCH(
      patchReq({ workspaceId: "ws-1", branch: "release/v2" }),
      ctx("t-1")
    )

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("TARGET_REF_IMMUTABLE")
    expect(targetUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("rejects an unsafe OpenAPI URL before writing it", async () => {
    targetFindFirstMock.mockResolvedValueOnce({
      id: "t-1",
      type: "API",
      apiSpecUrl: "https://api.example.test/old.json",
      branch: null,
    })
    checkScanUrlSafeMock.mockResolvedValueOnce({ safe: false })

    const response = await PATCH(
      patchReq({ workspaceId: "ws-1", apiSpecUrl: "https://metadata.example/openapi.json" }),
      ctx("t-1")
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("SSRF_BLOCKED")
    expect(checkScanUrlSafeMock).toHaveBeenCalledWith("https://metadata.example/openapi.json")
    expect(targetUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })
})
