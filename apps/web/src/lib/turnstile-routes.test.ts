import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  issue: vi.fn(),
  identity: vi.fn(),
  collect: vi.fn(),
  mint: vi.fn(),
}))
vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = mocks.set
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: { MYRA_PUBLIC_ENABLED: "1" } }))
vi.mock("@lyrashield/myra/server", () => ({
  resolveMyraRequest: async (request: Request) =>
    request.url.endsWith("/session")
      ? null
      : { principal: { kind: "anonymous", publicSessionId: "fixture" } },
  issuePublicSession: mocks.issue,
  requestIdentityCode: mocks.identity,
}))
vi.mock("@/lib/api-auth", () => ({
  withApiRequest: (handler: unknown) => handler,
  withCookieMutation: (handler: unknown) => handler,
}))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit: async () => ({ limited: false }),
  clientIpFromRequest: () => "203.0.113.1",
}))
vi.mock("@lyrashield/security", () => ({
  checkScanUrlSafe: async () => ({ safe: true }),
  collectPublicSurface: mocks.collect,
  analyzeLiteSurface: () => ({ checks: [] }),
  buildLiteScorecardPayload: () => ({}),
}))
vi.mock("./lite-scorecard", () => ({ createLiteScorecardToken: mocks.mint }))

const routes = [
  {
    name: "session",
    post: (await import("../app/api/myra/session/route")).POST,
    body: { surface: "MARKETING" },
    status: 200,
  },
  {
    name: "identity",
    post: (await import("../app/api/myra/identity/request/route")).POST,
    body: { email: "visitor@example.test", purpose: "support_case" },
    status: 200,
  },
  {
    name: "scan",
    post: (await import("../app/api/lite-scan/route")).POST,
    body: { url: "https://example.com", authorized: true },
    status: 200,
  },
  {
    name: "scorecard",
    post: (await import("../app/api/lite-scorecards/route")).POST,
    body: { needsAttention: 0, worthReviewing: 0, looksOk: 1 },
    status: 201,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  const consumed = new Set<string>()
  mocks.set.mockImplementation(async (key: string) => {
    if (consumed.has(key)) return null
    consumed.add(key)
    return "OK"
  })
  mocks.issue.mockResolvedValue({ token: randomUUID(), publicSessionId: randomUUID() })
  mocks.mint.mockReturnValue("synthetic")
  mocks.collect.mockResolvedValue({
    subjects: [
      { kind: "document", finalUrl: "https://example.com", body: "", headers: {}, status: 200 },
    ],
  })
  vi.stubEnv("TURNSTILE_SECRET_KEY", randomUUID())
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.test")
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", randomUUID())
  vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://lyrashieldai.com")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, challenge_ts: new Date().toISOString() }))
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function request(body: unknown, proof: string, name: string) {
  return new Request(`https://app.lyrashieldai.com/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://lyrashieldai.com" },
    body: JSON.stringify({ ...(body as object), turnstileToken: proof }),
  })
}

describe("global proof consumption across public endpoints", () => {
  it.each(routes)(
    "a proof consumed by $name cannot be reused by any public endpoint",
    async (first) => {
      const proof = randomUUID()
      expect((await first.post(request(first.body, proof, first.name) as never)).status).toBe(
        first.status
      )
      const before = [mocks.issue, mocks.identity, mocks.collect, mocks.mint].map(
        (mock) => mock.mock.calls.length
      )
      for (const route of routes) {
        const response = await route.post(request(route.body, ` \t${proof}\n`, route.name) as never)
        expect(response.status).toBe(403)
        const body = await response.json()
        expect(typeof body.error === "string" ? body.message : body.error.message).toBe(
          "Complete verification again, then retry."
        )
      }
      expect(
        [mocks.issue, mocks.identity, mocks.collect, mocks.mint].map(
          (mock) => mock.mock.calls.length
        )
      ).toEqual(before)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("does not reopen consumption after session issuance fails", async () => {
    const session = routes[0]!
    const proof = randomUUID()
    mocks.issue.mockRejectedValue(new Error("database unavailable"))
    expect((await session.post(request(session.body, proof, session.name) as never)).status).toBe(
      500
    )
    expect((await session.post(request(session.body, proof, session.name) as never)).status).toBe(
      403
    )
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })
})
