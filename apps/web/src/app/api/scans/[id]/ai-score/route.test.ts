import { beforeEach, describe, expect, it, vi } from "vitest"

const getAiSecurityScoreSnapshot = vi.fn()

vi.mock("@lyrashield/db", () => ({ getAiSecurityScoreSnapshot }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { view: "scan:view" } },
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn() },
}))

const { GET } = await import("./route")

const routeParams = { params: Promise.resolve({ id: "scan-1" }) }

function request(ifNoneMatch?: string) {
  return new Request("http://localhost/api/scans/scan-1/ai-score?workspaceId=ws-1", {
    ...(ifNoneMatch ? { headers: { "If-None-Match": ifNoneMatch } } : {}),
  })
}

describe("GET /api/scans/[id]/ai-score", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the score snapshot with an ETag", async () => {
    getAiSecurityScoreSnapshot.mockResolvedValue({
      score: 82,
      methodology: "v1",
      assessedCount: 4,
      totalControls: 5,
      evidenceQuality: "high",
      breakdown: { reason: "ok" },
      computedAt: "2026-09-10T00:00:00.000Z",
    })

    const res = await GET(request(), routeParams)
    expect(res.status).toBe(200)
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    const body = await res.json()
    expect(body.data.score).toBe(82)
  })

  it("answers a matching If-None-Match with a bodyless 304 (W2.4)", async () => {
    getAiSecurityScoreSnapshot.mockResolvedValue({
      score: 82,
      methodology: "v1",
      assessedCount: 4,
      totalControls: 5,
      evidenceQuality: "high",
      breakdown: { reason: "ok" },
      computedAt: "2026-09-10T00:00:00.000Z",
    })

    const first = await GET(request(), routeParams)
    const etag = first.headers.get("ETag")!

    const second = await GET(request(etag), routeParams)
    expect(second.status).toBe(304)
    expect(second.headers.get("ETag")).toBe(etag)
    expect(await second.text()).toBe("")
  })

  it("serves a fresh representation when the snapshot changed", async () => {
    getAiSecurityScoreSnapshot.mockResolvedValueOnce({ score: 82, breakdown: {} })
    const first = await GET(request(), routeParams)
    const etag = first.headers.get("ETag")

    getAiSecurityScoreSnapshot.mockResolvedValueOnce({ score: 91, breakdown: {} })
    const second = await GET(request(etag!), routeParams)
    expect(second.status).toBe(200)
    expect(second.headers.get("ETag")).not.toBe(etag)
  })
})
