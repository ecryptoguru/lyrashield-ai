import type { Target } from "@lyrashield/db"
import type { SetupAuthorityEvidence } from "../../../../lib/setup-health-authority"
import { clientIpFromRequest, peekFreeUrlScanRateLimit } from "../../../../lib/rate-limit"
import { findCurrentDomainProof, resolveSponsorScanPlan } from "../../../../lib/scan-admission"
import { eligibilityResponse, type AdvisoryFields } from "./preflight-helpers"

/** Mirror the read-only URL gates; the scan submission rechecks them. */
export async function evaluateRemotePreflight(input: {
  request: Request
  workspaceId: string
  actorUserId: string
  target: Target
  engineBacked: boolean
  advisory: AdvisoryFields
  evidence: SetupAuthorityEvidence
}): Promise<Response | null> {
  const { target, workspaceId, advisory, evidence } = input
  if (target.type !== "WEB_APP" && target.type !== "API") {
    evidence.network = null
    return null
  }
  const sponsorPlan = await resolveSponsorScanPlan(workspaceId, input.actorUserId)
  const network: Record<string, unknown> = { sponsorPlan, engineBacked: input.engineBacked }
  evidence.network = network
  if (sponsorPlan === "FREE" && !input.engineBacked) {
    const limit = await peekFreeUrlScanRateLimit(clientIpFromRequest(input.request))
    network.freeUrlLimited = limit.limited
    if (limit.limited) {
      const message =
        "Free-plan remote URL reviews are temporarily limited for your network. Verify the domain or upgrade for unrestricted reviews."
      return eligibilityResponse({
        allowed: false,
        code: "FREE_URL_SCAN_RATE_LIMITED",
        message,
        plan: "FREE",
        isTrial: false,
        remainingMinutes: 0,
        blockers: [{ code: "FREE_URL_SCAN_RATE_LIMITED", message }],
        ...advisory,
      })
    }
  }
  if (input.engineBacked) {
    const { domain, verified } = await findCurrentDomainProof(workspaceId, target.url)
    network.domain = domain
    network.verified = verified
    if (!verified) {
      const message = "Verify control of this domain once to enable engine-backed reviews."
      return eligibilityResponse({
        allowed: false,
        code: "DOMAIN_VERIFICATION_REQUIRED",
        message,
        plan: sponsorPlan,
        isTrial: false,
        remainingMinutes: 0,
        blockers: [{ code: "DOMAIN_VERIFICATION_REQUIRED", message }],
        remediation: {
          txtName: domain ? `_lyrashield.${domain}` : null,
          verifyPath: `/dashboard/targets/${target.id}`,
        },
        ...advisory,
      })
    }
  }
  return null
}
