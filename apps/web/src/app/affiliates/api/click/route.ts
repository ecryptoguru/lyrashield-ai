import { NextResponse, type NextRequest } from "next/server"
import { createHash } from "node:crypto"
import { z } from "zod"
import { detectAttribution } from "@lyrashield/affiliate"
import { parseAffiliateCookie } from "@lyrashield/affiliate"

const ClickSchema = z.object({
  code: z.string().min(1).max(64),
  landingUrl: z.string().url().max(2000).optional(),
  referrer: z.string().max(2000).optional(),
  subid: z.string().max(100).optional(),
})

// ── S6: Rate limiting (in-memory, per-instance) ──────────────────────────────
// Max 10 clicks per IP hash per minute. In production with Upstash, this should
// use the shared rate-limit infrastructure, but a simple in-memory limiter
// provides baseline protection against brute-force click injection.
const CLICK_RATE_MAX = 10
const CLICK_RATE_WINDOW_MS = 60_000
const clickRateStore = new Map<string, { count: number; resetAt: number }>()

function checkClickRateLimit(ipKey: string): { limited: boolean; remaining: number } {
  const now = Date.now()
  // Sweep expired entries occasionally
  if (clickRateStore.size > 10_000) {
    for (const [key, entry] of clickRateStore) {
      if (entry.resetAt < now) clickRateStore.delete(key)
    }
  }
  const entry = clickRateStore.get(ipKey)
  if (!entry || entry.resetAt < now) {
    clickRateStore.set(ipKey, { count: 1, resetAt: now + CLICK_RATE_WINDOW_MS })
    return { limited: false, remaining: CLICK_RATE_MAX - 1 }
  }
  entry.count++
  if (entry.count > CLICK_RATE_MAX) {
    return { limited: true, remaining: 0 }
  }
  return { limited: false, remaining: CLICK_RATE_MAX - entry.count }
}

// ── S6: Bot detection ────────────────────────────────────────────────────────
const BOT_USER_AGENT_PATTERNS = [
  /bot\b/i,
  /crawler\b/i,
  /spider\b/i,
  /headless/i,
  /phantom/i,
  /puppeteer/i,
  /selenium/i,
  /wget/i,
  /curl/i,
  /python-requests/i,
  /scrapy/i,
  /googlebot/i,
  /bingbot/i,
  /slurp/i,
  /duckduckbot/i,
  /baiduspider/i,
  /yandexbot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /discordbot/i,
  /applebot/i,
  /ahrefsbot/i,
  /semrushbot/i,
  /mj12bot/i,
  /dotbot/i,
]

function isBotUserAgent(ua: string | null): boolean {
  if (!ua || ua.trim().length === 0) return true
  return BOT_USER_AGENT_PATTERNS.some((pattern) => pattern.test(ua))
}

function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? "lyrashield-ip-salt-v1"
  return createHash("sha256").update(ip + salt).digest("hex")
}

function getClientIp(request: NextRequest): string | undefined {
  const headers = ["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-forwarded-for"]
  for (const header of headers) {
    const value = request.headers.get(header)
    if (value) {
      const ip = value.split(",")[0]?.trim()
      if (ip) return ip
    }
  }
  return undefined
}

/**
 * Async click capture endpoint.
 * Called by the client-side attribution script when a `?ref=` is detected
 * on a page that the middleware didn't catch (e.g. SPA navigation).
 *
 * S6: Rate limited (max 10 clicks/IP/minute) and bot-detected.
 */
export async function POST(request: NextRequest) {
  // S6: Bot detection — reject requests with no user-agent or known bot UAs
  const rawUserAgent = request.headers.get("user-agent")
  if (isBotUserAgent(rawUserAgent)) {
    return NextResponse.json(
      { success: false, error: "Rejected" },
      { status: 403 }
    )
  }

  // S6: Rate limiting
  const clientIp = getClientIp(request)
  const ipKey = clientIp ? hashIp(clientIp) : "unknown"
  const rateLimit = checkClickRateLimit(ipKey)
  if (rateLimit.limited) {
    return NextResponse.json(
      { success: false, error: "Too many requests" },
      { status: 429, headers: { "Retry-After": "60" } }
    )
  }

  const parsed = ClickSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid click data" },
      { status: 400 }
    )
  }

  const searchParams = new URLSearchParams()
  searchParams.set("ref", parsed.data.code)
  if (parsed.data.subid) searchParams.set("subid", parsed.data.subid)

  const existingCookie = parseAffiliateCookie(request.headers.get("cookie"))

  // C-M02: Read the actual consent state from the __ls_consent cookie
  // instead of hardcoding consentGiven: true. This respects the GDPR
  // consent gate that proxy.ts already enforces.
  const consentCookie = request.headers.get("cookie")
  const consentGiven = consentCookie?.includes("__ls_consent=1") ?? false

  // S3: Hash the IP before passing to attribution
  const ipHash = clientIp ? hashIp(clientIp) : undefined
  // S4: Hash the user-agent before storing
  // C-L01: Use the same salted hashing as proxy.ts for consistency.
  // proxy.ts uses hashWithSalt (salted SHA-256 via Web Crypto), so we
  // replicate that here with the same salt to produce matching hashes.
  const userAgentHash = rawUserAgent
    ? createHash("sha256")
        .update(rawUserAgent + (process.env.IP_HASH_SALT ?? "lyrashield-ip-salt-v1"))
        .digest("hex")
    : undefined

  const result = await detectAttribution({
    pathname: "/",
    searchParams,
    landingUrl: parsed.data.landingUrl,
    referrer: parsed.data.referrer,
    ipHash,
    userAgent: userAgentHash,
    cookieToken: existingCookie,
    consentGiven,
  })

  const response = NextResponse.json({
    success: result.attributed,
    affiliateId: result.affiliateId,
  })

  if (result.setCookie) {
    response.headers.set("Set-Cookie", result.setCookie)
  }

  return response
}
