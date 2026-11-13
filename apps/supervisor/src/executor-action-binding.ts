import {
  canonicalJson,
  sha256Hex,
  type AuthorityAction,
  type StartCommand,
} from "@lyrashield/runtime-control"
import type { AttemptState } from "./journal-events"
import { commandRequestHash } from "./service-common"

export function executorActionBinding(
  attempt: AttemptState,
  command: StartCommand,
  phase: "EXECUTOR_CREATE" | "EXECUTOR_START"
): AuthorityAction {
  return {
    phase,
    operationId: attempt.binding.operationId,
    attemptId: attempt.binding.attemptId,
    scanId: attempt.binding.scanId,
    workspaceId: attempt.binding.workspaceId,
    authorityEpochId: attempt.binding.authorityEpochId,
    authorityRevision: attempt.binding.authorityRevision,
    authorityChecksum: sha256Hex(
      canonicalJson({
        attempt: attempt.binding,
        executors: [...attempt.plans.values()],
        provider: attempt.provider ?? null,
      })
    ),
    actionChecksum: commandRequestHash(command),
    commandId: command.commandId,
    executorKey: command.executorKey,
  }
}
