import type {
  AuthorityAction,
  ExecutorSpec,
  JournalPort,
  JournalRecord,
  ResourceOwnership,
  StartCommand,
} from "@lyrashield/runtime-control"
import { DockerRuntimeExecutor } from "../src/executor"
import type { AttemptState, SupervisorJournalEvent } from "../src/journal-events"
import { nativeInvocationAcknowledgement, recordNativeStartPlan } from "../src/native-ack-producer"

/** Test-only adapter: the caller owns the real protected fixture journal and DB fence. */
export async function invokeNativeDockerFixture(input: {
  journal: JournalPort<SupervisorJournalEvent>
  supervisorInstanceId: string
  attempt: AttemptState
  command: StartCommand
  binding: AuthorityAction
  guardId: string
  spec: ExecutorSpec
  assertActive: () => void
  apply: (record: JournalRecord<SupervisorJournalEvent>) => void
  ownership?: ResourceOwnership
}) {
  const executor = new DockerRuntimeExecutor()
  const nativeInvocation = nativeInvocationAcknowledgement({
    ...input,
    nowIso: () => new Date().toISOString(),
  })
  const context = {
    attemptId: input.attempt.binding.attemptId,
    commandId: input.command.commandId,
    assertActive: input.assertActive,
    nativeInvocation,
  }
  if (input.binding.phase === "EXECUTOR_CREATE")
    return executor.create(input.command.executorKey, input.spec, context)
  if (input.binding.phase === "EXECUTOR_START" && input.ownership) {
    await recordNativeStartPlan({
      ...input,
      ownership: input.ownership,
      nowIso: () => new Date().toISOString(),
    })
    return executor.start(input.ownership, input.spec, context)
  }
  throw new Error("fixture requires an exact create or start binding")
}

export async function cleanupNativeDockerFixture(ownership: ResourceOwnership) {
  return new DockerRuntimeExecutor().stop(ownership)
}
