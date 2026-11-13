import {
  canonicalJson,
  type JournalPort,
  type JournalRecord,
  type ResourceOwnership,
  type StopCommand,
} from "@lyrashield/runtime-control"
import type { NativeRetirement } from "./executor"
import type { AttemptState, SupervisorJournalEvent } from "./journal-events"

export function nativeRetirementEvidence(options: {
  journal: JournalPort<SupervisorJournalEvent>
  supervisorInstanceId: string
  nowIso: () => string
  apply: (record: JournalRecord<SupervisorJournalEvent>) => void
  attempt: AttemptState
  stop: StopCommand
  ownership: ResourceOwnership
}): NativeRetirement | undefined {
  const original = options.attempt.nativeStartIntents?.get(options.ownership.executorKey)
  if (!original || canonicalJson(original.ownership) !== canonicalJson(options.ownership))
    return undefined
  return {
    acknowledge: async ({ ownership, inspection }) => {
      if (
        canonicalJson(ownership) !== canonicalJson(original.ownership) ||
        canonicalJson(inspection) !== canonicalJson({ state: "ABSENT" })
      )
        throw new Error("native retirement evidence differs")
      const record = await options.journal.append({
        ...original,
        type: "native_invocation_retired",
        supervisorInstanceId: options.supervisorInstanceId,
        observedAt: options.nowIso(),
        stopCommandId: options.stop.commandId,
        nativeOperation: "CONTAINER_REMOVED",
        ownership,
        inspection,
      })
      options.apply(record)
    },
  }
}
