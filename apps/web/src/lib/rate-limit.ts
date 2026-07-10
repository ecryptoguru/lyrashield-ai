import { env, isProd } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

type RateLimitEntry = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

const WINDOW_MS = 60_000
const AUTH_MAX = 5
const API_MAX = 30

// Bound the in-memory store so a long-running instance (dev / self-hosted
// without Upstash) can't grow unboundedly with one entry per distinct IP.
let lastSweep = 0
function sweepExpired(now: number) {
  if (now - lastSweep < WINDOW_MS) return
  lastSweep = now
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key)
  }
}

function checkInMemory(
  key: string,
  max: number,
  windowMs: number
): { limited: boolean; remaining: number; retryAfter: number } {
  const now = Date.now()
  sweepExpired(now)
  const entry = store.get(key)

  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { limited: false, remaining: max - 1, retryAfter: 0 }
  }

  entry.count++
  if (entry.count > max) {
    return {
      limited: true,
      remaining: 0,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    }
  }

  return { limited: false, remaining: max - entry.count, retryAfter: 0 }
}

type Duration = `${number} ${"ms" | "s" | "m" | "h" | "d"}`

let ratelimit: {
  slidingWindow: (limit: number, window: Duration, identifier: string) => Promise<{
    success: boolean
    remaining: number
    reset: number
  }>
} | null = null

// Distributed rate limiting requires Upstash's HTTP REST endpoint + token.
// (Note: REDIS_URL is a redis:// URL reserved for the BullMQ job queue and is
// NOT a valid Upstash REST URL — conflating the two silently broke prod limiting.)
function upstashConfigured(): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
}

let warnedDegraded = false
function warnDegradedOnce() {
  if (isProd && !warnedDegraded) {
    warnedDegraded = true
    logger.warn(
      "Rate limiting is running in per-instance in-memory mode in production. " +
        "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for shared, " +
        "horizontally-correct limits."
    )
  }
}

async function initUpstash() {
  if (!upstashConfigured()) {
    warnDegradedOnce()
    return null
  }

  try {
    const { Ratelimit } = await import("@upstash/ratelimit")
    const { Redis } = await import("@upstash/redis")

    const redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    })

    return {
      slidingWindow: async (lim: number, window: Duration, identifier: string) => {
        const rl = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(lim, window),
        })
        const result = await rl.limit(identifier)
        return {
          success: result.success,
          remaining: result.remaining,
          reset: result.reset,
        }
      },
    }
  } catch (error) {
    // Fail loud: a misconfigured Upstash client silently degrading to
    // per-instance limiting is a security-control failure, not a warning.
    logger.error("Failed to initialize Upstash rate limiter; falling back to in-memory", {
      error: String(error),
    })
    return null
  }
}

export async function checkAuthRateLimit(ip: string) {
  if (isProd && upstashConfigured()) {
    if (!ratelimit) ratelimit = await initUpstash()
    if (ratelimit) {
      const result = await ratelimit.slidingWindow(AUTH_MAX, "60 s", `auth:${ip}`)
      return {
        limited: !result.success,
        remaining: result.remaining,
        retryAfter: Math.ceil((result.reset - Date.now()) / 1000),
      }
    }
  }

  return checkInMemory(`auth:${ip}`, AUTH_MAX, WINDOW_MS)
}

export async function checkApiRateLimit(ip: string) {
  if (isProd && upstashConfigured()) {
    if (!ratelimit) ratelimit = await initUpstash()
    if (ratelimit) {
      const result = await ratelimit.slidingWindow(API_MAX, "60 s", `api:${ip}`)
      return {
        limited: !result.success,
        remaining: result.remaining,
        retryAfter: Math.ceil((result.reset - Date.now()) / 1000),
      }
    }
  }

  return checkInMemory(`api:${ip}`, API_MAX, WINDOW_MS)
}
