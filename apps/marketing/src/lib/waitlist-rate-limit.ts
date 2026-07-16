const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000

export function getClientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")
  if (cf) return cf
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    // Use the last address in the chain (closest proxy) instead of the spoofable first address.
    return forwarded.split(",").at(-1)?.trim() || "unknown"
  }
  return "unknown"
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
