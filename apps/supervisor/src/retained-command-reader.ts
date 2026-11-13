import { SupervisorCommandHistoryReader } from "@lyrashield/db/src/scan-supervisor-command-history-reader"
import { z } from "zod"
import {
  withVerifiedJournalContinuation,
  supervisorCommandSchema,
  type JournalContinuationOptions,
  type SupervisorCommand,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"
import { matchRetainedSupervisorCommand } from "./retained-command-continuation"
import { commandAttemptId, commandRequestHash } from "./service-common"

const retainedHistorySchema = z
  .object({
    command: z.unknown(),
    commandInputJson: z.string().max(1024 * 1024),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    originalInputJson: z.string().max(1024 * 1024),
    wrapperInputJson: z.string().max(1024 * 1024),
    observedStatus: z.string().max(64),
    statusOriginalInputJson: z.string().max(1024 * 1024),
    statusWrapperInputJson: z.string().max(1024 * 1024),
    headInputJson: z.string().max(16384),
    confirmedSequence: z.number().int().positive().safe(),
  })
  .strict()

/** Positive source lookup only: callers must treat the returned physical state as UNKNOWN. */
export async function readCurrentRetainedCommand(options: {
  reader: SupervisorCommandHistoryReader
  continuation: JournalContinuationOptions<SupervisorJournalEvent>
  streamId: string
  command: SupervisorCommand
}) {
  if (!SupervisorCommandHistoryReader.isInstalled(options.reader))
    throw new Error("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  const command = supervisorCommandSchema.parse(options.command)
  const requestHash = commandRequestHash(command)
  const attemptId = commandAttemptId(command)
  return withVerifiedJournalContinuation(options.continuation, async (state) =>
    options.reader.withRead(
      {
        streamId: options.streamId,
        authorityEpochId: options.continuation.stream.epochId,
        commandId: command.commandId,
        attemptId,
        requestHash,
      },
      async (history, assertActive) => {
        assertActive()
        const matched = matchRetainedSupervisorCommand(
          state,
          retainedHistorySchema.parse(history),
          {
            commandId: command.commandId,
            attemptId,
            requestHash,
          }
        )
        assertActive()
        state.assertActive()
        return { ...matched, physicalStatus: "UNKNOWN" as const }
      }
    )
  )
}
