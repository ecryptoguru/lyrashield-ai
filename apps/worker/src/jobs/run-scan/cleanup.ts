import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { boundedCleanup } from "../../engine/scan-deadline"
import { cleanupEngineWorkspace } from "../../engine/runner"
import { engineWorkspacePath } from "../../engine/workspace-path"
import { failTerminalRetestsForScan } from "../../engine/result-integrity"

export async function cleanupScanExecution(
  scanId: string,
  deterministicCheckout?: { cleanup: () => Promise<void> } | null
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
