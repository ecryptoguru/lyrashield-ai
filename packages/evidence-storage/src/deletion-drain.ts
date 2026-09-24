import {
  claimArtifactDeletionTask,
  completeArtifactDeletionTask,
  failArtifactDeletionTask,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface ArtifactDeletionDrainResult {
  claimed: number
  deleted: number
  retrying: number
  deadLettered: number
}

/**
 * Every supported kind is an encrypted object under the same
 * evidence/<workspaceId>/ store, so one deleter covers all of them. The task
 * table's own CHECK constraint is the boundary for new kinds; anything the
 * drain does not recognize stays retryable instead of being silently dropped.
 */
const SUPPORTED_DELETION_KINDS = new Set(["EVIDENCE", "SCAN_ATTACHMENT"])

export async function drainArtifactDeletionTasksWith(
  deleteArtifact: (storageUri: string, workspaceId: string) => Promise<void>,
  options?: { taskIds?: readonly string[]; limit?: number }
): Promise<ArtifactDeletionDrainResult> {
  const limit = Math.min(Math.max(options?.limit ?? 25, 1), 100)
  const result: ArtifactDeletionDrainResult = {
    claimed: 0,
    deleted: 0,
    retrying: 0,
    deadLettered: 0,
  }

  for (let index = 0; index < limit; index++) {
    const task = await claimArtifactDeletionTask(options?.taskIds)
    if (!task) break
    result.claimed++

    try {
      if (!SUPPORTED_DELETION_KINDS.has(task.kind)) {
        throw new Error(`Unsupported artifact deletion kind: ${task.kind}`)
      }
      await deleteArtifact(task.storageUri, task.workspaceId)
      if (task.leaseToken && (await completeArtifactDeletionTask(task.id, task.leaseToken))) {
        result.deleted++
      } else {
        logger.warn("Artifact deletion lease was lost after object removal", { taskId: task.id })
      }
    } catch (error) {
      const disposition = await failArtifactDeletionTask(task, error)
      if (disposition === "retry") result.retrying++
      if (disposition === "dead_letter") {
        result.deadLettered++
        logger.error("Artifact deletion task reached dead letter", {
          taskId: task.id,
          workspaceId: task.workspaceId,
          kind: task.kind,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return result
}
