import { notifyScanFailed } from "../../notifications"
import { addScanEvent } from "@lyrashield/db"
import { logger as log } from "@lyrashield/logger"
import { summarizeVibeSecurityCoverage } from "@lyrashield/security"
import type { runScannerOrchestrator } from "../../engine/scanner-orchestrator"

export async function recordScannerCompletion(
  scanId: string,
  orchestratorResult: Awaited<ReturnType<typeof runScannerOrchestrator>>
) {
  try {
    await addScanEvent(
      scanId,
      "scanners_complete",
      "info",
      `Scan phases complete: engine=${orchestratorResult.engineFindings.length}, sca=${orchestratorResult.scaFindings.length}, secrets=${orchestratorResult.secretsFindings.length}, url=${orchestratorResult.urlFindings.length}, agent_config=${orchestratorResult.agentConfigFindings.length}, sast=${orchestratorResult.sastFindings.length}, iac=${orchestratorResult.iacFindings.length}, ml_supply_chain=${orchestratorResult.mlSupplyChainFindings.length}, ai_app_security=${orchestratorResult.aiAppSecurityFindings.length}, false_positives_filtered=${orchestratorResult.filteredFalsePositives}`,
      {
        engine: orchestratorResult.engineFindings.length,
        sca: orchestratorResult.scaFindings.length,
        secrets: orchestratorResult.secretsFindings.length,
        url: orchestratorResult.urlFindings.length,
        agentConfig: orchestratorResult.agentConfigFindings.length,
        sast: orchestratorResult.sastFindings.length,
        iac: orchestratorResult.iacFindings.length,
        mlSupplyChain: orchestratorResult.mlSupplyChainFindings.length,
        aiAppSecurity: orchestratorResult.aiAppSecurityFindings.length,
        falsePositivesFiltered: orchestratorResult.filteredFalsePositives,
        stats: orchestratorResult.stats,
      }
    )
  } catch (eventErr) {
    log.warn("Failed to persist scanners_complete event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    })
  }

  const coverage = summarizeVibeSecurityCoverage(orchestratorResult.allFindings)
  try {
    await addScanEvent(
      scanId,
      "coverage_contract",
      "info",
      `Vibe Security 50: ${coverage.reviewControlsRequested} code/URL review controls requested where applicable; ${coverage.matchedControlRanks.length} produced findings; ${coverage.evidenceControlsRequired} require deployment or human evidence`,
      coverage
    )
  } catch (eventErr) {
    log.warn("Failed to persist coverage_contract event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    })
  }

  return coverage
}

export async function notifyTerminalScanFailure(
  workspaceId: string,
  scanId: string,
  errorCategory: string | undefined,
  errorMessage: Parameters<typeof notifyScanFailed>[2]
) {
  if (errorCategory !== "BUDGET_EXCEEDED") {
    try {
      await notifyScanFailed(workspaceId, scanId, errorMessage)
    } catch (notificationError) {
      log.warn("Failed to send scan failure notification", {
        scanId,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      })
    }
  }
}
