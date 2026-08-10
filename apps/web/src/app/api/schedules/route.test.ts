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
    schedule: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  createSchedule: vi.fn(),
  listSchedules: vi.fn(),
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
    schedule: { view: "schedule:view", create: "schedule:create", update: "schedule:update", delete: "schedule:delete" },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET, POST } from "./route"
import { prisma, createSchedule, listSchedules } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function makeGetRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost:3000/api/schedules")
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url, { method: "GET" })
}

const webTarget = {
  id: "target-1",
  name: "example.com",
  type: "WEB_APP",
  url: "https://example.com",
  apiSpecUrl: null,
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

describe("POST /api/schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    } as never)
    vi.mocked(createSchedule).mockResolvedValue({
      id: "sched-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      cron: "0 0 * * 0",
      goal: "TEST_APP",
      mode: "SAFE",
      enabled: true,
      nextRunAt: new Date(),
      createdById: "user-1",
    } as never)
  })

  it("creates a schedule for a web target", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(webTarget as never)
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "target-1",
        cron: "0 0 * * 0",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(res.status).toBe(201)
    expect(createSchedule).toHaveBeenCalled()
  })

  it("rejects API Contract schedules without a spec", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(apiTargetNoSpec as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "target-2",
        cron: "0 0 * * 0",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("API_SPEC_REQUIRED")
    expect(createSchedule).not.toHaveBeenCalled()
  })

  it("accepts API Contract schedules when a spec is present", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(apiTarget as never)
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "target-2",
        cron: "0 0 * * 0",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(res.status).toBe(201)
    expect(createSchedule).toHaveBeenCalled()
  })

  it("rejects schedules for a deleted target", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "target-1",
        cron: "0 0 * * 0",
        goal: "TEST_APP",
        mode: "STANDARD",
      })
    )

    expect(res.status).toBe(404)
  })

  it("maps legacy QUICK to SAFE for repository targets", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-3",
      name: "repo",
      type: "REPO",
      url: null,
      apiSpecUrl: null,
    } as never)
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({
        workspaceId: "ws-1",
        targetId: "target-3",
        cron: "0 0 * * 0",
        goal: "TEST_APP",
        mode: "QUICK",
      })
    )

    expect(res.status).toBe(201)
    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({ mode: "QUICK" }))
  })
})

describe("GET /api/schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listSchedules).mockResolvedValue({ items: [], nextCursor: null })
  })

  it("lists schedules for a workspace", async () => {
    const res = await GET(makeGetRequest({ workspaceId: "ws-1" }))
    expect(res.status).toBe(200)
    expect(listSchedules).toHaveBeenCalled()
  })

  it("returns 400 when workspaceId is missing", async () => {
    const res = await GET(makeGetRequest({}))
    expect(res.status).toBe(400)
  })
})
