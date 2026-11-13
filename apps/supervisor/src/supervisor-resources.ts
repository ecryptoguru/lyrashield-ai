import type { ExecutorKey } from "@lyrashield/runtime-control"
import type { RuntimeExecutor } from "./executor"
import type { AttemptState } from "./journal-events"
import { RuntimeControlError } from "./service-common"

export function readSupervisorAttempt(attempts: Map<string, AttemptState>, attemptId: string) {
  const attempt = attempts.get(attemptId)
  if (!attempt) throw new RuntimeControlError("ATTEMPT_NOT_FOUND", "attempt not found", 404)
  return {
    binding: attempt.binding,
    status: attempt.status,
    receipt: attempt.receipt,
    resources: [...attempt.resources.values()],
    grants: [...attempt.grants.values()],
  }
}

export async function readSupervisorContainers(
  attempts: Map<string, AttemptState>,
  executor: RuntimeExecutor,
  scanId?: string
) {
  const result: Array<{
    attemptId: string
    scanId: string
    executorKey: ExecutorKey
    containerId: string
    createdAt: string
    running: boolean
    receiptHash: string
  }> = []
  for (const [attemptId, attempt] of attempts) {
    if (scanId && attempt.binding.scanId !== scanId) continue
    for (const resource of attempt.resources.values()) {
      if (resource.kind !== "container" || !resource.containerId) continue
      const inspection = await executor.inspect(resource)
      result.push({
        attemptId,
        scanId: attempt.binding.scanId,
        executorKey: resource.executorKey,
        containerId: resource.containerId,
        createdAt: resource.createdAt ?? attempt.binding.expiresAt,
        running: inspection.state === "PRESENT" && inspection.running === true,
        receiptHash: attempt.receipt.hash,
      })
    }
  }
  return result
}
