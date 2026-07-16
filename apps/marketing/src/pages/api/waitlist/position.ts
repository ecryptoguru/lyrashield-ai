import type { APIRoute } from "astro"
import { getSecret } from "astro:env/server"
import { env } from "cloudflare:workers"
import { createHash } from "node:crypto"
import { checkD1RateLimit, getClientIp } from "../../../lib/waitlist-rate-limit"

export const prerender = false

export const GET: APIRoute = async ({ url, request }) => {
  const salt = getSecret("WAITLIST_IP_SALT")
  if (!salt) {
    return new Response(JSON.stringify({ error: "server" }), {
      status: 500,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    })
  }

  const db = env.DB as Env["DB"]
  const ipHash = `position:${createHash("sha256")
    .update(`${getClientIp(request)}:${salt}`)
    .digest("hex")}`
  const rateLimit = env.WAITLIST_RL as Env["WAITLIST_RL"] | undefined
  let allowed = true
  if (rateLimit) {
    try {
      allowed = (await rateLimit.limit({ key: ipHash })).success
    } catch {
      allowed = await checkD1RateLimit(db, ipHash)
    }
  } else {
    allowed = await checkD1RateLimit(db, ipHash)
  }
  if (!allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    })
  }

  const code = url.searchParams.get("code")?.toUpperCase() ?? ""
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    })
  }
  const signup = await db
    .prepare(`SELECT created_at, referral_count FROM waitlist_signups WHERE referral_code = ?`)
    .bind(code)
    .first<{ created_at: string; referral_count: number }>()
  if (!signup)
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    })
  const ahead = await db
    .prepare(`SELECT COUNT(*) AS count FROM waitlist_signups WHERE created_at < ?`)
    .bind(signup.created_at)
    .first<{ count: number }>()
  // Pre-launch ladder only: replace with a transactionally ranked queue when invitations ship.
  return new Response(
    JSON.stringify({
      position: Math.max(1, (ahead?.count ?? 0) + 1 - signup.referral_count),
      referrals: signup.referral_count,
    }),
    { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }
  )
}
