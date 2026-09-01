import { z } from "zod"
import { verifyLaunchReportSignature } from "@lyrashield/db"
import { resolveLaunchReportSigningPublicKey } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { checkApiRateLimit, clientIpFromRequest } from "../../../../lib/rate-limit"

export const dynamic = "force-dynamic"

const VerifySchema = z
  .object({
    /** The SHA-256 checksum printed on the report. */
    reportChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "reportChecksum must be a sha256 hex digest"),
    /** The base64 ed25519 signature printed on the report. */
    signature: z.string().min(1).max(512),
  })
  .strict()

/**
 * POST /api/reports/verify — verify a Launch Readiness Report's signature.
 *
 * A third party (enterprise buyer, investor, auditor) pastes the checksum +
 * signature from a presented report; the server confirms whether that exact
 * document was issued by LyraShield and unedited since issue.
 *
 * Security: the server uses its OWN configured public key
 * (LAUNCH_REPORT_SIGNING_PUBLIC_KEY, or derived from the private key) — it never
 * accepts a public key from the client. Rate-limited per IP. Fails closed: any
 * malformed input or signature mismatch returns { verified: false }, never an
 * exception that could be read as "couldn't check, so probably fine".
 */
export async function POST(request: Request) {
  try {
    const clientIp = clientIpFromRequest(request)
    const rateLimit = await checkApiRateLimit(clientIp)
    if (rateLimit.limited) {
      return apiError(
        "RATE_LIMITED",
        "Too many verification requests. Please try again later.",
        429
      )
    }

    const body: unknown = await request.json().catch(() => null)
    const parsed = VerifySchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { reportChecksum, signature } = parsed.data

    // Server's OWN public key (env in dev, Azure Key Vault in production) —
    // never a client-supplied key, which would allow forgery.
    const publicKey = await resolveLaunchReportSigningPublicKey()
    if (!publicKey) {
      logger.warn("Launch report verification requested but no public key is configured")
      return apiError("NOT_CONFIGURED", "Report signature verification is not available.", 503)
    }

    const verified = verifyLaunchReportSignature(reportChecksum, signature, publicKey)
    return apiSuccess({
      verified,
      signingKeyId: verified ? "lyrashield-launch-report-ed25519-1" : null,
    })
  } catch (error) {
    logger.error("Launch report verification failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to verify the report", 500)
  }
}
