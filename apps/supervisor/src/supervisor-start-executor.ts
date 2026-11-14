import type { ExecutorSpec, ResourceOwnership, StartCommand } from "@lyrashield/runtime-control"
import { chainChecks, type ExecutorContext } from "./executor"
import type { AttemptState } from "./journal-events"
import { recordNativeStartPlan } from "./native-ack-producer"
import type { SupervisorServiceOptions } from "./service"
import type { SupervisorOperations } from "./supervisor-operations"

export function startFencedExecutor(options: {
  service: SupervisorServiceOptions
  operations: SupervisorOperations
  attempt: AttemptState
  command: StartCommand
  spec: ExecutorSpec
  context: Omit<ExecutorContext, "assertActive">
  ownership: ResourceOwnership
  checkStop: () => void
  nowIso: () => string
  apply: Parameters<typeof recordNativeStartPlan>[0]["apply"]
}): Promise<ResourceOwnership> {
  const { service, operations, attempt, command, spec, context, ownership, checkStop } = options
  return operations.withExecutorAuthority(
    attempt,
    command,
    "EXECUTOR_START",
    async (assertActive, nativeInvocation) => {
      assertActive()
      checkStop()
      await operations.recordExecutorStartIntent(attempt, command)
      assertActive()
      checkStop()
      if (nativeInvocation) {
        await recordNativeStartPlan({
          journal: service.journal,
          supervisorInstanceId: service.supervisorInstanceId,
          nowIso: options.nowIso,
          apply: options.apply,
          attempt,
          command,
          ownership,
          guardId: nativeInvocation.requestId,
          assertActive,
        })
        checkStop()
      }
      return service.executor.start(ownership, spec, {
        attemptId: context.attemptId,
        commandId: context.commandId,
        ...(nativeInvocation ? { nativeInvocation } : {}),
        assertActive: chainChecks(assertActive, checkStop),
      })
    }
  )
}
