import type { APIRoute } from "astro"
import { env } from "cloudflare:workers"

export const prerender = false

export const GET: APIRoute = async ({ url }) => {
  const code = url.searchParams.get("code")?.toUpperCase() ?? ""
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }
  const db = env.DB as Env["DB"]
  const signup = await db
    .prepare(`SELECT created_at, referral_count FROM waitlist_signups WHERE referral_code = ?`)
    .bind(code)
    .first<{ created_at: string; referral_count: number }>()
  if (!signup)
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
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
