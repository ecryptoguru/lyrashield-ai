import { env, isProd } from "@lyrashield/config"

type RateLimitEntry = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

const WINDOW_MS = 60_000
const AUTH_MAX = 5
const API_MAX = 30

function checkInMemory(
  key: string,
  max: number,
  windowMs: number
): { limited: boolean; remaining: number; retryAfter: number } {
  const now = Date.now()
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

async function initUpstash() {
  if (!isProd || !env.REDIS_URL) return null

  try {
    const { Ratelimit } = await import("@upstash/ratelimit")
    const { Redis } = await import("@upstash/redis")

    const redis = new Redis({
      url: env.REDIS_URL,
      token: "",
    })

    return {
      slidingWindow: async (lim: number, window: `${number} ${"ms" | "s" | "m" | "h" | "d"}`, identifier: string) => {
        const rl = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(lim, window),
        })
        const result = await rl.limit(identifier)
        return {
          success: result.success,
          remaining: result.remaining,
          reset: Date.now() + result.reset,
        }
      },
    }
  } catch {
    return null
  }
}

export async function checkAuthRateLimit(ip: string) {
  if (isProd && env.REDIS_URL) {
    if (!ratelimit) ratelimit = await initUpstash()
    if (ratelimit) {
      const result = await ratelimit.slidingWindow(
        AUTH_MAX,
        "60 s",
        `auth:${ip}`
      )
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
  if (isProd && env.REDIS_URL) {
    if (!ratelimit) ratelimit = await initUpstash()
    if (ratelimit) {
      const result = await ratelimit.slidingWindow(
        API_MAX,
        "60 s",
        `api:${ip}`
      )
      return {
        limited: !result.success,
        remaining: result.remaining,
        retryAfter: Math.ceil((result.reset - Date.now()) / 1000),
      }
    }
  }

  return checkInMemory(`api:${ip}`, API_MAX, WINDOW_MS)
}
