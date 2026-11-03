import type { ScanExecutionResult } from "./execution"
import {
  revokeRelayGrant,
  type RelayAttempt,
  type RelayRuntimeConfig,
} from "../../engine/relay-client"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { boundedCleanup } from "../../engine/scan-deadline"
import { cleanupEngineWorkspace } from "../../engine/runner"
import { engineWorkspacePath } from "../../engine/workspace-path"
import { failTerminalRetestsForScan } from "../../engine/result-integrity"

export async function cleanupScanExecution(
  scanId: string,
  ownsEngineWorkspace: boolean,
  deterministicCheckout?: { cleanup: () => Promise<void> } | null,
  outcome?: ScanExecutionResult
) {
  try {
    await failTerminalRetestsForScan(scanId)
  } catch (retestError) {
    logger.warn("Failed to finalize retest state", {
      scanId,
      error: retestError instanceof Error ? retestError.message : String(retestError),
    })
  }
  try {
    await boundedCleanup(
      (async () => {
        await deterministicCheckout?.cleanup()
        // A confirmed pre-dispatch denial cleans only its own attachment publication.
        // An existing workspace can belong to another delivery.
        const didNotDispatch = outcome?.ok === false && outcome.noEngineDispatchAfterClaim
        if (ownsEngineWorkspace && !didNotDispatch)
          await cleanupEngineWorkspace(engineWorkspacePath(scanId), scanId)
      })()
    )
  } catch (cleanupError) {
    const error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    logger.error("Engine workspace cleanup requires operator attention", { scanId, error })
    try {
      await addScanEvent(
        scanId,
        "cleanup_failed",
        "error",
        "Engine workspace cleanup requires operator attention",
        { error }
      )
    } catch (eventError) {
      logger.error("Failed to persist cleanup failure event", {
        scanId,
        error: eventError instanceof Error ? eventError.message : String(eventError),
      })
    }
  }
}

export async function revokeFailedRelayRegistration(
  scanId: string,
  relayConfig: RelayRuntimeConfig,
  attempt: RelayAttempt,
  grantError: unknown
): Promise<void> {
  try {
    await revokeRelayGrant(scanId, relayConfig, attempt)
  } catch (cleanupError) {
    // Cleanup must not replace the original registration/audit failure.
    try {
      logger.error("Failed to revoke relay grant after setup failure", {
        scanId,
        setupErrorType: grantError instanceof Error ? grantError.name : "UNKNOWN",
        cleanupErrorType: cleanupError instanceof Error ? cleanupError.name : "UNKNOWN",
      })
    } catch {
      // Logging must not replace the original registration/audit failure either.
    }
  }
}
