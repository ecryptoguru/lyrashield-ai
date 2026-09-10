/**
 * Cloudflare Turnstile verification (v16 2.3: extracted from the lite-scan
 * route so the lite-scorecard mint uses the identical bot check).
 *
 * Semantics preserved exactly from the original implementation:
 *  - a definitive `success: false` is NOT retried (real bot-check failure);
 *  - transient network failures (timeout, connection reset) retry up to
 *    TURNSTILE_MAX_RETRIES times with linear backoff;
 *  - all-transient fails closed (treated as a bot-check failure);
 *  - a missing secret or token fails closed.
 */

type TurnstileOutcome = "success" | "failed" | "transient-error"

async function verifyTurnstileOnce(token: string, secret: string): Promise<TurnstileOutcome> {
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

export async function verifyTurnstile(token: string | undefined): Promise<boolean> {
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
