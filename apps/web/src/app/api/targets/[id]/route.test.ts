import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
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
})
