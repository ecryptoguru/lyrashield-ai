import type { APIRoute } from "astro"
import { z } from "zod"
import { getSecret } from "astro:env/server"
import { env } from "cloudflare:workers"
import { createHash } from "node:crypto"
import { parseBoundedBody, RequestBodyError } from "../../lib/request-body"
import { checkD1RateLimit, getClientIp } from "../../lib/waitlist-rate-limit"

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((v) => v || undefined),
  building: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => v || undefined),
  source: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((v) => v || undefined),
  utmSource: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  utmMedium: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  utmCampaign: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  referrer: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || undefined),
  website: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/)
    .optional(),
})

export const prerender = false

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept") || ""
  return accept.includes("text/html")
}

function isTrustedOrigin(request: Request, siteOrigin: string): boolean {
  const origin = request.headers.get("origin")
  const referer = request.headers.get("referer")

  if (origin) {
    try {
      return new URL(origin).origin === siteOrigin
    } catch {
      return false
    }
  }

  if (referer) {
    try {
      return new URL(referer).origin === siteOrigin
    } catch {
      return false
    }
  }

  return true
}

function htmlResponse(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LyraShield AI — Waitlist</title></head><body style="background:#0a0c0e;color:#e6e9ec;font-family:system-ui,sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;line-height:1.6">${body}<p style="margin-top:2rem"><a href="/" style="color:#2dd4a7">Back to home</a></p></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  )
}

function successResponse(request: Request, referralCode: string): Response {
  // Always identical shape regardless of insert/duplicate/honeypot — never leak signup state.
  // A referralCode is ALWAYS present: real for inserts, the existing row's code for
  // duplicates, and a decoy for honeypots, so the response is indistinguishable.
  if (acceptsHtml(request)) {
    return htmlResponse(201, "<p>You're on the list. One email when your invite is ready.</p>")
  }
  return new Response(JSON.stringify({ success: true, referralCode }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  })
}

function makeReferralCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}

export const POST: APIRoute = async ({ request, site }) => {
  const rawSiteOrigin =
    site?.origin ??
    (import.meta.env.PUBLIC_SITE_URL as string | undefined) ??
    "http://localhost:4321"
  const siteOrigin = rawSiteOrigin.endsWith("/") ? rawSiteOrigin.slice(0, -1) : rawSiteOrigin

  if (!isTrustedOrigin(request, siteOrigin)) {
    if (acceptsHtml(request)) {
      return htmlResponse(403, "<p>This request is not allowed.</p>")
    }
    return new Response(
      JSON.stringify({ error: "forbidden", message: "This request is not allowed." }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    )
  }

  const salt = getSecret("WAITLIST_IP_SALT")
  if (!salt) {
    if (acceptsHtml(request)) {
      return htmlResponse(500, "<p>Server configuration error.</p>")
    }
    return new Response(
      JSON.stringify({ error: "server", message: "Server configuration error." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    )
  }

  const ip = getClientIp(request)
  const ipHash = createHash("sha256").update(`${ip}:${salt}`).digest("hex")

  let body: Record<string, unknown>
  try {
    body = await parseBoundedBody(request)
  } catch (error) {
    if (!(error instanceof RequestBodyError)) throw error
    if (acceptsHtml(request)) {
      return htmlResponse(error.status, `<p>${error.message}</p>`)
    }
    return new Response(JSON.stringify({ error: error.code, message: error.message }), {
      status: error.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  const parsed = bodySchema.safeParse(body)

  if (!parsed.success) {
    const emailIssue = parsed.error.issues.find((i) => i.path[0] === "email")
    const message = emailIssue ? "Please enter a valid email address." : "Please check your input."
    if (acceptsHtml(request)) {
      return htmlResponse(400, `<p>${message}</p>`)
    }
    return new Response(JSON.stringify({ error: "invalid_input", message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const db = env.DB as Env["DB"]
  const rateLimit = env.WAITLIST_RL as Env["WAITLIST_RL"] | undefined

  let allowed = true
  if (rateLimit) {
    try {
      const result = await rateLimit.limit({ key: ipHash })
      allowed = result.success
    } catch {
      // Binding present but errored — fall back to the D1 limiter rather than failing open blindly.
      allowed = await checkD1RateLimit(db, ipHash)
    }
  } else {
    allowed = await checkD1RateLimit(db, ipHash)
  }

  if (!allowed) {
    if (acceptsHtml(request)) {
      return htmlResponse(429, "<p>Too many attempts — try again in a minute.</p>")
    }
    return new Response(JSON.stringify({ error: "rate_limited", message: "Too many attempts." }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    })
  }

  const { website, referralCode: referredBy, ...data } = parsed.data
  if (website) {
    // Honeypot tripped — return the exact same generic success as a real signup so a bot
    // (or a human probing the endpoint) can't distinguish "rejected" from "accepted".
    // The decoy code is never persisted, so it attributes nothing.
    return successResponse(request, makeReferralCode())
  }

  try {
    const referralCode = makeReferralCode()
    await db
      .prepare(
        `INSERT INTO waitlist_signups (
        id, email, role, building, source, utm_source, utm_medium, utm_campaign, referrer, ip_hash, referral_code, referred_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        data.email,
        data.role || null,
        data.building || null,
        data.source || null,
        data.utmSource || null,
        data.utmMedium || null,
        data.utmCampaign || null,
        data.referrer || null,
        ipHash,
        referralCode,
        referredBy || null
      )
      .run()

    if (referredBy) {
      await db
        .prepare(
          `UPDATE waitlist_signups SET referral_count = referral_count + 1 WHERE referral_code = ?`
        )
        .bind(referredBy)
        .run()
    }

    return successResponse(request, referralCode)
  } catch (error: unknown) {
    if ((error as Error).message?.includes("UNIQUE constraint failed")) {
      // Duplicate email: identical success response, no distinguishing status/body — non-leaking
      // per spec. Return the EXISTING row's referral code (backfilling one for pre-referral rows)
      // so the payload shape matches a fresh signup exactly.
      try {
        const existing = await db
          .prepare(`SELECT referral_code FROM waitlist_signups WHERE email = ?`)
          .bind(data.email)
          .first<{ referral_code: string | null }>()
        if (existing?.referral_code) return successResponse(request, existing.referral_code)
        const backfill = makeReferralCode()
        await db
          .prepare(
            `UPDATE waitlist_signups SET referral_code = ? WHERE email = ? AND referral_code IS NULL`
          )
          .bind(backfill, data.email)
          .run()
        return successResponse(request, backfill)
      } catch {
        // Even if the lookup fails, keep the response shape identical.
        return successResponse(request, makeReferralCode())
      }
    }

    console.error(
      JSON.stringify({
        event: "waitlist_signup_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    )

    if (acceptsHtml(request)) {
      return htmlResponse(500, "<p>Something went wrong. Please try again.</p>")
    }
    return new Response(JSON.stringify({ error: "server", message: "Something went wrong." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
