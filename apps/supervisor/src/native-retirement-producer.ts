import {
  canonicalJson,
  parseSandboxToolRetirementProof,
  sha256Hex,
  type JournalPort,
  type JournalRecord,
  type ResourceOwnership,
  type StopCommand,
} from "@lyrashield/runtime-control"
import type { NativeRetirement } from "./executor"
import type { AttemptState, SupervisorJournalEvent } from "./journal-events"
import { matchesOwnership } from "./service-common"
import { parseNativeRemovalProof } from "./native-removal-proof"

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
  const creation = original?.phase === "EXECUTOR_CREATE"
  if (
    (!original && options.ownership.executorKey !== "sandbox") ||
    (original &&
      (creation
        ? !matchesOwnership(original.ownership, options.ownership)
        : canonicalJson(original.ownership) !== canonicalJson(options.ownership)))
  )
    return undefined
  return {
    acknowledgeTools: async (inputs) => {
      if (inputs.length > 32 || (inputs.length && options.ownership.executorKey !== "sandbox"))
        throw new Error("Sandbox retirement proof bound differs")
      const seen = new Set<string>()
      for (const input of inputs) {
        const proof = parseSandboxToolRetirementProof(input)
        if (
          seen.has(proof.guardId) ||
          canonicalJson(proof.ownership) !== canonicalJson(options.ownership) ||
          proof.stopCommandId !== options.stop.commandId ||
          proof.operationId !== options.attempt.binding.operationId ||
          proof.attemptId !== options.attempt.binding.attemptId ||
          proof.authorityEpochId !== options.attempt.binding.authorityEpochId
        )
          throw new Error("Sandbox tool removal scope differs")
        seen.add(proof.guardId)
        const record = await options.journal.append({
          type: "native_invocation_retired",
          phase: "SANDBOX_TOOL",
          supervisorInstanceId: options.supervisorInstanceId,
          observedAt: options.nowIso(),
          commandId: proof.commandId,
          stopCommandId: proof.stopCommandId,
          attemptId: proof.attemptId,
          operationId: proof.operationId,
          authorityEpochId: proof.authorityEpochId,
          executorKey: "sandbox",
          guardId: proof.guardId,
          nativeRequestId: proof.guardId,
          bindingInputChecksum: sha256Hex(proof.bindingInputJson),
          actionChecksum: proof.actionChecksum,
          commandInputChecksum: proof.commandInputChecksum,
          nativeOperation: "CONTAINER_REMOVED",
          ownership: proof.ownership,
          inspection: proof.inspection,
          nativeToolRetirementProof: proof,
        })
        options.apply(record)
      }
    },
    acknowledge: async ({ ownership, inspection, nativeRemovalProof }) => {
      if (!original) {
        if (
          canonicalJson(ownership) !== canonicalJson(options.ownership) ||
          canonicalJson(inspection) !== canonicalJson({ state: "ABSENT" })
        )
          throw new Error("Owned sandbox removal differs")
        return
      }
      if (
        (creation
          ? !matchesOwnership(original.ownership, ownership)
          : canonicalJson(ownership) !== canonicalJson(original.ownership)) ||
        canonicalJson(inspection) !== canonicalJson({ state: "ABSENT" })
      )
        throw new Error("native retirement evidence differs")
      const proof = creation ? parseNativeRemovalProof(nativeRemovalProof) : undefined
      if (
        proof &&
        (proof.guardId !== original.guardId ||
          proof.commandId !== original.commandId ||
          proof.stopCommandId !== options.stop.commandId ||
          proof.operationId !== original.operationId ||
          proof.attemptId !== original.attemptId ||
          proof.authorityEpochId !== original.authorityEpochId ||
          proof.bindingInputChecksum !== original.bindingInputChecksum ||
          proof.actionChecksum !== original.actionChecksum ||
          canonicalJson(proof.ownership) !== canonicalJson(ownership))
      )
        throw new Error("original create removal proof differs")
      const record = await options.journal.append({
        ...original,
        type: "native_invocation_retired",
        supervisorInstanceId: options.supervisorInstanceId,
        observedAt: options.nowIso(),
        stopCommandId: options.stop.commandId,
        nativeOperation: "CONTAINER_REMOVED",
        ownership,
        inspection,
        ...(proof ? { nativeRemovalProof: proof } : {}),
      })
      options.apply(record)
    },
  }
}
