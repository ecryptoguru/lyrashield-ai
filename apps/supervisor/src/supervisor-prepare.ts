import { canonicalJson, sha256Hex, type SupervisorCommand } from "@lyrashield/runtime-control"
import { assertPrepareAllowed } from "./policy"
import { RuntimeControlError, commandRequestHash } from "./service-common"
import type { SupervisorOperationsContext } from "./supervisor-operations"

export async function prepareSupervisorAttempt(
  ctx: SupervisorOperationsContext,
  command: Extract<SupervisorCommand, { type: "PREPARE" }>
) {
  if (!ctx.options.authorityFence)
    throw new RuntimeControlError(
      "AUTHORITY_UNAVAILABLE",
      "Native scan authority is unavailable",
      503
    )
  assertPrepareAllowed(command, ctx.options.policy)
  if (ctx.attempts.has(command.attempt.attemptId))
    throw new RuntimeControlError("ATTEMPT_CONFLICT", "attempt already exists with different input")
  const binding = {
    phase: "PREPARE" as const,
    operationId: command.attempt.operationId,
    attemptId: command.attempt.attemptId,
    scanId: command.attempt.scanId,
    workspaceId: command.attempt.workspaceId,
    authorityEpochId: command.attempt.authorityEpochId,
    authorityRevision: command.attempt.authorityRevision,
    authorityChecksum: sha256Hex(
      canonicalJson({
        attempt: command.attempt,
        executors: command.executors,
        provider: command.provider ?? null,
      })
    ),
    actionChecksum: commandRequestHash(command),
    commandId: command.commandId,
  }
  // The accepted intent is durable before metadata completion. A lost
  // acknowledgement remains bound to the original guard and is never replayed.
  return ctx.options.authorityFence.run(binding, async (assertActive, invocation) => {
    assertActive()
    await ctx.appendIntent(command)
    assertActive()
    const record = await ctx.options.journal.append({
      type: "attempt_prepared",
      supervisorInstanceId: ctx.options.supervisorInstanceId,
      observedAt: ctx.nowIso(),
      commandId: command.commandId,
      binding: command.attempt,
      executors: command.executors,
      ...(command.provider ? { provider: command.provider } : {}),
    })
    ctx.apply(record)
    if (invocation) {
      assertActive()
      const proof = await ctx.options.journal.append({
        type: "prepare_invocation_completed",
        supervisorInstanceId: ctx.options.supervisorInstanceId,
        observedAt: ctx.nowIso(),
        commandId: command.commandId,
        attemptId: command.attempt.attemptId,
        operationId: command.attempt.operationId,
        authorityEpochId: command.attempt.authorityEpochId,
        guardId: invocation.guardId,
        nativeRequestId: invocation.guardId,
        bindingInputChecksum: sha256Hex(canonicalJson(binding)),
        actionChecksum: binding.actionChecksum,
        commandInputChecksum: commandRequestHash(command),
      })
      ctx.apply(proof)
      assertActive()
    }
    return ctx.resultFor(command.commandId)
  })
}
