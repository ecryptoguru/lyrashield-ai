import {
  canonicalJson,
  sha256Hex,
  signSupervisorAttemptProof,
  supervisorAttemptProofPublicKey,
  supervisorAttemptProofInputSchema,
  supervisorCommandSchema,
  type SupervisorAttemptProof,
} from "@lyrashield/runtime-control"
import { SupervisorAuthorityJournal } from "./authority-journal"
import type { AttemptState, CommandState } from "./journal-events"
import { restoreJournalState } from "./restore-state"
import { RuntimeControlError } from "./service-common"

function unavailable(): never {
  throw new RuntimeControlError("ATTEMPT_PROOF_UNAVAILABLE", "Attempt proof is unavailable", 503)
}

export function createSupervisorAttemptProofIssuer(options: {
  journal: SupervisorAuthorityJournal
  privateKey: string
  epochId: string
  supervisorInstanceId: string
  now?: () => Date
  registerProof?: (proof: SupervisorAttemptProof) => Promise<void>
}): (input: unknown) => Promise<SupervisorAttemptProof> {
  if (
    !(options.journal instanceof SupervisorAuthorityJournal) ||
    Buffer.byteLength(options.privateKey) > 1024
  )
    unavailable()
  supervisorAttemptProofPublicKey(options.privateKey)
  return async (value) => {
    const input = supervisorAttemptProofInputSchema.parse(value)
    if (input.authorityEpochId !== options.epochId) unavailable()
    const records = await options.journal.load()
    const tail = records.at(-1)
    if (!tail) unavailable()
    const cursor = {
      epochId: options.epochId,
      supervisorInstanceId: options.supervisorInstanceId,
      afterSequence: tail.sequence - 1,
      afterHash: tail.previousHash,
      limit: 1,
    }
    const page = await options.journal.readCursor(cursor)
    if (
      !page.snapshotHead ||
      page.snapshotHead.sequence !== tail.sequence ||
      page.records.length !== 1 ||
      canonicalJson(page.records[0]?.payload.payload) !== canonicalJson(tail)
    )
      unavailable()
    const attempts = new Map<string, AttemptState>(),
      commands = new Map<string, CommandState>()
    restoreJournalState(records, attempts, commands)
    const attempt = attempts.get(input.attemptId)
    const prepare = [...commands.values()].find(
      (state) =>
        state.request?.type === "PREPARE" && state.request.attempt.attemptId === input.attemptId
    )?.request
    if (
      !attempt ||
      prepare?.type !== "PREPARE" ||
      attempt.binding.operationId !== input.operationId ||
      attempt.binding.workspaceId !== input.workspaceId ||
      attempt.binding.scanId !== input.scanId ||
      attempt.binding.authorityEpochId !== input.authorityEpochId
    )
      unavailable()
    const preparedCompleted = records.some((record) => {
      const event = record.payload
      return (
        event.type === "prepare_invocation_completed" &&
        event.commandId === prepare.commandId &&
        event.attemptId === input.attemptId &&
        attempt.nativeAckGuards?.has(event.guardId)
      )
    })
    if (input.type.startsWith("START_")) {
      if (
        !preparedCompleted ||
        !["PREPARED", "RUNNING"].includes(attempt.status) ||
        !attempt.plans.has(input.executorKey!) ||
        (input.type === "START_PAID"
          ? attempt.binding.billingMode !== "PAID"
          : attempt.binding.billingMode !== "UNMETERED") ||
        [...commands.values()].some(
          (state) =>
            state.request &&
            "executorKey" in state.request &&
            state.request.attemptId === input.attemptId &&
            state.request.executorKey === input.executorKey
        )
      )
        unavailable()
    } else if (input.type === "RECONCILE" && attempt.status !== "UNKNOWN") unavailable()
    const command = supervisorCommandSchema.parse({
      type: input.type,
      commandId: input.commandId,
      attemptId: input.attemptId,
      expectedReceiptHash: attempt.receipt.hash,
      ...(input.executorKey ? { executorKey: input.executorKey } : {}),
    })
    const now = options.now?.() ?? new Date()
    const expiresAt = new Date(
      Math.min(
        now.getTime() + 10_000,
        input.type.startsWith("START_") ? Date.parse(attempt.binding.expiresAt) : Infinity
      )
    )
    if (expiresAt.getTime() <= now.getTime()) unavailable()
    const confirmed = await options.journal.readCursor({
      ...cursor,
      snapshotSequence: page.snapshotHead.sequence,
      snapshotHash: page.snapshotHead.recordHash,
    })
    if (canonicalJson(confirmed) !== canonicalJson(page)) unavailable()
    const proof = signSupervisorAttemptProof(
      {
        purpose: "lyrashield-supervisor-attempt-proof/2",
        input,
        binding: attempt.binding,
        supervisorInstanceId: options.supervisorInstanceId,
        prepareChecksum: sha256Hex(canonicalJson(prepare)),
        preparedCompleted,
        status: attempt.status,
        command,
        commandChecksum: sha256Hex(canonicalJson(command)),
        headInputChecksum: sha256Hex(canonicalJson(page.snapshotHead)),
        headSequence: page.snapshotHead.sequence,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      { privateKey: options.privateKey }
    )
    await options.registerProof?.(proof)
    if (Date.parse(proof.expiresAt) <= (options.now?.() ?? new Date()).getTime()) unavailable()
    return proof
  }
}
