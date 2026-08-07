import { analyzeLiteSurface, checkScanUrlSafe, safeFetch } from "@lyrashield/security"
import { logger } from "@lyrashield/logger"
import { z } from "zod"

export const dynamic = "force-dynamic"

const bodySchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    authorized: z.literal(true),
    turnstileToken: z.string().trim().max(4096).optional(),
  })
  .strict()

const PAGE_MAX_BYTES = 4 * 1024 * 1024
const ASSET_MAX_BYTES = 750 * 1024
const MAX_ASSETS = 6
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 10_000
const USER_AGENT = "LyraShield-Lite/1.0 (passive public-surface check)"

function trustedOrigins(): Set<string> {
  const values = [process.env.NEXT_PUBLIC_MARKETING_URL, process.env.NEXT_PUBLIC_APP_URL]
  return new Set(
    values.flatMap((value) => {
      if (!value) return []
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    })
  )
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin")
  if (!origin || !trustedOrigins().has(origin)) return {}
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  }
}

function response(request: Request, body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin")
  return origin ? trustedOrigins().has(origin) : false
}

type TurnstileOutcome = "success" | "failed" | "transient-error"

async function verifyTurnstileOnce(
  token: string,
  secret: string
): Promise<TurnstileOutcome> {
  try {
    const body = new URLSearchParams({ secret, response: token })
    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5_000),
    })
    const result = (await verification.json()) as { success?: boolean }
    return result.success === true ? "success" : "failed"
  } catch {
    // Network timeout / DNS / connection reset — transient, worth a retry.
    return "transient-error"
  }
}

/**
 * Verify a Turnstile token, retrying transient network failures (timeout,
 * connection reset) up to TURNSTILE_MAX_RETRIES times with linear backoff.
 * A definitive `success: false` is NOT retried — that is a real bot-check
 * failure, not a transient outage.
 */
async function verifyTurnstile(token: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return false
  if (!token) return false

  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const outcome = await verifyTurnstileOnce(token, secret)
    if (outcome === "success") return true
    if (outcome === "failed") return false
    // transient-error: back off before the next attempt (skip after the last)
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  // All attempts hit transient errors — fail closed (treat as bot-check failure).
  return false
}

function linkedSameOriginAssets(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin
  const urls = new Set<string>()
  const attributes = html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)
  for (const match of attributes) {
    const raw = match[1]
    if (!raw) continue
    try {
      const url = new URL(raw, pageUrl)
      if (url.origin !== origin || !/\.(?:m?js|css)(?:$|\?)/i.test(url.pathname + url.search))
        continue
      url.hash = ""
      urls.add(url.toString())
      if (urls.size >= MAX_ASSETS) break
    } catch {
      // Ignore malformed public asset references.
    }
  }
  return [...urls]
}

async function fetchPublicAssets(html: string, pageUrl: string): Promise<string> {
  const origin = new URL(pageUrl).origin
  const results = await Promise.all(
    linkedSameOriginAssets(html, pageUrl).map((url) =>
      safeFetch(url, {
        timeoutMs: TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
        maxBytes: ASSET_MAX_BYTES,
        userAgent: USER_AGENT,
      })
    )
  )
  return results
    .filter((result) => {
      if (!result) return false
      try {
        return new URL(result.finalUrl).origin === origin
      } catch {
        return false
      }
    })
    .map((result) => result!.html)
    .join("\n")
}

export function OPTIONS(request: Request): Response {
  if (!isOriginAllowed(request)) return response(request, { error: "forbidden" }, 403)
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: Request): Promise<Response> {
  if (!isOriginAllowed(request)) return response(request, { error: "forbidden" }, 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return response(request, { error: "invalid_url", message: "Enter a valid public URL." }, 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return response(
      request,
      {
        error: "invalid_url",
        message: "Enter a public URL and confirm you are authorized to scan it.",
      },
      400
    )
  }

  if (!(await verifyTurnstile(parsed.data.turnstileToken))) {
    return response(
      request,
      { error: "bot_check_failed", message: "Please retry the abuse check." },
      403
    )
  }

  const safety = await checkScanUrlSafe(parsed.data.url)
  if (!safety.safe) {
    return response(
      request,
      { error: "ssrf_blocked", message: "That URL cannot be checked from this public tool." },
      400
    )
  }

  const startedAt = Date.now()
  const page = await safeFetch(parsed.data.url, {
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    maxBytes: PAGE_MAX_BYTES,
    userAgent: USER_AGENT,
  })
  if (!page) {
    return response(
      request,
      {
        error: "unreachable",
        message: "We could not read that public page. Check the URL and try again.",
      },
      422
    )
  }

  try {
    const publicAssetText = await fetchPublicAssets(page.html, page.finalUrl)
    const result = analyzeLiteSurface({
      target: page.finalUrl,
      html: page.html,
      publicAssetText,
      headers: page.headers,
      status: page.status,
    })
    return response(request, { result, durationMs: Date.now() - startedAt }, 200)
  } catch (error) {
    logger.error("Lite Check failed after passive fetch", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return response(
      request,
      { error: "scan_error", message: "The passive check could not finish." },
      500
    )
  }
}
