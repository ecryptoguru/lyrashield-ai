const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000

export function getClientIp(request: Request): string {
  // Cloudflare writes this header at the Worker boundary. Do not fall back to
  // caller-controlled forwarding headers on previews or local deployments.
  const cf = request.headers.get("cf-connecting-ip")
  return cf?.trim() || "unknown"
}

/** Atomic D1 fallback used when the Workers rate-limiting binding is unavailable. */
export async function checkD1RateLimit(db: Env["DB"], ipHash: string): Promise<boolean> {
  try {
    const now = Date.now()
    const windowStart = now - RATE_LIMIT_WINDOW_MS

    await db.prepare(`DELETE FROM waitlist_rate_limit WHERE ts < ?`).bind(windowStart).run()

    const result = await db
      .prepare(
        `INSERT INTO waitlist_rate_limit (ip_hash, ts)
         SELECT ?, ?
         WHERE (SELECT COUNT(*) FROM waitlist_rate_limit WHERE ip_hash = ? AND ts >= ?) < ?`
      )
      .bind(ipHash, now, ipHash, windowStart, RATE_LIMIT_MAX)
      .run()
    return (result.meta.changes ?? 0) > 0
  } catch {
    // Keep the public funnel available when the fallback limiter itself is unavailable.
    return true
  }
}
