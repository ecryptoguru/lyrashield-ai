/**
 * Shared scan-admission primitives.
 *
 * POST /api/scans and GET /api/scans/eligibility must judge the SAME review:
 * the URL profile resolution, the sponsor's effective plan, the free-URL and
 * domain-proof gates, and the canonical profile/mode mapping live here once so
 * the advisory preflight cannot drift from the mutation gate. Everything in
 * this module is pure or read-only — no trial claim, allowance reservation,
 * ref resolution, queue submission or audit write belongs here; side effects
 * stay on POST.
 */
import { prisma } from "@lyrashield/db"
import type { ScanMode } from "@lyrashield/db"
import { resolveScanProfile, resolveTargetScanMode } from "@lyrashield/types"
import { normalizeDomainForProof } from "@lyrashield/security"
import { resolveAccountBilling, resolveWorkspaceScanSponsor } from "@lyrashield/billing"
import { env, evaluateAuthAssessmentAdmission } from "@lyrashield/config"
import { getManualScanOptions, type ManualScanOption } from "./scan-presets"

const URL_TARGET_TYPES = new Set(["WEB_APP", "API"])

export type UrlReviewMode =
  { ok: true; engineBacked: boolean } | { ok: false; code: string; reason: string }

/**
 * Whether a URL/API review tier is engine-backed — the fact that decides the
 * free-URL and domain-verification consent gates. Non-URL targets are never
 * engine-backed. Pure: mirrors the shared resolveTargetScanMode policy.
 */
export function resolveUrlReviewMode(input: {
  targetType: string
  mode: string
  hasApiSpec: boolean
}): UrlReviewMode {
  if (!URL_TARGET_TYPES.has(input.targetType)) {
    return { ok: true, engineBacked: false }
  }
  const resolved = resolveTargetScanMode({
    targetType: input.targetType,
    mode: input.mode,
    hasApiSpec: input.hasApiSpec,
  })
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, reason: resolved.reason }
  }
  return {
    ok: true,
    engineBacked:
      resolved.profile !== null &&
      resolveScanProfile({ targetType: input.targetType, mode: input.mode }).usesAi,
  }
}

export type CanonicalReviewMode =
  { ok: true; canonicalMode: ScanMode; profileId?: string } | { ok: false; code: string }

/**
 * The canonical review mode and profile id a run would actually use, or the
 * unsupported-mode/target-type code POST would fail with. Pure.
 */
export function resolveCanonicalReviewMode(input: {
  targetType: string | null | undefined
  mode: ScanMode
}): CanonicalReviewMode {
  if (input.targetType === "REPO" || input.targetType === "WEB_APP" || input.targetType === "API") {
    try {
      const profile = resolveScanProfile({
        targetType: input.targetType,
        mode: input.mode,
      })
      return { ok: true, canonicalMode: profile.canonicalMode, profileId: profile.id }
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : "TARGET_TYPE_UNSUPPORTED",
      }
    }
  }
  if (input.targetType) {
    return { ok: false, code: "TARGET_TYPE_UNSUPPORTED" }
  }
  return { ok: true, canonicalMode: input.mode }
}

/**
 * The sponsor's effective plan — account-level billing truth shared by the
 * preflight and the mutation gate. `workspace.plan` is a display mirror under
 * account-owned billing and must never decide this. Read-only.
 */
export async function resolveSponsorScanPlan(workspaceId: string, userId: string): Promise<string> {
  const sponsor = await resolveWorkspaceScanSponsor(workspaceId, userId)
  const sponsorBilling = sponsor?.agencyActive ? null : await resolveAccountBilling(userId)
  return sponsor?.agencyActive ? "LAUNCH_ASSURANCE" : (sponsorBilling?.effectivePlan ?? "FREE")
}

/**
 * Whether a current, unexpired domain-verification proof exists for the
 * target's normalized domain. Returns the normalized domain alongside so the
 * caller can build remediation hints without re-deriving it. Read-only.
 */
export async function findCurrentDomainProof(
  workspaceId: string,
  url: string | null | undefined
): Promise<{ domain: string | null; verified: boolean }> {
  const domain = url ? normalizeDomainForProof(url) : null
  if (!domain) return { domain, verified: false }
  const proof = await prisma.targetDomainVerification.findFirst({
    where: {
      workspaceId,
      domain,
      status: "VERIFIED",
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  })
  return { domain, verified: Boolean(proof) }
}

/**
 * The policy row a scan admission would consult: the explicit policyId when
 * given, else the workspace's default policy. Read-only.
 */
export async function findScanPolicy(workspaceId: string, policyId?: string) {
  return prisma.policy.findFirst({
    where: policyId
      ? { id: policyId, workspaceId, deletedAt: null }
      : { workspaceId, name: "Default Policy", deletedAt: null },
    orderBy: policyId ? undefined : { createdAt: "asc" },
    select: { id: true, destructiveTestsAllowed: true },
  })
}

/**
 * Deployment-level authenticated-assessment admission — the same flag +
 * per-workspace/target allowlist gate POST evaluates. Pure (env read).
 */
export function authAssessmentAdmission(workspaceId: string, targetId: string) {
  return evaluateAuthAssessmentAdmission({
    enabled: env.LYRASHIELD_AUTH_ASSESSMENT_ENABLED === "1",
    allowlist: env.LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST,
    workspaceId,
    targetId,
  })
}

/**
 * The bounded list of review options a target offers — the same pure option
 * policy the dashboard composer and the WebMCP tools derive. Never an
 * enumeration of per-mode endpoint calls. Pure.
 */
export function listAdmissibleReviewOptions(target: {
  type: string
  hasApiSpec?: boolean | null
}): ManualScanOption[] {
  return getManualScanOptions(target)
}

/**
 * The manual-scan option that corresponds to the requested review: exact
 * profile id for URL tiers, then the recorded workflow (REVIEW_CHANGES pins
 * the diff preset at the same depth), then the first available option at the
 * canonical mode. Returns undefined when nothing matches — the caller leaves
 * expected coverage absent rather than inventing it. Pure.
 */
export function matchReviewOption(
  options: ManualScanOption[],
  input: { profileId?: string; canonicalMode?: string; workflow?: string }
): ManualScanOption | undefined {
  return (
    (input.profileId ? options.find((option) => option.id === input.profileId) : undefined) ??
    options.find(
      (option) =>
        input.workflow !== undefined &&
        option.workflow === input.workflow &&
        option.mode === input.canonicalMode
    ) ??
    options.find((option) => option.mode === input.canonicalMode && option.available)
  )
}
