import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prod: false,
  configured: false,
  limit: vi.fn(),
  initError: false,
}))
vi.mock("@lyrashield/config", () => ({
  get isProd() {
    return mocks.prod
  },
  env: {
    get UPSTASH_REDIS_REST_URL() {
      return mocks.configured ? "https://example.upstash.io" : ""
    },
    get UPSTASH_REDIS_REST_TOKEN() {
      return mocks.configured ? "test-token" : ""
    },
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      if (mocks.initError) throw new Error("bad secret")
    }
  },
}))
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow() {
      return {}
    }
    limit = mocks.limit
  },
}))

const input = { workspaceId: "ws-1", userId: "user-1", channel: "slack" as const }
describe("notification test rate limiting", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mocks.prod = false
    mocks.configured = false
    mocks.initError = false
  })

  it("bounds each user/workspace/channel to three explicit tests per minute locally", async () => {
    const { checkNotificationTestRateLimit: check } = await import("./rate-limit")
    for (let count = 0; count < 3; count++) expect((await check(input)).limited).toBe(false)
    expect(await check(input)).toEqual({
      limited: true,
      remaining: 0,
      retryAfter: expect.any(Number),
      unavailable: false,
    })
    expect((await check({ ...input, channel: "discord" })).limited).toBe(false)
    expect((await check({ ...input, workspaceId: "ws-2" })).limited).toBe(false)
    expect((await check({ ...input, userId: "user-2" })).limited).toBe(false)
  })

  it("requires shared rate limiting in production", async () => {
    mocks.prod = true
    const { checkNotificationTestRateLimit } = await import("./rate-limit")
    expect(await checkNotificationTestRateLimit(input)).toEqual({
      limited: true,
      remaining: 0,
      retryAfter: 60,
      unavailable: true,
    })
  })

  it("uses a shared key bound to all three identity dimensions", async () => {
    mocks.prod = true
    mocks.configured = true
    mocks.limit.mockResolvedValue({ success: true, remaining: 2, reset: Date.now() + 60_000 })
    const { checkNotificationTestRateLimit } = await import("./rate-limit")
    expect((await checkNotificationTestRateLimit(input)).unavailable).toBe(false)
    expect(mocks.limit).toHaveBeenCalledWith(
      `notification-test:${JSON.stringify([input.workspaceId, input.userId, input.channel])}`
    )
  })

  it.each(["initialization", "request"])("fails closed on Redis %s failure", async (failure) => {
    mocks.prod = true
    mocks.configured = true
    mocks.initError = failure === "initialization"
    mocks.limit.mockRejectedValue(new Error("secret failure"))
    const { checkNotificationTestRateLimit } = await import("./rate-limit")
    expect(await checkNotificationTestRateLimit(input)).toEqual({
      limited: true,
      remaining: 0,
      retryAfter: 60,
      unavailable: true,
    })
  })
})
