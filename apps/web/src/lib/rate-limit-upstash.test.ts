import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  loggerError: vi.fn(),
  redisInitError: false,
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
  },
  isProd: true,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn() },
}))
vi.mock("@upstash/redis", () => ({
  Redis: class Redis {
    constructor() {
      if (mocks.redisInitError) throw new Error("init failed with test-token")
    }
  },
}))
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow() {
      return {}
    }

    limit = mocks.limit
  },
}))

const { checkApiRateLimit, checkAuthRateLimit } = await import("./rate-limit")

describe.sequential("Upstash rate-limit failure cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-25T00:00:00Z"))
    mocks.limit.mockReset()
    mocks.loggerError.mockReset()
    mocks.redisInitError = false
  })

  afterEach(() => vi.useRealTimers())

  it("retries a redacted initialization failure after the cooldown", async () => {
    mocks.redisInitError = true
    expect((await checkApiRateLimit("203.0.113.1")).limited).toBe(false)
    expect(mocks.loggerError).toHaveBeenCalledExactlyOnceWith(
      "Failed to initialize Upstash rate limiter; falling back to in-memory",
      { reason: "initialization_failed", cooldownMs: 60_000 }
    )

    mocks.redisInitError = false
    mocks.limit.mockResolvedValue({ success: true, remaining: 99, reset: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(60_000)

    expect((await checkApiRateLimit("203.0.113.1")).limited).toBe(false)
    expect(mocks.limit).toHaveBeenCalledTimes(1)
  })

  it("backs off failed checks and logs one redacted error per cooldown", async () => {
    mocks.limit.mockRejectedValue(new Error("ERR max requests limit exceeded for 203.0.113.10"))

    expect((await checkApiRateLimit("203.0.113.10")).limited).toBe(false)
    expect((await checkAuthRateLimit("198.51.100.4")).limited).toBe(false)

    expect(mocks.limit).toHaveBeenCalledTimes(1)
    expect(mocks.loggerError).toHaveBeenCalledExactlyOnceWith(
      "Upstash rate-limit check failed; falling back to in-memory",
      { reason: "quota_exceeded", cooldownMs: 60_000 }
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect((await checkAuthRateLimit("192.0.2.8")).limited).toBe(false)
    expect(mocks.limit).toHaveBeenCalledTimes(2)
    expect(mocks.loggerError).toHaveBeenCalledTimes(2)
  })
})
