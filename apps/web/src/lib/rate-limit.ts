import { env, isProd } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

type RateLimitEntry = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Rate-limit ceilings. The defaults match production. Each can be overridden
// via env so the e2e suite (which fires many auth/api calls from a small set
// of simulated client IPs in rapid succession) does not collide on the
// in-memory per-IP buckets. Production deploys leave these unset, so the
// production limits are unchanged.
const WINDOW_MS = 60_000
const UPSTASH_FAILURE_COOLDOWN_MS = 60_000
const AUTH_MAX = readIntEnv("RATE_LIMIT_AUTH_MAX", 5)
const API_MAX = readIntEnv("RATE_LIMIT_API_MAX", 30)
const HEALTH_MAX = readIntEnv("RATE_LIMIT_HEALTH_MAX", 120)
const LITE_SCAN_MAX = readIntEnv("RATE_LIMIT_LITE_SCAN_MAX", 5)
const APPROVAL_CREATE_MAX = readIntEnv("RATE_LIMIT_APPROVAL_CREATE_MAX", 10)
// Providers may deliver bursts and the idempotency proof intentionally replays
// 100 signed events concurrently. Keep that proof viable while bounding spoofed
// signature-shaped traffic before the route performs cryptographic validation.
const BILLING_WEBHOOK_MAX = readIntEnv("RATE_LIMIT_BILLING_WEBHOOK_MAX", 1_200)

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
/**
 * Team invitations created per workspace per minute. Each invitation mints a
 * 7-day bearer token and (when configured) triggers an outbound email, so an
 * unbounded loop here floods a recipient list and Brevo's quota.
 */
const INVITATION_CREATE_MAX = 10
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
/** Preflight is called on composer interaction; 30/min is far above real use. */
const SCAN_ELIGIBILITY_MAX = 30

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
let upstashRetryAt = 0
let upstashFailureLoggedUntil = 0

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
  } catch {
    // Fail loud: a misconfigured Upstash client silently degrading to
    // per-instance limiting is a security-control failure, not a warning.
    logger.error("Failed to initialize Upstash rate limiter; falling back to in-memory", {
      reason: "initialization_failed",
      cooldownMs: UPSTASH_FAILURE_COOLDOWN_MS,
    })
    return null
  }
}

async function getUpstashClient(): Promise<UpstashClient> {
  if (upstashClient !== null) return upstashClient
  if (!initPromise) {
    initPromise = initUpstash()
      .then((client) => {
        upstashClient = client
        if (!client) {
          upstashRetryAt = Date.now() + UPSTASH_FAILURE_COOLDOWN_MS
          upstashFailureLoggedUntil = upstashRetryAt
        }
        return client
      })
      .finally(() => {
        if (upstashClient === null) initPromise = null
      })
  }
  return initPromise
}

async function checkUpstash(
  lim: number,
  window: Duration,
  identifier: string
): Promise<{ limited: boolean; remaining: number; retryAfter: number } | null> {
  if (!isProd || !upstashConfigured()) return null
  if (Date.now() < upstashRetryAt) return null
  const client = await getUpstashClient()
  if (!client) return null
  const rl = client.getOrCreate(lim, window)
  try {
    const result = await rl.limit(identifier)
    upstashRetryAt = 0
    upstashFailureLoggedUntil = 0
    return {
      limited: !result.success,
      remaining: result.remaining,
      retryAfter: Math.ceil((result.reset - Date.now()) / 1000),
    }
  } catch (error) {
    // Avoid retrying a known-broken dependency on every request. The local
    // limiter keeps requests bounded during the short cooldown; the next
    // request after it expires probes shared limiting again.
    const now = Date.now()
    upstashRetryAt = now + UPSTASH_FAILURE_COOLDOWN_MS
    if (now >= upstashFailureLoggedUntil) {
      upstashFailureLoggedUntil = upstashRetryAt
      const message = error instanceof Error ? error.message : String(error)
      logger.error("Upstash rate-limit check failed; falling back to in-memory", {
        reason: message.includes("max requests limit exceeded")
          ? "quota_exceeded"
          : "request_failed",
        cooldownMs: UPSTASH_FAILURE_COOLDOWN_MS,
      })
    }
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

/** Keep public dependency probes bounded without spending a shared Redis command. */
export function checkHealthRateLimit(ip: string) {
  return checkInMemory(`health:${ip}`, HEALTH_MAX, WINDOW_MS)
}

export async function checkBillingWebhookRateLimit(ip: string) {
  const upstash = await checkUpstash(BILLING_WEBHOOK_MAX, "60 s", `billing-webhook:${ip}`)
  if (upstash) return upstash
  return checkInMemory(`billing-webhook:${ip}`, BILLING_WEBHOOK_MAX, WINDOW_MS)
}

export async function checkLiteScanRateLimit(ipHash: string) {
  const upstash = await checkUpstash(LITE_SCAN_MAX, "60 s", `lite-scan:${ipHash}`)
  if (upstash) return upstash
  return checkInMemory(`lite-scan:${ipHash}`, LITE_SCAN_MAX, WINDOW_MS)
}

/**
 * FREE-plan remote URL scans per client IP per hour. Free tier skips domain
 * verification, so without this a free account can drive server-side reviews
 * of arbitrary third-party sites. Paid plans verify domain control instead.
 * Turnstile on free scan creation is the stronger follow-up; this limit is
 * the bound that ships today.
 */
const FREE_URL_SCAN_MAX = 3
const FREE_URL_SCAN_WINDOW_MS = 60 * 60 * 1000

/** Extract the client IP the same way the edge proxy does (trusted header only). */
export function clientIpFromRequest(request: Request): string {
  const trustedHeader = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase()
  if (!trustedHeader) return "unknown"
  const value = request.headers.get(trustedHeader)
  if (!value) return "unknown"
  const parts = value.split(",")
  return parts[parts.length - 1]!.trim() || "unknown"
}

/** Bounds FREE-plan remote URL reviews per client IP. See FREE_URL_SCAN_MAX. */
export async function checkFreeUrlScanRateLimit(ip: string) {
  const upstash = await checkUpstash(FREE_URL_SCAN_MAX, "1 h", `free-url-scan:${ip}`)
  if (upstash) return upstash
  return checkInMemory(`free-url-scan:${ip}`, FREE_URL_SCAN_MAX, FREE_URL_SCAN_WINDOW_MS)
}

/**
 * READ-ONLY view of the free-URL scan budget (no token consumed). Used by the
 * eligibility preflight so repeated composer interactions cannot burn a
 * caller's hourly free-URL budget without a scan ever starting — the POST
 * path still consumes a token via checkFreeUrlScanRateLimit. Falls back to
 * the in-memory store's current count (best-effort: returns not-limited when
 * no Upstash instance is available, matching the POST path's degraded mode).
 */
export async function peekFreeUrlScanRateLimit(ip: string) {
  if (isProd && upstashConfigured() && Date.now() >= upstashRetryAt) {
    const client = await getUpstashClient()
    if (client) {
      // Reuse the same instance slot; peek via a 0-cost query of remaining.
      // The Ratelimit wrapper exposes limit() only, so approximate the peek by
      // reading the underlying sliding-window data directly is not available —
      // instead report not-limited and let the authoritative POST check gate
      // (the preflight is advisory and clearly labeled as such).
      return { limited: false, remaining: Number.POSITIVE_INFINITY, retryAfter: 0 }
    }
  }
  const now = Date.now()
  sweepExpired(now)
  const entry = store.get(`free-url-scan:${ip}`)
  if (!entry || entry.resetAt < now) {
    return { limited: false, remaining: FREE_URL_SCAN_MAX, retryAfter: 0 }
  }
  if (entry.count >= FREE_URL_SCAN_MAX) {
    return {
      limited: true,
      remaining: 0,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    }
  }
  return { limited: false, remaining: FREE_URL_SCAN_MAX - entry.count, retryAfter: 0 }
}

/** Bounds committed model spend per workspace. See SCAN_CREATE_MAX. */
export async function checkScanCreateRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(SCAN_CREATE_MAX, "60 s", `scan-create:${workspaceId}`)
  if (upstash) return upstash
  return checkInMemory(`scan-create:${workspaceId}`, SCAN_CREATE_MAX, WINDOW_MS)
}

/** Bounds remote MCP approval creation per workspace. */
export async function checkApprovalCreateRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(APPROVAL_CREATE_MAX, "60 s", `approval-create:${workspaceId}`)
  if (upstash) return upstash
  return checkInMemory(`approval-create:${workspaceId}`, APPROVAL_CREATE_MAX, WINDOW_MS)
}

/** Bounds team invitation creation per workspace. See INVITATION_CREATE_MAX. */
export async function checkInvitationCreateRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(INVITATION_CREATE_MAX, "60 s", `invite-create:${workspaceId}`)
  if (upstash) return upstash
  return checkInMemory(`invite-create:${workspaceId}`, INVITATION_CREATE_MAX, WINDOW_MS)
}

// ─── Sprint 10 rate limits ───────────────────────────────────────────────────

/** A-M08: Bounds billing checkout/topup creation per workspace per minute. */
const BILLING_CHECKOUT_MAX = 10
export async function checkBillingCheckoutRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(
    BILLING_CHECKOUT_MAX,
    "60 s",
    `billing-checkout:${workspaceId}`
  )
  if (upstash) return upstash
  return checkInMemory(`billing-checkout:${workspaceId}`, BILLING_CHECKOUT_MAX, WINDOW_MS)
}

// A rate limit bounds volume; it does not make two concurrent checkout requests
// the same operation. Hold this short shared lock while a browser redirect is
// being created so duplicate clicks cannot mint duplicate provider objects.
const BILLING_CHECKOUT_LOCK_SECONDS = 90
const billingCheckoutLocks = new Map<string, number>()
type CheckoutLockRedis = {
  set: (key: string, value: string, options: { nx: true; ex: number }) => Promise<unknown>
}
let checkoutLockRedis: CheckoutLockRedis | null | undefined

function claimLocalBillingCheckoutLock(key: string): boolean {
  const now = Date.now()
  const expiresAt = billingCheckoutLocks.get(key)
  if (expiresAt && expiresAt > now) return false
  billingCheckoutLocks.set(key, now + BILLING_CHECKOUT_LOCK_SECONDS * 1_000)
  return true
}

async function getCheckoutLockRedis(): Promise<CheckoutLockRedis | null> {
  if (!upstashConfigured()) return null
  if (checkoutLockRedis !== undefined) return checkoutLockRedis

  try {
    const { Redis } = await import("@upstash/redis")
    checkoutLockRedis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    }) as CheckoutLockRedis
  } catch {
    checkoutLockRedis = null
    logger.error("Billing checkout lock is unavailable", { reason: "initialization_failed" })
  }
  return checkoutLockRedis
}

/**
 * Claim one provider checkout creation for a workspace/catalog pair.
 * Production never falls back to per-instance state: that could create a
 * duplicate provider object on another replica.
 */
export async function claimBillingCheckoutCreation(input: {
  workspaceId: string
  provider: "polar" | "razorpay"
  kind: "subscription" | "pack"
  catalogKey: string
}): Promise<"claimed" | "duplicate" | "unavailable"> {
  const key = `billing-checkout-lock:${input.workspaceId}:${input.provider}:${input.kind}:${input.catalogKey}`
  if (!isProd) return claimLocalBillingCheckoutLock(key) ? "claimed" : "duplicate"

  const redis = await getCheckoutLockRedis()
  if (!redis) return "unavailable"

  try {
    const claimed = await redis.set(key, "1", { nx: true, ex: BILLING_CHECKOUT_LOCK_SECONDS })
    return claimed ? "claimed" : "duplicate"
  } catch {
    logger.error("Billing checkout lock is unavailable", { reason: "request_failed" })
    return "unavailable"
  }
}

/** B-M02: Bounds license activation/verification per IP per minute. */
const LICENSE_API_MAX = readIntEnv("RATE_LIMIT_LICENSE_API_MAX", 10)
export async function checkLicenseApiRateLimit(ip: string) {
  const upstash = await checkUpstash(LICENSE_API_MAX, "60 s", `license-api:${ip}`)
  if (upstash) return upstash
  return checkInMemory(`license-api:${ip}`, LICENSE_API_MAX, WINDOW_MS)
}

/** C-L02: Bounds affiliate link creation per affiliate per hour. */
const AFFILIATE_LINK_MAX = 10
const AFFILIATE_LINK_WINDOW_MS = 60 * 60 * 1000
export async function checkAffiliateLinkRateLimit(affiliateId: string) {
  const upstash = await checkUpstash(AFFILIATE_LINK_MAX, "1 h", `affiliate-link:${affiliateId}`)
  if (upstash) return upstash
  return checkInMemory(
    `affiliate-link:${affiliateId}`,
    AFFILIATE_LINK_MAX,
    AFFILIATE_LINK_WINDOW_MS
  )
}

/**
 * Bounds the read-only scan-eligibility preflight per workspace. The composer
 * calls this on interaction, so it needs its own (looser) budget distinct from
 * the scan-create limit: eligibility reads entitlement tables and does real
 * work per call, but must not be throttleable into a broken composer UX.
 */
export async function checkScanEligibilityRateLimit(workspaceId: string) {
  const upstash = await checkUpstash(
    SCAN_ELIGIBILITY_MAX,
    "60 s",
    `scan-eligibility:${workspaceId}`
  )
  if (upstash) return upstash
  return checkInMemory(`scan-eligibility:${workspaceId}`, SCAN_ELIGIBILITY_MAX, WINDOW_MS)
}
