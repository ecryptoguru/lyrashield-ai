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
import { createHash, randomUUID } from "node:crypto"
import { logger } from "@lyrashield/logger"

type TurnstileOutcome = "success" | "failed" | "transient-error"
type DiagnosticContext = {
  invocationId: string
  attempt: number
  providerMode: "documented-test" | "unclassified"
}
type VerificationMetadata = {
  success?: boolean
  "error-codes"?: unknown
  hostname?: unknown
  action?: unknown
  challenge_ts?: unknown
}

const ERROR_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "missing-input-response",
  "invalid-input-response",
  "bad-request",
  "timeout-or-duplicate",
  "internal-error",
])
const CACHE_STATES = new Set([
  "HIT",
  "MISS",
  "DYNAMIC",
  "EXPIRED",
  "BYPASS",
  "REVALIDATED",
  "UPDATING",
  "STALE",
])

function challengeAge(timestamp: unknown): "fresh" | "expired" | "future" | "missing-or-invalid" {
  if (typeof timestamp !== "string" || timestamp.length > 64) return "missing-or-invalid"
  const issuedAt = Date.parse(timestamp)
  if (!Number.isFinite(issuedAt)) return "missing-or-invalid"
  const age = Date.now() - issuedAt
  return age < 0 ? "future" : age > 300_000 ? "expired" : "fresh"
}

/** Only explicitly constructed, bounded metadata reaches the logger. */
function recordOutcome(
  context: DiagnosticContext,
  outcome: TurnstileOutcome,
  response?: Response,
  metadata?: VerificationMetadata
): void {
  try {
    const rawCodes = metadata?.["error-codes"]
    const errorCodes = Array.isArray(rawCodes)
      ? [
          ...new Set(
            rawCodes.slice(0, 8).map((code) => (ERROR_CODES.has(code) ? code : "unrecognized"))
          ),
        ]
      : []
    const ray = response?.headers?.get("cf-ray")
    const cacheState = response?.headers?.get("cf-cache-status")
    const status = response?.status
    const rayParts = ray?.split("-")
    const validRay =
      rayParts &&
      rayParts.length <= 2 &&
      /^[a-f\d]{16,32}$/i.test(rayParts[0] ?? "") &&
      (rayParts.length === 1 || /^[A-Z]{3}$/i.test(rayParts[1] ?? ""))
    logger.info("Turnstile verification outcome", {
      ...context,
      outcome,
      httpStatus: Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : null,
      errorCodes,
      hostnamePresent: typeof metadata?.hostname === "string" && metadata.hostname.length > 0,
      actionPresent: typeof metadata?.action === "string" && metadata.action.length > 0,
      challengeAge: challengeAge(metadata?.challenge_ts),
      upstreamRayFingerprint:
        ray && validRay ? createHash("sha256").update(ray).digest("hex") : null,
      upstreamCacheState: cacheState
        ? CACHE_STATES.has(cacheState)
          ? cacheState
          : "unrecognized"
        : null,
    })
  } catch {
    // Diagnostics must not change acceptance or cause a consumed proof to be retried.
  }
}

async function verifyTurnstileOnce(
  token: string,
  secret: string,
  context: DiagnosticContext
): Promise<TurnstileOutcome> {
  let verification: Response | undefined
  try {
    const body = new URLSearchParams({ secret, response: token })
    verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5_000),
    })
    const result = (await verification.json()) as VerificationMetadata
    const outcome = result.success === true ? "success" : "failed"
    recordOutcome(context, outcome, verification, result)
    return outcome
  } catch {
    // Network timeout / DNS / connection reset — transient, worth a retry.
    recordOutcome(context, "transient-error", verification)
    return "transient-error"
  }
}

export async function verifyTurnstile(token: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return false
  if (!token) return false

  const invocationId = randomUUID()
  // Recognize only Cloudflare's three documented dummy secret formats.
  // "unclassified" does not assert a correct production widget/credential pairing.
  const providerMode = /^[123]x0{31}AA$/.test(secret) ? "documented-test" : "unclassified"
  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const outcome = await verifyTurnstileOnce(token, secret, {
      invocationId,
      attempt: attempt + 1,
      providerMode,
    })
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
