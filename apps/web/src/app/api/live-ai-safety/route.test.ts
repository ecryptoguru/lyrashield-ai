import { beforeEach, describe, expect, it, vi } from "vitest"
import { AI_SAFETY_TEST_CATALOG } from "@lyrashield/types"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    liveAiSafetySettings: { findUnique: vi.fn() },
    liveAiSafetyPlan: { findMany: vi.fn() },
  },
  createLiveAiSafetyPlan: vi.fn(),
  upsertLiveAiSafetySettings: vi.fn(),
  LiveAiSafetyError: class LiveAiSafetyError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    agent: { view: "agent:view", act: "agent:act" },
    aiAssurance: { manage: "aiAssurance:manage" },
  },
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import {
  createLiveAiSafetyPlan,
  LiveAiSafetyError,
  prisma,
  upsertLiveAiSafetySettings,
} from "@lyrashield/db"
import { GET, POST, PUT } from "./route"
import { requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

const jsonRequest = (method: string, body: unknown) =>
  new Request("https://app.lyrashieldai.com/api/live-ai-safety", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const plan = {
  workspaceId: "ws-1",
  targetId: "target-1",
  endpointUrl: "https://staging.example.com/safety",
  approvedHost: "staging.example.com",
  authMode: "NO_AUTH",
  incidentContact: "security@example.com",
  maxRequests: 1,
  maxDurationSeconds: 60,
  maxResponseBytes: 1024,
  rawSampleStorage: "DISABLED",
  destructiveTestsAllowed: false,
  cases: [AI_SAFETY_TEST_CATALOG[0]],
}

describe("live AI safety route", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns private plan metadata only", async () => {
    vi.mocked(prisma.liveAiSafetySettings.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.liveAiSafetyPlan.findMany).mockResolvedValue([] as never)
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/live-ai-safety?workspaceId=ws-1")
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("updates the reusable incident contact under the assurance permission", async () => {
    vi.mocked(upsertLiveAiSafetySettings).mockResolvedValue({
      incidentContact: "security@example.com",
    } as never)
    const response = await PUT(
      jsonRequest("PUT", { workspaceId: "ws-1", incidentContact: "security@example.com" })
    )
    expect(response.status).toBe(200)
    expect(upsertLiveAiSafetySettings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      incidentContact: "security@example.com",
      createdById: "user-1",
    })
  })

  it("creates a ready plan without trusting caller-defined test cases", async () => {
    vi.mocked(createLiveAiSafetyPlan).mockResolvedValue({
      id: "plan-1",
      status: "READY",
      createdAt: new Date("2026-08-14T00:00:00.000Z"),
    } as never)
    const response = await POST(jsonRequest("POST", plan))
    expect(response.status).toBe(201)
    expect(createLiveAiSafetyPlan).toHaveBeenCalledWith({ ...plan, createdById: "user-1" })
  })

  it("returns a non-cacheable conflict when the target is not ready", async () => {
    vi.mocked(createLiveAiSafetyPlan).mockRejectedValue(
      new LiveAiSafetyError("DOMAIN_VERIFICATION_REQUIRED")
    )
    const response = await POST(jsonRequest("POST", plan))
    expect(response.status).toBe(409)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect((await response.json()).error.code).toBe("DOMAIN_VERIFICATION_REQUIRED")
  })

  it("denies safety-plan reads without agent:view", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/live-ai-safety?workspaceId=ws-1")
    )
    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/live-ai-safety",
      "GET"
    )
    expect(vi.mocked(prisma.liveAiSafetyPlan.findMany)).not.toHaveBeenCalled()
  })

  it("denies safety settings writes without aiAssurance:manage", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)
    const response = await PUT(
      jsonRequest("PUT", { workspaceId: "ws-1", incidentContact: "security@example.com" })
    )
    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/live-ai-safety",
      "PUT"
    )
    expect(upsertLiveAiSafetySettings).not.toHaveBeenCalled()
  })

  it("denies safety-plan creation without agent:act", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)
    const response = await POST(jsonRequest("POST", plan))
    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/live-ai-safety",
      "POST"
    )
    expect(createLiveAiSafetyPlan).not.toHaveBeenCalled()
  })
})
