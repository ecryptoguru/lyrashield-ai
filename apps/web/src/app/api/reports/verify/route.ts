import { z } from "zod"
import { confirmSharedLaunchReportIdentity, verifyLaunchReportSignature } from "@lyrashield/db"
import { resolveLaunchReportSigningPublicKey } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { checkApiRateLimit, clientIpFromRequest } from "../../../../lib/rate-limit"

export const dynamic = "force-dynamic"

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

const VerifySchema = z
  .object({
    /** The SHA-256 checksum printed on the report. */
    reportChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "reportChecksum must be a sha256 hex digest"),
    /** The base64 ed25519 signature printed on the report. */
    signature: z.string().min(1).max(512),
    releaseIdentity: z
      .discriminatedUnion("kind", [
        z
          .object({
            reportId: z.string().cuid(),
            shareToken: z
              .string()
              .regex(/^[a-f0-9]{64}$/i, "shareToken must be a 64-character token"),
            kind: z.literal("COMMIT"),
            value: z.string().regex(/^[a-f0-9]{40}$/i, "commit must be a full 40-character SHA"),
          })
          .strict(),
        z
          .object({
            reportId: z.string().cuid(),
            shareToken: z
              .string()
              .regex(/^[a-f0-9]{64}$/i, "shareToken must be a 64-character token"),
            kind: z.literal("ARTIFACT_DIGEST"),
            value: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/i, "artifact digest must use sha256:<64 hex>"),
          })
          .strict(),
      ])
      .optional(),
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
 * exception that could be read as "couldn't check, so probably fine". Optional
 * release confirmation requires the report's live share capability and returns
 * only MATCH, MISMATCH or UNAVAILABLE — never the stored identity.
 */
export async function POST(request: Request) {
  try {
    const clientIp = clientIpFromRequest(request)
    const rateLimit = await checkApiRateLimit(clientIp)
    if (rateLimit.limited) {
      return noStore(
        apiError("RATE_LIMITED", "Too many verification requests. Please try again later.", 429)
      )
    }

    const body: unknown = await request.json().catch(() => null)
    const parsed = VerifySchema.safeParse(body)
    if (!parsed.success) {
      return noStore(
        apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
      )
    }
    const { reportChecksum, signature, releaseIdentity } = parsed.data

    // Server's OWN public key (env in dev, Azure Key Vault in production) —
    // never a client-supplied key, which would allow forgery.
    const publicKey = await resolveLaunchReportSigningPublicKey()
    if (!publicKey) {
      logger.warn("Launch report verification requested but no public key is configured")
      return noStore(
        apiError("NOT_CONFIGURED", "Report signature verification is not available.", 503)
      )
    }

    const verified = verifyLaunchReportSignature(reportChecksum, signature, publicKey)
    const identityStatus =
      verified && releaseIdentity
        ? await confirmSharedLaunchReportIdentity({
            reportId: releaseIdentity.reportId,
            token: releaseIdentity.shareToken,
            reportChecksum,
            identity: { kind: releaseIdentity.kind, value: releaseIdentity.value },
          })
        : releaseIdentity
          ? "UNAVAILABLE"
          : undefined
    const response = apiSuccess({
      verified,
      signingKeyId: verified ? "lyrashield-launch-report-ed25519-1" : null,
      ...(identityStatus ? { releaseIdentity: { status: identityStatus } } : {}),
    })
    return noStore(response)
  } catch (error) {
    logger.error("Launch report verification failed", { error: String(error) })
    return noStore(apiError("INTERNAL_ERROR", "Failed to verify the report", 500))
  }
}
