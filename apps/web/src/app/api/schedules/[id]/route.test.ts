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
  prisma: {
    target: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  getSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  getNextRunAt: vi.fn((cron: string) => (cron === "0 0 * * 0" ? new Date() : null)),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    schedule: {
      view: "schedule:view",
      create: "schedule:create",
      update: "schedule:update",
      delete: "schedule:delete",
    },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { DELETE, GET, PATCH } from "./route"
import { prisma, deleteSchedule, getSchedule, updateSchedule } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

function makePatchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/schedules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const apiTarget = {
  id: "target-2",
  name: "api.example.com",
  type: "API",
  url: "https://api.example.com",
  apiSpecUrl: "https://api.example.com/openapi.json",
}

const apiTargetNoSpec = {
  ...apiTarget,
  apiSpecUrl: null,
}

describe("PATCH /api/schedules/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSchedule).mockResolvedValue({
      id: "sched-1",
      workspaceId: "ws-1",
      targetId: "target-2",
      cron: "0 0 * * 0",
      goal: "TEST_APP",
      mode: "SAFE",
      enabled: true,
      target: apiTarget,
    } as never)
    vi.mocked(updateSchedule).mockResolvedValue({
      id: "sched-1",
      enabled: true,
      cron: "0 0 * * 0",
    } as never)
  })

  it("rejects an API Standard update when the spec has been removed", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(apiTargetNoSpec as never)

    const res = await PATCH(
      makePatchRequest("sched-1", { workspaceId: "ws-1", mode: "STANDARD" }),
      {
        params: Promise.resolve({ id: "sched-1" }),
      }
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("API_SPEC_REQUIRED")
    expect(updateSchedule).not.toHaveBeenCalled()
  })

  it("allows a mode update when the target still supports it", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(apiTarget as never)

    const res = await PATCH(
      makePatchRequest("sched-1", { workspaceId: "ws-1", mode: "STANDARD" }),
      {
        params: Promise.resolve({ id: "sched-1" }),
      }
    )

    expect(res.status).toBe(200)
    expect(updateSchedule).toHaveBeenCalled()
  })

  it("denies updates without schedule:update", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const res = await PATCH(makePatchRequest("sched-1", { workspaceId: "ws-1", mode: "SAFE" }), {
      params: Promise.resolve({ id: "sched-1" }),
    })

    expectPermissionDenied(
      res,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/schedules/[id]",
      "PATCH"
    )
    expect(getSchedule).not.toHaveBeenCalled()
    expect(updateSchedule).not.toHaveBeenCalled()
  })

  it("denies reads without schedule:view", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const res = await GET(new Request("http://localhost/api/schedules/sched-1?workspaceId=ws-1"), {
      params: Promise.resolve({ id: "sched-1" }),
    })

    expectPermissionDenied(
      res,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/schedules/[id]",
      "GET"
    )
    expect(getSchedule).not.toHaveBeenCalled()
  })

  it("denies deletion without schedule:delete", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const res = await DELETE(
      new Request("http://localhost/api/schedules/sched-1?workspaceId=ws-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "sched-1" }) }
    )

    expectPermissionDenied(
      res,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/schedules/[id]",
      "DELETE"
    )
    expect(getSchedule).not.toHaveBeenCalled()
    expect(deleteSchedule).not.toHaveBeenCalled()
  })
})
