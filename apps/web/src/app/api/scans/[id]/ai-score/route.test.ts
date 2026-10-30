import { resolveOAuthReadScope } from "../../../../../../../../packages/auth/src/oauth-read-scope"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getAiSecurityScoreSnapshot = vi.fn()
const scanFindFirst = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getAiSecurityScoreSnapshot,
  withWorkspaceRLS: (_workspaceId: string, callback: (tx: unknown) => unknown) =>
    callback({ scan: { findFirst: scanFindFirst } }),
}))
vi.mock("@lyrashield/auth/server", () => ({
  resolveOAuthReadScope,
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

it.each([{ targetIds: ["target-1"] }, { targetIds: [] }])(
  "denies an ungranted stored scan before score/conditional reads $targetIds",
  async ({ targetIds }) => {
    vi.clearAllMocks()
    const { requirePermission } = await import("@lyrashield/auth/server")
    vi.mocked(requirePermission).mockResolvedValueOnce({
      session: {
        oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: targetIds },
      },
    } as never)
    scanFindFirst.mockResolvedValueOnce({ targetId: "target-2" })
    getAiSecurityScoreSnapshot.mockResolvedValueOnce({ score: 82, breakdown: {} })
    const response = await GET(request('"known-etag"'), routeParams)
    expect(response.status).toBe(403)
    expect(getAiSecurityScoreSnapshot).not.toHaveBeenCalled()
  }
)

it.each([
  {
    name: "selected allowed target",
    oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: ["target-1"] },
  },
  {
    name: "all-target connection",
    oauth: { connectionId: "conn-1", allTargets: true, allowedTargetIds: [] },
  },
  { name: "browser session", oauth: undefined },
])("preserves score and matching conditional reads for $name", async ({ oauth }) => {
  vi.clearAllMocks()
  const { requirePermission } = await import("@lyrashield/auth/server")
  vi.mocked(requirePermission).mockResolvedValue({ session: { oauth } } as never)
  scanFindFirst.mockReset().mockResolvedValue({ targetId: "target-1" })
  getAiSecurityScoreSnapshot.mockReset().mockResolvedValue({ score: 82, breakdown: {} })
  const first = await GET(request(), routeParams)
  expect(first.status).toBe(200)
  const second = await GET(request(first.headers.get("ETag")!), routeParams)
  expect(second.status).toBe(304)
  expect(await second.text()).toBe("")
})

it("rejects a cached score after a grant narrows to another target", async () => {
  const { requirePermission } = await import("@lyrashield/auth/server")
  vi.mocked(requirePermission).mockResolvedValueOnce({
    session: { oauth: { connectionId: "conn-1", allTargets: true } },
  } as never)
  getAiSecurityScoreSnapshot.mockReset().mockResolvedValue({ score: 82, breakdown: {} })
  const first = await GET(request(), routeParams)
  expect(first.status).toBe(200)
  vi.clearAllMocks()
  vi.mocked(requirePermission).mockResolvedValueOnce({
    session: {
      oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: ["target-1"] },
    },
  } as never)
  scanFindFirst.mockResolvedValueOnce({ targetId: "target-2" })
  const response = await GET(request(first.headers.get("ETag")!), routeParams)
  expect(response.status).toBe(403)
  expect(getAiSecurityScoreSnapshot).not.toHaveBeenCalled()
})
