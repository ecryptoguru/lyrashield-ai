import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ createScorecardShare: vi.fn() }))

const { analyticsAllowedForRequest, requirePermission } = vi.hoisted(() => ({
  analyticsAllowedForRequest: vi.fn(),
  requirePermission: vi.fn(),
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scorecard: { publish: "scorecard:publish" } },
}))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "http://localhost" },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))
vi.mock("@/lib/analytics-preference", () => ({ analyticsAllowedForRequest }))

import { createScorecardShare } from "@lyrashield/db"
import { POST } from "./route"

function makeRequest({ workspaceId = "workspace-1", role = "OWNER" } = {}) {
  requirePermission.mockResolvedValue({
    session: { userId: "user-1" },
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
    analyticsAllowedForRequest.mockResolvedValue(true)
  })

  it("authorizes publishing through the scorecard:publish permission", async () => {
    vi.mocked(createScorecardShare).mockResolvedValue({
      share: { id: "share-1", slug: "SLUG", publicPayload: { resolvedFindings: 1 }, viewCount: 0 },
      publicPayload: { resolvedFindings: 1 },
      referralCode: "12345678",
      shareHandoffs: 0,
      referredSignups: 0,
    } as never)

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: "target-1" }),
    })

    expect(requirePermission).toHaveBeenCalledWith("workspace-1", "scorecard:publish")
    expect(response.status).toBe(201)
  })

  it("returns persisted counters when publishing an existing share", async () => {
    vi.mocked(createScorecardShare).mockResolvedValue({
      share: { id: "share-1", slug: "SLUG", publicPayload: { resolvedFindings: 4 }, viewCount: 12 },
      publicPayload: { resolvedFindings: 4 },
      referralCode: "23456789",
      shareHandoffs: 7,
      referredSignups: 3,
    } as never)
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: "target-1" }) })
    const body = await response.json()
    expect(body.data).toMatchObject({
      resolvedFindings: 4,
      views: 12,
      shareHandoffs: 7,
      referredSignups: 3,
    })
  })

  it("keeps sharing available without creating a referral-tracked URL when analytics is off", async () => {
    analyticsAllowedForRequest.mockResolvedValue(false)
    vi.mocked(createScorecardShare).mockResolvedValue({
      share: { id: "share-1", slug: "SLUG", publicPayload: { resolvedFindings: 1 }, viewCount: 0 },
      publicPayload: { resolvedFindings: 1 },
      referralCode: "12345678",
      shareHandoffs: 0,
      referredSignups: 0,
    } as never)

    const response = await POST(makeRequest(), { params: Promise.resolve({ id: "target-1" }) })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(createScorecardShare).toHaveBeenCalledOnce()
    expect(analyticsAllowedForRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ session: { userId: "user-1" } })
    )
    expect(body.data.url).toBe("/score/SLUG")
  })

  it("returns 403 when authorization fails (non-publisher role or insufficient credential scope)", async () => {
    const request = makeRequest()
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await POST(request, {
      params: Promise.resolve({ id: "target-1" }),
    })

    expect(response.status).toBe(403)
    expect(createScorecardShare).not.toHaveBeenCalled()
  })
})
