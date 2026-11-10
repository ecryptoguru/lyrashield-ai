import { LiveAiSafetyError, resolveAuthenticatedAssessmentAuthorization } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import {
  CreateScanInputSchema,
  resolvePlanEngineBudget,
  resolveScanProfile,
  ScanExecutionPlanInputError,
} from "@lyrashield/types"
import { NextResponse } from "next/server"
import type { z } from "zod"
import type { SetupAuthorityEvidence } from "../../../../lib/setup-health-authority"
import {
  authAssessmentAdmission,
  findScanPolicy,
  listAdmissibleReviewOptions,
  getTargetRelayAvailability,
  TARGET_RELAY_UNAVAILABLE_MESSAGE,
} from "../../../../lib/scan-admission"

export type EligibilityBlocker = { code: string; message: string }

/** Bounded projection of a manual-scan option for the advisory contract —
 * decision-relevant fields only: no minute estimates, model names or costs. */
type SupportedMode = {
  id: string
  label: string
  goal: string
  mode: string
  workflow: string
  available: boolean
  disabledReason: string | null
  usesAi: boolean | null
  requiresRevisionInputs: boolean
  authorizationHint: string | null
}

export type AdvisoryFields = {
  canonicalMode?: string
  canonicalProfileId?: string
  supportedModes?: SupportedMode[]
  expectedScannerFamilies?: string[]
}

/**
 * Eligibility payloads are workspace-sensitive (plan, remaining minutes), so
 * the response is always private and never stored by shared caches.
 */
export function eligibilityResponse(data: unknown, status = 200) {
  return NextResponse.json(
    { success: true, data },
    { status, headers: { "Cache-Control": "private, no-store" } }
  )
}

/**
 * Workflow-gate checks the preflight can answer cheaply and honestly — the
 * same gates POST applies, minus the parts that require submission work.
 * Failures are returned as blockers; evidence the endpoint cannot establish
 * (immutable ref resolution happens only at creation) is a limitation, never
 * a denial.
 */
async function evaluateWorkflowPreflight(input: {
  workspaceId: string
  targetId: string
  target: {
    type: string
    installationId?: unknown
    repoOwner?: string | null
    repoName?: string | null
    repoFullName?: string | null
  }
  workflow?: string
  authorizationRef?: string
  policy: Awaited<ReturnType<typeof findScanPolicy>> | undefined
  evidence: SetupAuthorityEvidence
}): Promise<{ blockers: EligibilityBlocker[]; limitations: string[] }> {
  const blockers: EligibilityBlocker[] = []
  const limitations: string[] = []

  if (input.workflow === "REVIEW_CHANGES") {
    if (input.target.type !== "REPO") {
      blockers.push({
        code: "SCAN_PLAN_INVALID",
        message: "Review Changes requires a repository target.",
      })
    } else {
      const installationId = input.target.installationId
        ? Number(input.target.installationId)
        : null
      const repoOwner = input.target.repoOwner ?? input.target.repoFullName?.split("/")[0]
      const repoName = input.target.repoName ?? input.target.repoFullName?.split("/")[1]
      if (!installationId || !repoOwner || !repoName) {
        blockers.push({
          code: "SCAN_SOURCE_UNAVAILABLE",
          message: "Review Changes requires a repository connected through the GitHub App.",
        })
      } else {
        // Resolving refs through the authorized GitHub integration is
        // submission work — report it as unavailable evidence, not a denial.
        limitations.push(
          "Comparison refs and merge base resolve to immutable revisions only when the scan is submitted."
        )
      }
    }
  }

  if (input.workflow === "AUTHENTICATED_ASSESSMENT") {
    const admission = authAssessmentAdmission(input.workspaceId, input.targetId)
    if (!admission.allowed) {
      blockers.push({
        code: "SCAN_WORKFLOW_UNAVAILABLE",
        message: "Authenticated assessment is not enabled for this workspace and target.",
      })
    } else if (input.target.type !== "WEB_APP" && input.target.type !== "API") {
      blockers.push({
        code: "SCAN_PLAN_INVALID",
        message: "Authenticated assessment requires a live web app or API target.",
      })
    } else {
      // Same order as POST: a destructive-allowed policy forbids the beta,
      // then the recorded scoped authorization must cover this exact target.
      const policy = input.policy
      if (policy?.destructiveTestsAllowed === true) {
        blockers.push({
          code: "SCAN_PLAN_DENIED",
          message:
            "The selected policy allows destructive tests, which the authenticated assessment forbids.",
        })
      } else if (input.authorizationRef) {
        try {
          const authorization = await resolveAuthenticatedAssessmentAuthorization({
            workspaceId: input.workspaceId,
            targetId: input.targetId,
            authorizationRef: input.authorizationRef,
          })
          input.evidence.authorization = {
            state: "AUTHORIZED",
            planId: authorization.planId,
            approvedHost: authorization.approvedHost,
            credentialId: authorization.credentialId,
            credentialKind: authorization.credentialKind,
            credentialScope: authorization.credentialScope,
            credentialExpiresAt: authorization.credentialExpiresAt,
            domainVerificationExpiresAt: authorization.domainVerificationExpiresAt,
          }
        } catch (error) {
          if (error instanceof LiveAiSafetyError) {
            input.evidence.authorization = { state: "DENIED", code: error.code }
            blockers.push({
              code: error.code,
              message: "The recorded assessment authorization does not cover this target.",
            })
          } else {
            throw error
          }
        }
      }
    }
  }

  return { blockers, limitations }
}

export async function evaluatePolicyAndWorkflow(
  input: z.output<typeof CreateScanInputSchema>,
  target: {
    type: string
    installationId?: unknown
    repoOwner?: string | null
    repoName?: string | null
    repoFullName?: string | null
  },
  workspaceId: string,
  targetId: string,
  evidence: SetupAuthorityEvidence
): Promise<{
  blockers: EligibilityBlocker[]
  limitations: string[]
}> {
  const blockers: EligibilityBlocker[] = []
  const policy = await findScanPolicy(workspaceId, input.policyId)
  evidence.policy = policy
    ? { ...policy, maxBudgetUsd: policy.maxBudgetUsd?.toNumber() ?? null }
    : null
  if (input.policyId && !policy) {
    blockers.push({ code: "POLICY_NOT_FOUND", message: "Policy not found in this workspace" })
    return { blockers, limitations: [] }
  }

  const workflow = await evaluateWorkflowPreflight({
    workspaceId,
    targetId,
    target,
    workflow: input.workflow,
    authorizationRef: input.authorizationRef,
    policy,
    evidence,
  })
  if (workflow.blockers.length) return workflow
  try {
    const profile = resolveScanProfile({ targetType: target.type, mode: input.mode })
    const amount = resolvePlanEngineBudget(
      profile.maxBudgetUsd,
      profile.usesAi,
      input.workflow ?? "REVIEW_TARGET",
      {
        policyMaxBudgetUsd: policy?.maxBudgetUsd?.toNumber(),
        platformMaxBudgetUsd: env.PLATFORM_MAX_SCAN_BUDGET_USD,
        engineBudgetCeilingUsd: input.engineBudgetCeilingUsd,
      }
    )
    evidence.budget = { amount, profileBudget: profile.maxBudgetUsd, engineBacked: profile.usesAi }
  } catch (error) {
    if (!(error instanceof ScanExecutionPlanInputError)) throw error
    evidence.budget = { state: "INVALID" }
    return { blockers: [{ code: "SCAN_PLAN_INVALID", message: error.message }], limitations: [] }
  }
  return workflow
}

export async function prepareReviewOptions(target: { type: string; apiSpecUrl?: unknown }) {
  const reviewOptions = listAdmissibleReviewOptions({
    type: target.type,
    hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
  })
  const targetRelayAvailable = await getTargetRelayAvailability(target.type)
  const supportedModes: SupportedMode[] = reviewOptions.map((option) => ({
    id: option.id,
    label: option.label,
    goal: option.goal,
    mode: option.mode,
    workflow: option.workflow,
    available: option.available && (!option.usesAi || targetRelayAvailable),
    disabledReason:
      option.disabledReason ??
      (option.usesAi && !targetRelayAvailable ? TARGET_RELAY_UNAVAILABLE_MESSAGE : null),
    usesAi: option.usesAi ?? null,
    requiresRevisionInputs: option.requiresRevisionInputs ?? false,
    authorizationHint: option.authorizationHint ?? null,
  }))
  const advisory: AdvisoryFields = { supportedModes }

  return { reviewOptions, advisory, targetRelayAvailable }
}
