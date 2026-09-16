import {
  debitOverage,
  enterGrace,
  recordAgentMinutes,
  resolveAccountBilling,
} from "@lyrashield/billing"
import {
  prisma,
  runWithAccountContext,
  type ScanStatus,
  type ScopedTransaction,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  AGENT_MINUTES_EXHAUSTED_ERROR_CATEGORY,
  AGENT_MINUTES_EXHAUSTED_ERROR_MESSAGE,
  AGENT_MINUTES_OVERAGE_LIMIT_ERROR_MESSAGE,
} from "@lyrashield/types"
import type { EngineRunRecord } from "../../engine/output-parser"
import type { ScanJobData } from "../../types"
import { shouldRecordAgentMinutes } from "./usage"

export interface ScanTerminalError {
  status: ScanStatus
  errorCategory: string
  errorMessage: string
}

export type EngineBillingOutcome = "completed" | "partial" | "failed" | "cancelled"

export function createEngineMinuteMeter(params: {
  scanId: string
  workspaceId: string
  mode: ScanJobData["mode"]
  engineBacked: boolean
  engineWallClockMs: number
  sponsorAccountId: string
  exitStatus: "COMPLETED" | "PARTIAL" | "FAILED"
  runRecord: EngineRunRecord | null
  onTerminalError: (error: ScanTerminalError) => void
}): (billingOutcome: EngineBillingOutcome, finishEvidence?: () => Promise<void>) => Promise<void> {
  const {
    scanId,
    workspaceId,
    mode,
    engineBacked,
    engineWallClockMs,
    sponsorAccountId,
    exitStatus,
    runRecord,
    onTerminalError,
  } = params
  let agentMinuteTerminalError: ScanTerminalError | null = null
  const setTerminalError = (error: ScanTerminalError) => {
    agentMinuteTerminalError = error
    onTerminalError(error)
  }

  return async (billingOutcome, finishEvidence) => {
    const billableWork =
      engineBacked &&
      shouldRecordAgentMinutes(
        scanId,
        billingOutcome === "partial" ? "PARTIAL" : exitStatus,
        runRecord,
        { cancelled: billingOutcome === "cancelled" }
      )
    if (!billableWork || billingOutcome === "failed") return

    let finalizationAttempted = false
    try {
      const settleOverage = async (minutes: number, tx?: ScopedTransaction) => {
        // Overage is available to Launch Assurance accounts with a
        // limit — read inside the settlement tx when one is bound so
        // the decision cannot act on a stale row.
        const sponsorBilling = tx
          ? await resolveAccountBilling(sponsorAccountId, tx)
          : await runWithAccountContext(sponsorAccountId, () =>
              resolveAccountBilling(sponsorAccountId)
            )
        const overageAvailable =
          sponsorBilling?.effectivePlan === "LAUNCH_ASSURANCE" &&
          (sponsorBilling.spendLimitCents ?? 0) > 0

        if (overageAvailable) {
          const overage = await debitOverage({
            accountId: sponsorAccountId,
            workspaceId,
            minutes,
            scanId,
            phase: "engine_overage",
            transaction: tx,
          })
          if (!overage.debited || overage.minutes !== minutes) {
            setTerminalError({
              status: "STOPPED_BUDGET" as ScanStatus,
              errorCategory: AGENT_MINUTES_EXHAUSTED_ERROR_CATEGORY,
              errorMessage: AGENT_MINUTES_OVERAGE_LIMIT_ERROR_MESSAGE,
            })
          }
        } else {
          // Enter grace period (15min cap) — the account's grace budget.
          const graceResult = await enterGrace(sponsorAccountId, engineWallClockMs, tx)
          if (!graceResult.shouldContinue) {
            // Preserve provider usage, deterministic receipts, and findings before
            // sealing the terminal entitlement outcome below.
            setTerminalError({
              status: "STOPPED_BUDGET" as ScanStatus,
              errorCategory: AGENT_MINUTES_EXHAUSTED_ERROR_CATEGORY,
              errorMessage: AGENT_MINUTES_EXHAUSTED_ERROR_MESSAGE,
            })
          }
        }
        if (tx && agentMinuteTerminalError) throw new Error(agentMinuteTerminalError.errorCategory)
      }
      const metering = await recordAgentMinutes(workspaceId, scanId, engineWallClockMs, {
        mode,
        phase: "engine_run",
        outcome: billingOutcome,
        ...(finishEvidence
          ? {
              beforeCommit: async () => {
                finalizationAttempted = true
                await finishEvidence()
              },
            }
          : {}),
        // Cancellation deliberately retains its existing settlement policy.
        ...(billingOutcome !== "cancelled"
          ? { settleOverage: (tx, minutes) => settleOverage(minutes, tx) }
          : {}),
      })
      if (billingOutcome === "cancelled" && metering.overageMinutes > 0) {
        await settleOverage(metering.overageMinutes)
      }
    } catch (meterError) {
      // Finalization failures must not be swallowed or retried outside
      // the transaction that just rolled back their provisional charges.
      if (finalizationAttempted) throw meterError
      // Billable success requires a durable settlement obligation. A
      // preliminary account read or intent insert can fail before the
      // finalizer starts; never silently complete through that window.
      // Quota refusal and cancellation retain their existing paths.
      if (billingOutcome !== "cancelled" && !agentMinuteTerminalError) throw meterError
      if (agentMinuteTerminalError) {
        await prisma.auditLog.create({
          data: {
            workspaceId,
            action: "billing.scan_settlement_refused",
            resourceType: "scan",
            resourceId: scanId,
            metadata: { reason: agentMinuteTerminalError.errorCategory },
          },
        })
      }
      logger.warn("Failed to record agent minutes", {
        scanId,
        error: meterError instanceof Error ? meterError.message : String(meterError),
      })
      // Cancellation remains best-effort; quota refusal is finalized below.
    }
  }
}
