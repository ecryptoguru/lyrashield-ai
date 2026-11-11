import {
  supervisorRecoveryRequestSchema,
  type JournalRecord,
  type SupervisorCommandResult,
  type SupervisorJournalRecoveryPort,
  type SupervisorRecoveryResult,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"
import { RuntimeControlError } from "./service-common"

interface RecoveryServiceContext {
  journal: Partial<SupervisorJournalRecoveryPort<SupervisorJournalEvent>>
  busy(): boolean
  initialization(): Promise<void> | null
  serialized<T>(operation: () => Promise<T>): Promise<T>
  install(records: JournalRecord<SupervisorJournalEvent>[]): void
  resultFor(commandId: string): SupervisorCommandResult
  enter(run: Promise<unknown>): void
  leave(): void
}

/** Gates normal initialization while explicit authorized durability recovery runs. */
export function recoverServiceState(
  ctx: RecoveryServiceContext,
  input: unknown
): Promise<SupervisorRecoveryResult<SupervisorJournalEvent>> {
  const parsed = supervisorRecoveryRequestSchema.safeParse(input)
  if (!parsed.success)
    throw new RuntimeControlError("INVALID_RECOVERY", "invalid recovery selector", 400)
  if (ctx.busy())
    throw new RuntimeControlError("RECOVERY_BUSY", "runtime actions remain in flight", 503)
  if (!ctx.journal.recoverStored)
    throw new RuntimeControlError("RECOVERY_UNAVAILABLE", "trusted recovery is unavailable", 503)
  const prior = ctx.initialization()
  const run = ctx
    .serialized(async () => {
      if (prior) await prior.catch(() => undefined)
      const recovered = await ctx.journal.recoverStored!(parsed.data)
      ctx.install(recovered.records)
      const command = ctx.resultFor(parsed.data.commandId)
      if (command.status !== "UNKNOWN")
        throw new RuntimeControlError(
          "RECOVERY_UNCERTAIN",
          "recovered disposition is not held",
          503
        )
      return {
        status: "UNKNOWN" as const,
        command,
        recoveredRecord: recovered.recoveredRecord,
        holdRecord: recovered.holdRecord,
      }
    })
    .finally(() => ctx.leave())
  ctx.enter(run)
  return run
}
