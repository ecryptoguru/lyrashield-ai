-- Fallback sliding-window limiter for /api/waitlist, used only when the
-- Cloudflare Workers rate-limiting binding (WAITLIST_RL) is unavailable.
-- See apps/marketing/src/pages/api/waitlist.ts (checkD1RateLimit).
CREATE TABLE IF NOT EXISTS waitlist_rate_limit (
  ip_hash TEXT NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_rate_limit_ip_ts ON waitlist_rate_limit(ip_hash, ts);
