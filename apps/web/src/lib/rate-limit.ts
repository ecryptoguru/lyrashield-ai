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
const LITE_SCAN_MAX = 5
const APPROVAL_CREATE_MAX = 10
/**
 * Scan starts per workspace per minute.
 *
 * The general API limit is per-IP and generous (30/min) because most API calls are cheap
 * reads. Starting a scan is not cheap: each one can consume up to
 * PLATFORM_MAX_SCAN_BUDGET_USD of model spend, so at the API limit a single caller could
 * commit four figures a minute before per-scan budgets bite. This bounds the money, and it
 * is keyed on the workspace rather than the IP so rotating addresses does not lift it.
 */
const SCAN_CREATE_MAX = 5
/**
 * Free-tier WEB_APP scan starts per client IP per hour.
 *
 * Free-tier web-app scans skip the paid domain-verification proof, so the workspace-keyed
 * limit above is all that stops someone from spinning up fresh free workspaces to scan
 * third-party sites. Keying on the IP keeps that abuse bounded even across fresh
 * workspaces; paid plans are unaffected (their domain proof is the stronger gate).
 * Follow-up: require Turnstile on free-tier WEB_APP scans for a bot check that survives
 * IP rotation.
 */
const FREE_TIER_WEB_APP_SCAN_MAX = 3
const FREE_TIER_WEB_APP_SCAN_WINDOW_MS = 3_600_000

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

// Pre-created Ratelimit instances keyed by "limit:window" to avoid rebuilding
// per call. Populated once during initUpstash.
type RatelimitInstance = {
  limit: (identifier: string) => Promise<{ success: boolean; remaining: number; reset: number }>
}
const ratelimitInstances = new Map<string, RatelimitInstance>()

type UpstashClient = {
  getOrCreate: (lim: number, window: Duration) => RatelimitInstance
} | null

let upstashClient: UpstashClient = null
// Single in-flight init promise so concurrent callers share one initialization.
let initPromise: Promise<UpstashClient> | null = null

async function initUpstash(): Promise<UpstashClient> {
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

    // Pre-create one Ratelimit instance per (limit, window) pair.
    function getOrCreate(lim: number, window: Duration): RatelimitInstance {
      const key = `${lim}:${window}`
      let rl = ratelimitInstances.get(key)
      if (!rl) {
        const instance = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(lim, window) })
        rl = { limit: (id) => instance.limit(id) }
        ratelimitInstances.set(key, rl)
      }
      return rl
    }

    return { getOrCreate }
  } catch (error) {
    // Fail loud: a misconfigured Upstash client silently degrading to
    // per-instance limiting is a security-control failure, not a warning.
    logger.error("Failed to initialize Upstash rate limiter; falling back to in-memory", {
      error: String(error),
    })
    return null
  }
}

async function getUpstashClient(): Promise<UpstashClient> {
  if (upstashClient !== null) return upstashClient
  if (!initPromise) initPromise = initUpstash().then((client) => (upstashClient = client))
  return initPromise
}

async function checkUpstash(
  lim: number,
  window: Duration,
  identifier: string
): Promise<{ limited: boolean; remaining: number; retryAfter: number } | null> {
  if (!isProd || !upstashConfigured()) return null
  const client = await getUpstashClient()
  if (!client) return null
  const rl = client.getOrCreate(lim, window)
  try {
    const result = await rl.limit(identifier)
    return {
      limited: !result.success,
      remaining: result.remaining,
      retryAfter: Math.ceil((result.reset - Date.now()) / 1000),
    }
  } catch (error) {
    // Treat Upstash failures as a transient outage: log once and fall back to
    // per-instance in-memory limiting rather than failing the request.
    logger.error("Upstash rate-limit check failed; falling back to in-memory", {
      identifier,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function checkAuthRateLimit(ip: string) {
  const upstash = await checkUpstash(AUTH_MAX, "60 s", `auth:${ip}`)
  if (upstash) return upstash
  return checkInMemory(`auth:${ip}`, AUTH_MAX, WINDOW_MS)
}

export async function checkApiRateLimit(ip: string) {
  const upstash = await checkUpstash(API_MAX, "60 s", `api:${ip}`)
  if (upstash) return upstash
  return checkInMemory(`api:${ip}`, API_MAX, WINDOW_MS)
}

export async function checkLiteScanRateLimit(ipHash: string) {
  const upstash = await checkUpstash(LITE_SCAN_MAX, "60 s", `lite-scan:${ipHash}`)
  if (upstash) return upstash
  return checkInMemory(`lite-scan:${ipHash}`, LITE_SCAN_MAX, WINDOW_MS)
}

/** Bounds committed model spend per workspace. See SCAN_CREATE_MAX. */
export async function checkScanCreateRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(SCAN_CREATE_MAX, "60 s", `scan-create:${workspaceId}`)
  if (upstash) return upstash
  return checkInMemory(`scan-create:${workspaceId}`, SCAN_CREATE_MAX, WINDOW_MS)
}

/** Bounds free-tier WEB_APP scan starts per client IP. See FREE_TIER_WEB_APP_SCAN_MAX. */
export async function checkFreeTierWebAppScanRateLimit(ip: string) {
  const upstash = await checkUpstash(
    FREE_TIER_WEB_APP_SCAN_MAX,
    "1 h",
    `free-webapp-scan:${ip}`
  )
  if (upstash) return upstash
  return checkInMemory(`free-webapp-scan:${ip}`, FREE_TIER_WEB_APP_SCAN_MAX, FREE_TIER_WEB_APP_SCAN_WINDOW_MS)
}

/** Bounds remote MCP approval creation per workspace. */
export async function checkApprovalCreateRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(APPROVAL_CREATE_MAX, "60 s", `approval-create:${workspaceId}`)
  if (upstash) return upstash
  return checkInMemory(`approval-create:${workspaceId}`, APPROVAL_CREATE_MAX, WINDOW_MS)
}
