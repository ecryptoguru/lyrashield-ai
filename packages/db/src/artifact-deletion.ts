import { randomUUID } from "node:crypto"
import { getSystemPrisma } from "./system-client"
import type { ArtifactDeletionTask } from "./generated/prisma"

const LEASE_MS = 5 * 60_000
const MAX_ATTEMPTS = 10
const MAX_RETRY_DELAY_MS = 60 * 60_000

export async function claimArtifactDeletionTask(
  taskIds?: readonly string[],
  now = new Date()
): Promise<ArtifactDeletionTask | null> {
  if (taskIds && taskIds.length === 0) return null

  const leaseToken = randomUUID()
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS)
  const rows = await getSystemPrisma().$queryRaw<ArtifactDeletionTask[]>`
    SELECT * FROM app.claim_artifact_deletion_task(
      ${taskIds ? [...taskIds] : null}::text[],
      ${now},
      ${leaseToken},
      ${leaseExpiresAt}
    )`
  return rows[0] ?? null
}

export async function completeArtifactDeletionTask(
  id: string,
  leaseToken: string
): Promise<boolean> {
  const rows = await getSystemPrisma().$queryRaw<Array<{ completed: boolean }>>`
    SELECT app.complete_artifact_deletion_task(${id}, ${leaseToken}) AS completed`
  return rows[0]?.completed === true
}

export async function failArtifactDeletionTask(
  task: Pick<ArtifactDeletionTask, "id" | "attempts" | "leaseToken">,
  error: unknown,
  now = new Date()
): Promise<"retry" | "dead_letter" | "lease_lost"> {
  if (!task.leaseToken) return "lease_lost"

  const deadLetter = task.attempts >= MAX_ATTEMPTS
  const retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.max(0, task.attempts - 1))
  const nextAttemptAt = deadLetter ? now : new Date(now.getTime() + retryDelayMs)
  const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  const rows = await getSystemPrisma().$queryRaw<Array<{ failed: boolean }>>`
    SELECT app.fail_artifact_deletion_task(
      ${task.id},
      ${task.leaseToken},
      ${deadLetter ? "DEAD_LETTER" : "PENDING"},
      ${nextAttemptAt},
      ${lastError}
    ) AS failed`
  if (rows[0]?.failed !== true) return "lease_lost"
  return deadLetter ? "dead_letter" : "retry"
}

export async function countDeadLetterArtifactDeletionTasks(): Promise<number> {
  const rows = await getSystemPrisma().$queryRaw<Array<{ count: bigint }>>`
    SELECT app.count_dead_letter_artifact_deletion_tasks() AS count`
  return Number(rows[0]?.count ?? 0)
}
