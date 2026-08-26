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
      if (task.kind !== "EVIDENCE") {
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
