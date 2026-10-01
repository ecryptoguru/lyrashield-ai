import { hasPermission, PERMISSIONS } from "@lyrashield/auth/permissions"
import { evaluateScanEntitlement } from "@lyrashield/billing"
import {
  CANONICAL_OPERATIONS,
  LiveAiSafetyError,
  prisma,
  resolveAuthenticatedAssessmentAuthorization,
  runWithAccountContext,
  updateScanStatus,
  type ScanStatus,
} from "@lyrashield/db"
import { resolveScanProfile, type ScanExecutionPlan } from "@lyrashield/types"
import type { ScanJobData, ScanJobResult } from "../../types"
import { refreshGateVerdictAfterTerminalScan } from "./lifecycle-utils"
import type { StoredScanAuthority } from "./authority"

export async function verifyScanAdmission(params: {
  scanId: string
  workspaceId: string
  targetId: string | null
  mode: ScanJobData["mode"]
  engineBacked: boolean
  deterministicRetest: boolean
  scanRecord: StoredScanAuthority
  /** Validated stored execution plan (null on legacy pre-plan rows). */
  executionPlan?: ScanExecutionPlan | null
  /** Trusted stored target type for plan/target consistency. */
  targetType?: string
  /**
   * Plan-required admission switch (LYRASHIELD_SCAN_PLAN_REQUIRED). Deployable
   * independently of the additive migration: while OFF, legacy null-plan rows
   * drain on their original path; once ON, every job needs a stored plan.
   */
  planRequired?: boolean
  /** Current policy: a destructive-allowed policy can never run the beta. */
  destructiveTestsAllowed?: boolean
  /**
   * Execution-time re-evaluation of the authenticated-beta gate
   * (LYRASHIELD_AUTH_ASSESSMENT_ENABLED + LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST,
   * resolved by the caller against this scan's workspace/target). The API
   * applied the same gate at creation; disabling the flag or tightening the
   * allowlist between queueing and execution still denies the run.
   */
  authAssessmentPermitted?: boolean
}): Promise<{ ok: true } | { ok: false; result: ScanJobResult }> {
  const {
    scanId,
    workspaceId,
    targetId,
    mode,
    engineBacked,
    deterministicRetest,
    scanRecord,
    executionPlan = null,
    targetType,
    planRequired = false,
    destructiveTestsAllowed = false,
    authAssessmentPermitted = false,
  } = params

  // All producers converge here, including schedules and retests. Recheck
  // revocation and billing before provider work; never switch a queued
  // scan to a different payer when workspace sponsorship changes.
  const creator = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: scanRecord.createdById, status: "active" },
    select: { role: true },
  })
  const executionPermission =
    scanRecord.triggerType === "schedule"
      ? PERMISSIONS.schedule.create
      : scanRecord.triggerType === "retest"
        ? PERMISSIONS.retest.create
        : PERMISSIONS.scan.create
  let admissionError: { errorCategory: string; errorMessage: string } | null = null
  if (!creator || !hasPermission(creator.role, executionPermission)) {
    admissionError = {
      errorCategory: "SCAN_AUTHORIZATION_REVOKED",
      errorMessage: "The scan creator no longer has permission to run this review.",
    }
  } else if (planRequired && !executionPlan) {
    // Post-drain admission: every scan must carry its stored plan. Deny rather
    // than fabricating provenance for a legacy row.
    admissionError = {
      errorCategory: "SCAN_PLAN_REQUIRED",
      errorMessage: "Scan has no recorded execution plan. Start a new review.",
    }
  } else if (executionPlan) {
    // Current admission policy may only NARROW what the recorded plan asked
    // for — denial is the mechanism, never a silently widened or substituted
    // plan.
    let currentProfile: ReturnType<typeof resolveScanProfile> | null = null
    try {
      currentProfile = targetType ? resolveScanProfile({ targetType, mode }) : null
    } catch {
      currentProfile = null
    }
    if (targetType && executionPlan.targetType !== targetType) {
      admissionError = {
        errorCategory: "SCAN_PLAN_MISMATCH",
        errorMessage: "Stored execution plan does not match the scan target type.",
      }
    } else if (!currentProfile || executionPlan.profileId !== currentProfile.id) {
      admissionError = {
        errorCategory: "SCAN_PLAN_MISMATCH",
        errorMessage: "Stored execution plan does not match the scan profile.",
      }
    } else if (
      executionPlan.capabilities.includes("engine") !== (engineBacked && !deterministicRetest)
    ) {
      admissionError = {
        errorCategory: "SCAN_PLAN_MISMATCH",
        errorMessage: "Stored execution plan capabilities no longer match this scan.",
      }
    } else if (
      executionPlan.limits.maxBudgetUsd > currentProfile.maxBudgetUsd ||
      executionPlan.limits.maxDurationMs > currentProfile.maxDurationMinutes * 60_000
    ) {
      admissionError = {
        errorCategory: "SCAN_PLAN_LIMITS_EXCEEDED",
        errorMessage:
          "Stored execution plan exceeds the limits currently allowed for this profile.",
      }
    } else if (executionPlan.workflow === "AUTHENTICATED_ASSESSMENT") {
      if (!authAssessmentPermitted) {
        admissionError = {
          errorCategory: "SCAN_WORKFLOW_UNAVAILABLE",
          errorMessage:
            "The authenticated assessment beta is not enabled for this workspace and target.",
        }
      } else if (destructiveTestsAllowed) {
        admissionError = {
          errorCategory: "SCAN_PLAN_DENIED",
          errorMessage:
            "The workspace policy allows destructive tests, so the authenticated assessment cannot run.",
        }
      } else {
        // Execution-time re-verification of the recorded scoped authorization:
        // a revoked/expired/mismatched record between creation and execution
        // is a bounded stop, never a fallback to an unauthenticated run.
        try {
          await resolveAuthenticatedAssessmentAuthorization({
            workspaceId,
            targetId: targetId ?? "",
            authorizationRef: executionPlan.authorizationRef ?? "",
          })
        } catch (error) {
          admissionError = {
            errorCategory: "SCAN_AUTHORIZATION_REVOKED",
            errorMessage:
              error instanceof LiveAiSafetyError
                ? `The recorded assessment authorization is no longer valid (${error.code}).`
                : "The recorded assessment authorization could not be verified.",
          }
        }
      }
    }
  }

  // W0.4 — synchronous/async authorization boundary: a scan created through a
  // delegated OAuth connection carries that grant's identity on the durable
  // scan row. Re-verify the grant here so a connection revoked, expired,
  // paused, re-scoped (authorizationVersion bumped on any grant mutation), or
  // narrowed past this target between queueing and execution fails closed
  // instead of inheriting the stale request-time allow. The recorded version
  // must match exactly: any grant edit denies, even a widening — the queued
  // work was authorized under the old grant, not the new one.
  if (!admissionError && scanRecord.delegatedConnectionId) {
    const connection = await prisma.agentConnection.findFirst({
      where: { id: scanRecord.delegatedConnectionId, workspaceId },
      select: {
        userId: true,
        status: true,
        authorizationVersion: true,
        expiresAt: true,
        allowedOperations: true,
        allowedTargetIds: true,
        allTargets: true,
      },
    })
    const requiredOperation =
      scanRecord.triggerType === "retest"
        ? CANONICAL_OPERATIONS.RETEST_CREATE
        : CANONICAL_OPERATIONS.SCAN_CREATE
    const scopeCoversTarget =
      connection?.allTargets === true ||
      (targetId != null && (connection?.allowedTargetIds ?? []).includes(targetId))
    if (
      !connection ||
      connection.status !== "ACTIVE" ||
      connection.userId !== scanRecord.createdById ||
      connection.authorizationVersion !== scanRecord.delegatedAuthorizationVersion ||
      (connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) ||
      !connection.allowedOperations.includes(requiredOperation) ||
      !scopeCoversTarget
    ) {
      admissionError = {
        errorCategory: "SCAN_AUTHORIZATION_REVOKED",
        errorMessage: "The delegated grant that authorized this scan is no longer valid.",
      }
    }
  }

  if (!admissionError && engineBacked && !deterministicRetest) {
    const entitlement = await runWithAccountContext(scanRecord.createdById, () =>
      evaluateScanEntitlement({ workspaceId, mode, sponsorAccountId: scanRecord.createdById })
    )
    if (!entitlement.allowed) {
      admissionError = {
        errorCategory: entitlement.code ?? "SCAN_ENTITLEMENT_UNAVAILABLE",
        errorMessage: entitlement.message ?? "The billing sponsor cannot run this review.",
      }
    } else if (entitlement.accountId !== (scanRecord.sponsorAccountId ?? scanRecord.createdById)) {
      admissionError = {
        errorCategory: "SCAN_SPONSOR_CHANGED",
        errorMessage:
          "Workspace billing sponsorship changed. Start a new review with the current sponsor.",
      }
    }
  }
  if (admissionError) {
    await updateScanStatus(scanId, "FAILED" as ScanStatus, admissionError)
    await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
    return { ok: false, result: { status: "failed", ...admissionError } }
  }
  return { ok: true }
}
