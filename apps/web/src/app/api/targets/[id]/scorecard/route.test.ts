import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ createScorecardShare: vi.fn() }))
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { role: "OWNER" },
  }),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { createScorecardShare } from "@lyrashield/db"
import { POST } from "./route"

describe("POST target scorecard", () => {
  it("returns persisted counters when publishing an existing share", async () => {
    vi.mocked(createScorecardShare).mockResolvedValue({
      share: { id: "share-1", slug: "SLUG", publicPayload: { resolvedFindings: 4 }, viewCount: 12 },
      referralCode: "23456789",
      shareHandoffs: 7,
      referredSignups: 3,
    } as never)
    const response = await POST(
      new Request("http://localhost/api/targets/target-1/scorecard", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
      { params: Promise.resolve({ id: "target-1" }) }
    )
    const body = await response.json()
    expect(body.data).toMatchObject({ views: 12, shareHandoffs: 7, referredSignups: 3 })
  })
})
