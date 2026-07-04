import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock @lyrashield/config before importing rate-limit
// This prevents the Prisma client from being loaded
vi.mock("@lyrashield/config", () => ({
  env: { REDIS_URL: "", BREVO_API_KEY: "" },
  isProd: false,
}))

const { checkAuthRateLimit, checkApiRateLimit } = await import("./rate-limit")

describe("Rate Limiter", () => {
  beforeEach(() => {
    // Clear the module cache to reset in-memory store between tests
    vi.resetModules()
  })

  describe("checkAuthRateLimit (in-memory, 5/min)", () => {
    it("should allow first request", async () => {
      const result = await checkAuthRateLimit("10.0.0.1")
      expect(result.limited).toBe(false)
      expect(result.remaining).toBe(4)
      expect(result.retryAfter).toBe(0)
    })

    it("should allow up to 5 requests", async () => {
      for (let i = 0; i < 4; i++) {
        const result = await checkAuthRateLimit("10.0.0.2")
        expect(result.limited).toBe(false)
      }
      const fifth = await checkAuthRateLimit("10.0.0.2")
      expect(fifth.limited).toBe(false)
      expect(fifth.remaining).toBe(0)
    })

    it("should block 6th request", async () => {
      for (let i = 0; i < 5; i++) {
        await checkAuthRateLimit("10.0.0.3")
      }
      const sixth = await checkAuthRateLimit("10.0.0.3")
      expect(sixth.limited).toBe(true)
      expect(sixth.remaining).toBe(0)
      expect(sixth.retryAfter).toBeGreaterThan(0)
    })

    it("should track IPs independently", async () => {
      for (let i = 0; i < 5; i++) {
        await checkAuthRateLimit("10.0.0.4")
      }
      const blockedIp = await checkAuthRateLimit("10.0.0.4")
      const differentIp = await checkAuthRateLimit("10.0.0.5")
      expect(blockedIp.limited).toBe(true)
      expect(differentIp.limited).toBe(false)
    })
  })

  describe("checkApiRateLimit (in-memory, 30/min)", () => {
    it("should allow first request", async () => {
      const result = await checkApiRateLimit("192.168.1.1")
      expect(result.limited).toBe(false)
      expect(result.remaining).toBe(29)
    })

    it("should allow up to 30 requests", async () => {
      for (let i = 0; i < 29; i++) {
        const result = await checkApiRateLimit("192.168.1.2")
        expect(result.limited).toBe(false)
      }
      const thirtieth = await checkApiRateLimit("192.168.1.2")
      expect(thirtieth.limited).toBe(false)
      expect(thirtieth.remaining).toBe(0)
    })

    it("should block 31st request", async () => {
      for (let i = 0; i < 30; i++) {
        await checkApiRateLimit("192.168.1.3")
      }
      const thirtyFirst = await checkApiRateLimit("192.168.1.3")
      expect(thirtyFirst.limited).toBe(true)
      expect(thirtyFirst.remaining).toBe(0)
      expect(thirtyFirst.retryAfter).toBeGreaterThan(0)
    })

    it("should track auth and API limits independently per IP", async () => {
      const ip = "172.16.0.1"
      // Use 5 auth requests (max)
      for (let i = 0; i < 5; i++) {
        await checkAuthRateLimit(ip)
      }
      // Auth should be blocked
      const authResult = await checkAuthRateLimit(ip)
      expect(authResult.limited).toBe(true)

      // API should still have full budget
      const apiResult = await checkApiRateLimit(ip)
      expect(apiResult.limited).toBe(false)
      expect(apiResult.remaining).toBe(29)
    })
  })
})
