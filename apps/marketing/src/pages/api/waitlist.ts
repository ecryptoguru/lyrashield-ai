import type { APIRoute } from "astro"
import { z } from "zod"
import { getSecret } from "astro:env/server"
import { env } from "cloudflare:workers"
import { createHash } from "node:crypto"

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.string().trim().max(50).optional().transform((v) => v || undefined),
  building: z.string().trim().max(200).optional().transform((v) => v || undefined),
  source: z.string().trim().max(50).optional().transform((v) => v || undefined),
  utmSource: z.string().trim().max(100).optional().transform((v) => v || undefined),
  utmMedium: z.string().trim().max(100).optional().transform((v) => v || undefined),
  utmCampaign: z.string().trim().max(100).optional().transform((v) => v || undefined),
  referrer: z.string().trim().max(500).optional().transform((v) => v || undefined),
  website: z.string().trim().max(100).optional().transform((v) => v || undefined),
})

export const prerender = false

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || ""

  if (contentType.includes("application/json")) {
    const raw = await request.text()
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData()
    const result: Record<string, unknown> = {}
    formData.forEach((value, key) => {
      result[key] = value.toString()
    })
    return result
  }

  // application/x-www-form-urlencoded or missing content-type
  const raw = await request.text()
  const params = new URLSearchParams(raw)
  const result: Record<string, unknown> = {}
  for (const [key, value] of params) {
    result[key] = value
  }
  return result
}

function getClientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")
  if (cf) return cf
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    // Use the last address in the chain (closest proxy) instead of the spoofable client-proclaimed first.
    return forwarded.split(",").at(-1)?.trim() || "unknown"
  }
  return "unknown"
}

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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LyraSec AI — Waitlist</title></head><body style="background:#0a0c0e;color:#e6e9ec;font-family:system-ui,sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;line-height:1.6">${body}<p style="margin-top:2rem"><a href="/" style="color:#2dd4a7">Back to home</a></p></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

export const POST: APIRoute = async ({ request, site }) => {
  const rawSiteOrigin = site?.origin ?? (import.meta.env.PUBLIC_SITE_URL as string | undefined) ?? "http://localhost:4321"
  const siteOrigin = rawSiteOrigin.endsWith("/") ? rawSiteOrigin.slice(0, -1) : rawSiteOrigin

  if (!isTrustedOrigin(request, siteOrigin)) {
    if (acceptsHtml(request)) {
      return htmlResponse(403, "<p>This request is not allowed.</p>")
    }
    return new Response(JSON.stringify({ error: "forbidden", message: "This request is not allowed." }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  }

  const salt = getSecret("WAITLIST_IP_SALT")
  if (!salt) {
    if (acceptsHtml(request)) {
      return htmlResponse(500, "<p>Server configuration error.</p>")
    }
    return new Response(JSON.stringify({ error: "server", message: "Server configuration error." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const ip = getClientIp(request)
  const ipHash = createHash("sha256").update(`${ip}:${salt}`).digest("hex")

  const body = await parseBody(request)
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

  const { website, ...data } = parsed.data
  if (website) {
    if (acceptsHtml(request)) {
      return htmlResponse(400, "<p>Something went wrong.</p>")
    }
    return new Response(JSON.stringify({ error: "honeypot", message: "Rejected." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const db = env.DB as Env["DB"]
  const rateLimit = env.WAITLIST_RL as Env["WAITLIST_RL"] | undefined

  if (rateLimit) {
    try {
      const result = await rateLimit.limit({ key: ipHash })
      if (!result.success) {
        if (acceptsHtml(request)) {
          return htmlResponse(429, "<p>Too many attempts — try again in a minute.</p>")
        }
        return new Response(JSON.stringify({ error: "rate_limited", message: "Too many attempts." }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })
      }
    } catch {
      // Continue on rate-limit binding outage; do not block the user.
    }
  }

  try {
    await db.prepare(
      `INSERT INTO waitlist_signups (
        id, email, role, building, source, utm_source, utm_medium, utm_campaign, referrer, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      data.email,
      data.role || null,
      data.building || null,
      data.source || null,
      data.utmSource || null,
      data.utmMedium || null,
      data.utmCampaign || null,
      data.referrer || null,
      ipHash
    ).run()

    if (acceptsHtml(request)) {
      return htmlResponse(201, "<p>You're on the list. One email when your invite is ready.</p>")
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error: unknown) {
    if ((error as Error).message?.includes("UNIQUE constraint failed")) {
      if (acceptsHtml(request)) {
        return htmlResponse(200, "<p>You're on the list. One email when your invite is ready.</p>")
      }
      return new Response(JSON.stringify({ success: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (acceptsHtml(request)) {
      return htmlResponse(500, "<p>Something went wrong. Please try again.</p>")
    }
    return new Response(JSON.stringify({ error: "server", message: "Something went wrong." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
