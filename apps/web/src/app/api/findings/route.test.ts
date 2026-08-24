import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

const listFindings = vi.fn()
const getFindingStats = vi.fn()
const requirePermission = vi.fn()

vi.mock("@lyrashield/db", () => ({ listFindings, getFindingStats }))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

const { GET } = await import("./route")

function finding(id: string, severity: string, createdAt: string, environment?: string | null) {
  return {
    id,
    title: `Finding ${id}`,
    summary: "summary",
    severity,
    status: "OPEN",
    verified: false,
    verificationStatus: "DETECTED",
    verificationMethod: null,
    verificationReason: null,
    confidence: "medium",
    cwe: null,
    cvssScore: null,
    target: environment
      ? { id: `target-${id}`, name: `Target ${id}`, type: "WEB_APP", environment }
      : null,
    _count: { evidence: 0, fixProposals: 0 },
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
  }
}

describe("GET /api/findings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    getFindingStats.mockResolvedValue({ total: 0 })
  })

  it("authorizes before reading findings", async () => {
    listFindings.mockResolvedValue({ items: [], nextCursor: null })

    const response = await GET(new Request("http://localhost/api/findings?workspaceId=ws-1"))

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "finding:view")
    expect(listFindings).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", limit: 50 })
    )
  })

  it("rejects without the finding:view permission", async () => {
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await GET(new Request("http://localhost/api/findings?workspaceId=ws-1"))

    expect(response.status).toBe(403)
    expect(listFindings).not.toHaveBeenCalled()
  })

  it("adds explainable priority to every item in the page", async () => {
    listFindings.mockResolvedValue({
      items: [finding("a", "HIGH", "2026-08-01T00:00:00.000Z", "PRODUCTION")],
      nextCursor: null,
    })

    const response = await GET(new Request("http://localhost/api/findings?workspaceId=ws-1"))
    const body = await response.json()

    expect(body.data.items[0]).toMatchObject({
      id: "a",
      priority: {
        score: expect.any(Number),
        band: expect.any(String),
        reasons: expect.arrayContaining(["High severity"]),
        limitations: expect.arrayContaining([
          "Priority is heuristic triage context, not proof of exploitability or reachability.",
        ]),
      },
    })
  })

  it("sorts only the returned page by priority then severity then creation", async () => {
    listFindings.mockResolvedValue({
      items: [
        // HIGH production unverified (60+10+2=72) -> second despite oldest creation.
        finding("a", "HIGH", "2026-08-01T00:00:00.000Z", "PRODUCTION"),
        // CRITICAL staging unverified (60+4+2=66) -> first.
        finding("b", "CRITICAL", "2026-08-03T00:00:00.000Z", "STAGING"),
        // MEDIUM production unverified (30+10+2=42) -> third.
        finding("c", "MEDIUM", "2026-08-02T00:00:00.000Z", "PRODUCTION"),
      ],
      nextCursor: null,
    })

    const response = await GET(new Request("http://localhost/api/findings?workspaceId=ws-1"))
    const body = await response.json()

    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual(["b", "a", "c"])
    const scores = body.data.items.map((item: { priority: { score: number } }) => item.priority.score)
    expect(scores[0]).toBeGreaterThan(scores[1]!)
    expect(scores[1]).toBeGreaterThan(scores[2]!)
  })

  it("keeps the database-derived nextCursor despite page-local sorting", async () => {
    listFindings.mockResolvedValue({
      items: [
        finding("a", "MEDIUM", "2026-08-01T00:00:00.000Z", "PRODUCTION"),
        finding("b", "HIGH", "2026-08-02T00:00:00.000Z", "STAGING"),
      ],
      nextCursor: "finding-b",
    })

    const response = await GET(new Request("http://localhost/api/findings?workspaceId=ws-1"))
    const body = await response.json()

    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual(["b", "a"])
    expect(body.data.nextCursor).toBe("finding-b")
  })

  it("preserves the stats path", async () => {
    const response = await GET(
      new Request("http://localhost/api/findings?workspaceId=ws-1&stats=true")
    )
    const body = await response.json()

    expect(getFindingStats).toHaveBeenCalledWith("ws-1", undefined)
    expect(body.data).toEqual({ total: 0 })
    expect(listFindings).not.toHaveBeenCalled()
  })

  it("passes filters and pagination through to the service", async () => {
    listFindings.mockResolvedValue({ items: [], nextCursor: null })

    await GET(
      new Request(
        "http://localhost/api/findings?workspaceId=ws-1&targetId=target-1&scanId=scan-1&severity=HIGH&status=OPEN&verified=true&category=Secrets&cursor=finding-9&limit=100"
      )
    )

    expect(listFindings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      scanId: "scan-1",
      severity: "HIGH",
      status: "OPEN",
      verified: true,
      category: "Secrets",
      cursor: "finding-9",
      limit: 100,
    })
  })
})
