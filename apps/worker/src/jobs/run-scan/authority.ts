import type { Job } from "bullmq"
import {
  getSystemPrisma,
  updateScanStatus,
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
  sponsorAccountId: string | null
  triggerType: string | null
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

export async function verifyScanJobAuthority(
  job: Job<ScanJobData, ScanJobResult>
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
  if (String(job.id) !== scanId) {
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

  // Do not trust the workspaceId from the queue payload. Load the scan record
  // with a privileged client and verify the claimed tenant matches the stored
  // tenant; otherwise a forged job could read or mutate another workspace.
  let scanRecord: StoredScanAuthority | null
  try {
    scanRecord = await getSystemPrisma().scan.findUnique({
      where: { id: scanId },
      select: {
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
        triggerType: true,
        executionPlan: true,
        executionPlanHash: true,
      },
    })
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
    if (scanRecord) {
      try {
        await updateScanStatus(
          scanId,
          "FAILED" as ScanStatus,
          {
            errorCategory: "INVALID_JOB",
            errorMessage: "Scan job does not match the stored scan record",
          },
          scanRecord.workspaceId
        )
      } catch (statusErr) {
        logger.warn("Failed to mark invalid scan job as failed", {
          scanId,
          errorType: statusErr instanceof Error ? statusErr.name : "UNKNOWN",
        })
      }
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
            errorMessage:
              "Stored execution plan depth does not match the recorded scan mode",
          }
      logger.warn("Stored scan execution plan failed validation", {
        scanId,
        jobId: job.id,
        errorCategory: denial.errorCategory,
      })
      try {
        await updateScanStatus(
          scanId,
          "FAILED" as ScanStatus,
          {
            errorCategory: denial.errorCategory,
            errorMessage: denial.errorMessage,
          },
          scanRecord.workspaceId
        )
      } catch (statusErr) {
        logger.warn("Failed to mark invalid-plan scan as failed", {
          scanId,
          errorType: statusErr instanceof Error ? statusErr.name : "UNKNOWN",
        })
      }
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
