import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  upsertAiSystemProfile: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { aiAssurance: { manage: "aiAssurance:manage" } },
}))
vi.mock("@lyrashield/db", () => ({ upsertAiSystemProfile: mocks.upsertAiSystemProfile }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { POST } from "./route"

const body = {
  workspaceId: "workspace-1",
  targetId: "target-1",
  systemName: "Support assistant",
  systemPurpose: "Answer customer questions",
  modelProviders: [{ provider: "OpenAI", model: "GPT", deployment: null }],
  dataClasses: ["Customer messages"],
  dataSources: [],
  storageSystems: ["Application database"],
  toolIntegrations: [],
  retentionSummary: null,
  humanOversightSummary: "Operators review escalations",
}

function call() {
  return POST(
    new Request("http://localhost/api/ai-assurance/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("POST /api/ai-assurance/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.upsertAiSystemProfile.mockResolvedValue({
      profile: { profile: body },
      version: 1,
      inventorySummary: {},
    })
  })

  it("saves a profile for a member with aiAssurance:manage", async () => {
    const response = await call()

    expect(response.status).toBe(201)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "aiAssurance:manage")
    expect(mocks.upsertAiSystemProfile).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetId: "target-1",
      createdById: "user-1",
      profile: expect.objectContaining({ systemName: "Support assistant" }),
    })
  })

  it("does not save a profile without aiAssurance:manage", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call()).status).toBe(403)
    expect(mocks.upsertAiSystemProfile).not.toHaveBeenCalled()
  })
})
