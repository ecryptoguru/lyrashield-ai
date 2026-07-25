import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ createScorecardShare: vi.fn() }))

const requireWorkspaceAccess = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { createScorecardShare } from "@lyrashield/db"
import { POST } from "./route"

function makeRequest({ workspaceId = "workspace-1", role = "OWNER", apiKey }: { workspaceId?: string; role?: string; apiKey?: { keyId: string; workspaceId: string; scopes: string[] } } = {}) {
  requireWorkspaceAccess.mockResolvedValue({
    session: { userId: "user-1", apiKey },
    workspace: { role },
  })
  return new Request("http://localhost/api/targets/target-1/scorecard", {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  })
}

describe("POST target scorecard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns persisted counters when publishing an existing share", async () => {
    vi.mocked(createScorecardShare).mockResolvedValue({
      share: { id: "share-1", slug: "SLUG", publicPayload: { resolvedFindings: 4 }, viewCount: 12 },
      referralCode: "23456789",
      shareHandoffs: 7,
      referredSignups: 3,
    } as never)
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: "target-1" }) })
    const body = await response.json()
    expect(body.data).toMatchObject({ views: 12, shareHandoffs: 7, referredSignups: 3 })
  })

  it("allows a write-scope API key to publish a scorecard", async () => {
    vi.mocked(createScorecardShare).mockResolvedValue({
      share: { id: "share-1", slug: "SLUG", publicPayload: { resolvedFindings: 1 }, viewCount: 0 },
      referralCode: "12345678",
      shareHandoffs: 0,
      referredSignups: 0,
    } as never)
    const response = await POST(
      makeRequest({ apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read", "write"] } }),
      { params: Promise.resolve({ id: "target-1" }) }
    )
    expect(response.status).toBe(201)
    expect(createScorecardShare).toHaveBeenCalled()
  })

  it("blocks a read-only API key from publishing a scorecard", async () => {
    const response = await POST(
      makeRequest({ apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read"] } }),
      { params: Promise.resolve({ id: "target-1" }) }
    )
    expect(response.status).toBe(403)
    expect(createScorecardShare).not.toHaveBeenCalled()
  })
})
