import { addScanEvent } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export async function emitScanEvent(
  scanId: string,
  stage: string,
  level: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await addScanEvent(scanId, stage, level, message, metadata)
  } catch (err) {
    logger.warn("Failed to persist scan event", {
      scanId,
      stage,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
