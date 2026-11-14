import type { Job } from "bullmq"
import {
  withWorkspaceRLS,
  updateUnclaimedScanStatus,
  verifyStoredScanExecutionPlan,
  type ScanStatus,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { containsPromptInjection } from "@lyrashield/security"
import { normalizePlanDepth, type ScanExecutionPlan } from "@lyrashield/types"
import { ScanJobDataSchema, type ScanJobData, type ScanJobResult } from "../../types"

export interface StoredScanAuthority {
  id: string
  workspaceId: string
  targetId: string | null
  goal: string
  mode: ScanJobData["mode"]
  policyId: string | null
  determinismMode: string | null
  startedAt: Date | null
  createdById: string
  accountingVersion?: number | null
  sponsorAccountId: string | null
  triggerType: string | null
  /**
   * The delegated OAuth grant that authorized this scan, when created through
   * an MCP/agent connection credential. Persisted at the synchronous admission
   * boundary; verifyScanAdmission re-checks it at execution time so a revoked,
   * expired, re-scoped, or narrowed grant between queue and run fails closed.
   * NULL for cookie/API-key/schedule producers.
   */
  delegatedConnectionId: string | null
  delegatedAuthorizationVersion: number | null
  /**
   * Immutable server-owned execution plan snapshot + canonical-JSON sha256,
   * written once at scan creation. NULL on legacy rows — the bounded drain
   * path treats them as pre-plan scans; provenance is never fabricated.
   */
  executionPlan: unknown
  executionPlanHash: string | null
}

export type ScanAuthorityResult =
  | {
      ok: true
      data: ScanJobData
      scanRecord: StoredScanAuthority
      workspaceId: string
      /** Validated stored plan, or null for a legacy pre-plan scan row. */
      executionPlan: ScanExecutionPlan | null
    }
  | { ok: false; result: ScanJobResult }

async function recordAuthorityFailure(
  scanId: string,
  workspaceId: string,
  error: { errorCategory: string; errorMessage: string },
  label: string
) {
  try {
    await updateUnclaimedScanStatus(scanId, "FAILED" as ScanStatus, error, workspaceId)
  } catch (statusErr) {
    logger.warn(label, {
      scanId,
      errorType: statusErr instanceof Error ? statusErr.name : "UNKNOWN",
    })
  }
}

export async function verifyScanJobAuthority(
  job: Job<ScanJobData, ScanJobResult>,
  options: { recordFailure?: boolean } = {}
): Promise<ScanAuthorityResult> {
  // Prompt-injection checks happen before any schema trust: an attacker could
  // place arbitrary text in the queue payload and the goal field is later used
  // to build the engine instruction.
  if (typeof job.data?.goal === "string" && containsPromptInjection(job.data.goal)) {
    logger.warn("Scan job goal contains prompt-injection patterns", { jobId: job.id })
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: "PROMPT_INJECTION",
        errorMessage: "Scan goal contains disallowed instruction patterns",
      },
    }
  }

  // Validate and coerce the untrusted BullMQ payload before trusting any field.
  const parseResult = ScanJobDataSchema.safeParse(job.data)
  if (!parseResult.success) {
    logger.warn("Scan job payload failed schema validation", {
      jobId: job.id,
      errors: parseResult.error.issues.map((i) => i.message),
    })
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: "INVALID_JOB",
        errorMessage: parseResult.error.message,
      },
    }
  }

  const {
    scanId,
    workspaceId: claimedWorkspaceId,
    targetId,
    goal,
    mode,
    policyId,
  } = parseResult.data

  // enqueueScan() uses scanId as the BullMQ job ID. Reject any alternate ID
  // before loading or mutating the canonical scan so duplicate/forged jobs
  // cannot execute provider work under another queue identity.
  if (
    job.id !== scanId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(scanId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(claimedWorkspaceId)
  ) {
    logger.warn("Scan job ID does not match scan ID", { jobId: job.id, scanId })
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: "INVALID_JOB",
        errorMessage: "Scan job ID does not match the scan ID",
      },
    }
  }

  logger.info("Processing scan job", { scanId, targetId, mode, jobId: job.id })

  // The claimed tenant is only a scoped lookup key. No system credentials or
  // cross-workspace row may enter execution; the returned immutable row must
  // still match every job field before account/plan checks can authorize work.
  let scanRecord: StoredScanAuthority | null
  try {
    scanRecord = await withWorkspaceRLS(claimedWorkspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: scanId, workspaceId: claimedWorkspaceId },
        select: storedScanAuthoritySelect,
      })
    )
  } catch (err) {
    throw new Error("Failed to verify scan authority", { cause: err })
  }

  if (
    !scanRecord ||
    scanRecord.workspaceId !== claimedWorkspaceId ||
    scanRecord.targetId !== targetId ||
    scanRecord.goal !== goal ||
    scanRecord.mode !== mode ||
    scanRecord.policyId !== (policyId ?? null)
  ) {
    if (
      scanRecord &&
      scanRecord.workspaceId === claimedWorkspaceId &&
      options.recordFailure !== false
    ) {
      await recordAuthorityFailure(
        scanId,
        scanRecord.workspaceId,
        {
          errorCategory: "INVALID_JOB",
          errorMessage: "Scan job does not match the stored scan record",
        },
        "Failed to mark invalid scan job as failed"
      )
    }
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: "INVALID_JOB",
        errorMessage: "Scan job does not match the stored scan record",
      },
    }
  }

  // Validate the immutable execution plan snapshot when the row carries one:
  // contract schema, supported version, and the recorded canonical-JSON hash.
  // A stored plan that fails any check is evidence of tampering or an
  // incompatible writer — fail closed; the plan is never repaired, widened,
  // or substituted here or downstream.
  let executionPlan: ScanExecutionPlan | null = null
  if (scanRecord.executionPlan !== null && scanRecord.executionPlan !== undefined) {
    const planCheck = verifyStoredScanExecutionPlan(
      scanRecord.executionPlan,
      scanRecord.executionPlanHash
    )
    const recordedDepth = planCheck.ok ? normalizePlanDepth(scanRecord.mode) : null
    const depthMismatch =
      planCheck.ok && (recordedDepth === null || planCheck.plan.depth !== recordedDepth)
    if (!planCheck.ok || depthMismatch) {
      const denial = !planCheck.ok
        ? {
            errorCategory: planCheck.errorCategory,
            errorMessage: planCheck.errorMessage,
          }
        : {
            errorCategory: "SCAN_PLAN_MISMATCH",
            errorMessage: "Stored execution plan depth does not match the recorded scan mode",
          }
      logger.warn("Stored scan execution plan failed validation", {
        scanId,
        jobId: job.id,
        errorCategory: denial.errorCategory,
      })
      if (options.recordFailure !== false)
        await recordAuthorityFailure(
          scanId,
          scanRecord.workspaceId,
          denial,
          "Failed to mark invalid-plan scan as failed"
        )
      return {
        ok: false,
        result: { status: "failed", ...denial },
      }
    }
    executionPlan = planCheck.plan
  }

  return {
    ok: true,
    data: parseResult.data,
    scanRecord,
    workspaceId: scanRecord.workspaceId,
    executionPlan,
  }
}

const storedScanAuthoritySelect = {
  id: true,
  workspaceId: true,
  targetId: true,
  goal: true,
  mode: true,
  policyId: true,
  determinismMode: true,
  startedAt: true,
  createdById: true,
  sponsorAccountId: true,
  accountingVersion: true,
  triggerType: true,
  delegatedConnectionId: true,
  delegatedAuthorizationVersion: true,
  executionPlan: true,
  executionPlanHash: true,
} as const
