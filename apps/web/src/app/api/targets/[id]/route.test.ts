import { describe, it, expect, vi, beforeEach } from "vitest"

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  executeRaw: vi.fn(),
  withWorkspaceRLS: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: {
      findFirst: db.findFirst,
      update: db.update,
    },
    auditLog: { create: vi.fn() },
  },
  withWorkspaceRLS: db.withWorkspaceRLS,
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
  }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    target: { update: "target:update" },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock("../../../../lib/ssrf", () => ({
  checkScanUrlSafe: vi.fn().mockResolvedValue({ safe: true }),
}))

import { PATCH } from "./route"
import { prisma } from "@lyrashield/db"
import { checkScanUrlSafe } from "../../../../lib/ssrf"

function makeRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/targets/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /api/targets/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.withWorkspaceRLS.mockImplementation(
      async (_workspaceId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: db.executeRaw,
          target: { findFirst: db.findFirst, update: db.update },
        })
    )
    db.executeRaw.mockResolvedValue(undefined)
  })

  it("updates the apiSpecUrl for an API target", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "API",
    } as never)
    vi.mocked(prisma.target.update).mockResolvedValue({
      id: "t1",
      type: "API",
      apiSpecUrl: "https://api.example.com/openapi.yaml",
    } as never)

    const res = await PATCH(
      makeRequest("t1", {
        workspaceId: "ws-1",
        apiSpecUrl: "https://api.example.com/openapi.yaml",
      }),
      { params: Promise.resolve({ id: "t1" }) }
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({
      id: "t1",
      type: "API",
      apiSpecUrl: "https://api.example.com/openapi.yaml",
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "target.api_spec_updated" }),
      })
    )
  })

  it("rejects setting apiSpecUrl on a WEB_APP target", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "WEB_APP",
    } as never)

    const res = await PATCH(
      makeRequest("t1", {
        workspaceId: "ws-1",
        apiSpecUrl: "https://api.example.com/openapi.yaml",
      }),
      { params: Promise.resolve({ id: "t1" }) }
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("INVALID_TARGET_TYPE")
  })

  it("rejects an apiSpecUrl with query or fragment", async () => {
    const res = await PATCH(
      makeRequest("t1", {
        workspaceId: "ws-1",
        apiSpecUrl: "https://api.example.com/openapi.yaml?version=2",
      }),
      { params: Promise.resolve({ id: "t1" }) }
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("VALIDATION_ERROR")
  })

  it("rejects an unsafe OpenAPI URL", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "API",
    } as never)
    vi.mocked(checkScanUrlSafe).mockResolvedValue({ safe: false, reason: "blocked_ip" } as never)

    const res = await PATCH(
      makeRequest("t1", {
        workspaceId: "ws-1",
        apiSpecUrl: "https://api.example.com/openapi.yaml",
      }),
      { params: Promise.resolve({ id: "t1" }) }
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("SSRF_BLOCKED")
  })

  it("allows removing the apiSpecUrl with null", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "API",
      apiSpecUrl: "https://api.example.com/openapi.yaml",
    } as never)
    vi.mocked(prisma.target.update).mockResolvedValue({
      id: "t1",
      type: "API",
      apiSpecUrl: null,
    } as never)

    const res = await PATCH(
      makeRequest("t1", {
        workspaceId: "ws-1",
        apiSpecUrl: null,
      }),
      { params: Promise.resolve({ id: "t1" }) }
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.apiSpecUrl).toBeNull()
    expect(prisma.target.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { apiSpecUrl: null },
    })
  })

  it("takes the createScan target lock before reading and updating an unscanned REPO ref", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "REPO",
      branch: "main",
      _count: { scans: 0 },
    } as never)
    vi.mocked(prisma.target.update).mockResolvedValue({ id: "t1" } as never)

    const res = await PATCH(makeRequest("t1", { workspaceId: "ws-1", branch: "v0.1.17" }), {
      params: Promise.resolve({ id: "t1" }),
    })

    expect(res.status).toBe(200)
    expect(db.withWorkspaceRLS).toHaveBeenCalledWith("ws-1", expect.any(Function))
    expect(db.executeRaw).toHaveBeenCalledOnce()
    expect(String(db.executeRaw.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock(hashtext(")
    expect(db.executeRaw.mock.calls[0]?.[1]).toBe("t1")
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.findFirst.mock.invocationCallOrder[0]!
    )
    expect(db.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      db.update.mock.invocationCallOrder[0]!
    )
    expect(prisma.target.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { branch: "v0.1.17" },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "target.repo_ref_updated",
          metadata: { previousRef: "main", ref: "v0.1.17" },
        }),
      })
    )
  })

  it("keeps the repository ref immutable once any scan exists", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "REPO",
      branch: "main",
      _count: { scans: 1 },
    } as never)

    const res = await PATCH(makeRequest("t1", { workspaceId: "ws-1", branch: "v0.1.17" }), {
      params: Promise.resolve({ id: "t1" }),
    })

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("TARGET_REF_IMMUTABLE")
    expect(db.executeRaw).toHaveBeenCalledOnce()
    expect(prisma.target.update).not.toHaveBeenCalled()
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("rejects branch updates for non-REPO targets", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "t1",
      workspaceId: "ws-1",
      type: "API",
      branch: null,
      _count: { scans: 0 },
    } as never)

    const res = await PATCH(makeRequest("t1", { workspaceId: "ws-1", branch: "v0.1.17" }), {
      params: Promise.resolve({ id: "t1" }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_TARGET_TYPE")
    expect(prisma.target.update).not.toHaveBeenCalled()
  })

  it("rejects whitespace and invalid Git ref syntax before opening an RLS transaction", async () => {
    for (const branch of [" release/v1 ", "release..v1", "topic~1"]) {
      const res = await PATCH(makeRequest("t1", { workspaceId: "ws-1", branch }), {
        params: Promise.resolve({ id: "t1" }),
      })
      expect(res.status).toBe(400)
    }
    expect(db.withWorkspaceRLS).not.toHaveBeenCalled()
  })
})
