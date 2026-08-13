import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getThreatModel: vi.fn(),
  saveThreatModel: vi.fn(),
  threatModelMarkdown: vi.fn().mockReturnValue("# Customer-declared threat model"),
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { aiAssurance: { view: "aiAssurance:view", manage: "aiAssurance:manage" } },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { getThreatModel, saveThreatModel } from "@lyrashield/db"
import { GET, POST } from "./route"

const body = {
  workspaceId: "ws-1",
  targetId: "target-1",
  scope: "Customer support assistant",
  assets: ["Conversation data"],
  trustBoundaries: ["Browser to API"],
  threats: [
    {
      title: "Prompt injection",
      severity: "HIGH",
      description: "Untrusted content",
      mitigation: "Segregate context",
      testPlan: "Run fixtures",
      owner: "AppSec",
      reviewDate: "2026-09-01",
    },
  ],
}

describe("/api/ai-assurance/threat-model", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns a private, customer-declared current version", async () => {
    vi.mocked(getThreatModel).mockResolvedValue({
      currentVersion: { id: "v-1", content: body },
    } as never)
    const response = await GET(
      new Request(
        "http://localhost/api/ai-assurance/threat-model?workspaceId=ws-1&targetId=target-1"
      )
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect((await response.json()).data.customerDeclared).toBe(true)
  })

  it("exports Markdown only after workspace authorization", async () => {
    vi.mocked(getThreatModel).mockResolvedValue({
      currentVersion: { id: "v-1", content: body },
    } as never)
    const response = await GET(
      new Request(
        "http://localhost/api/ai-assurance/threat-model?workspaceId=ws-1&targetId=target-1&format=markdown"
      )
    )
    expect(response.headers.get("content-type")).toContain("text/markdown")
    expect(await response.text()).toContain("Customer-declared")
  })

  it("does not accept a high threat without an owner", async () => {
    const response = await POST(
      new Request("http://localhost/api/ai-assurance/threat-model", {
        method: "POST",
        body: JSON.stringify({ ...body, threats: [{ ...body.threats[0], owner: null }] }),
      })
    )
    expect(response.status).toBe(400)
    expect(saveThreatModel).not.toHaveBeenCalled()
  })
})
