import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { SupervisorAuthorityJournal } from "./authority-journal"
import type { AttemptState, CommandState } from "./journal-events"
import { restoreJournalState } from "./restore-state"
import { commandAttemptId, commandRequestHash } from "./service-common"
import { sealedRecoverySchema, type SealedRecoverySnapshot } from "./sealed-recovery-schema"

export const MAX_SNAPSHOT_BYTES = 1024 * 1024
const ZERO = "0".repeat(64)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const pairs = <K extends string, V>(value: Map<K, V>): [K, V][] =>
  [...value.entries()].sort(([a], [b]) => compare(a, b))
const items = <T extends string>(value: Set<T>): T[] => [...value].sort(compare)

export function encodeSealedAttempts(attempts: Map<string, AttemptState>) {
  return pairs(attempts).map(([id, state]) => ({
    id,
    state: {
      binding: state.binding,
      plans: pairs(state.plans),
      ...(state.provider ? { provider: state.provider } : {}),
      grants: pairs(state.grants),
      planned: pairs(state.planned),
      resources: pairs(state.resources),
      createAcknowledged: items(state.createAcknowledged),
      startPlanned: items(state.startPlanned),
      startAcknowledged: items(state.startAcknowledged),
      nativeAckGuards: items(state.nativeAckGuards ?? new Set<string>()),
      nativeCreateProofs: pairs(state.nativeCreateProofs ?? new Map()),
      nativeStartIntents: pairs(state.nativeStartIntents ?? new Map()),
      receipt: state.receipt,
      status: state.status,
      createdExecutors: items(state.createdExecutors),
    },
  }))
}
function encodeCommands(commands: Map<string, CommandState>) {
  return pairs(commands).map(([id, state]) => ({ id, state: { ...state } }))
}
function assertUniqueSorted(values: string[]) {
  if (values.some((value, index) => index > 0 && compare(values[index - 1]!, value) >= 0))
    throw new Error("sealed recovery snapshot contains duplicate or unordered keys")
}

/** Shape and binding validation only; this does not authenticate a snapshot. */
export function validateSealedRecoverySnapshot(snapshot: SealedRecoverySnapshot): void {
  assertUniqueSorted(snapshot.attempts.map((item) => item.id))
  assertUniqueSorted(snapshot.commands.map((item) => item.id))
  const attempts = new Set(snapshot.attempts.map((item) => item.id))
  for (const { id, state } of snapshot.attempts) {
    if (
      id !== state.binding.attemptId ||
      state.binding.authorityEpochId !== snapshot.epochId ||
      state.receipt.supervisorInstanceId !== snapshot.supervisorInstanceId ||
      state.receipt.sequence > snapshot.sequence
    )
      throw new Error("sealed recovery attempt binding differs")
    for (const entries of [
      state.plans,
      state.grants,
      state.planned,
      state.resources,
      state.nativeCreateProofs,
      state.nativeStartIntents,
    ])
      assertUniqueSorted(entries.map(([key]) => key))
    for (const values of [
      state.createAcknowledged,
      state.startPlanned,
      state.startAcknowledged,
      state.createdExecutors,
      state.nativeAckGuards,
    ])
      assertUniqueSorted(values)
    if (
      state.plans.some(([key, plan]) => key !== plan.key) ||
      state.grants.some(
        ([key, grant]) =>
          key !== grant.providerId ||
          (grant.grantRequestId !== undefined &&
            !snapshot.commands.some(
              (command) =>
                command.id === grant.grantRequestId &&
                command.state.request?.type === "START_PAID" &&
                command.state.request.attemptId === id
            ))
      ) ||
      state.planned.some(([key, ownership]) => key !== ownership.executorKey) ||
      state.resources.some(([key, ownership]) => key !== ownership.executorKey) ||
      state.nativeCreateProofs.some(([key, ownership]) => key !== ownership.executorKey) ||
      state.nativeStartIntents.some(
        ([key, intent]) =>
          key !== intent.executorKey ||
          key !== intent.ownership.executorKey ||
          intent.attemptId !== id ||
          intent.operationId !== state.binding.operationId ||
          intent.authorityEpochId !== snapshot.epochId ||
          intent.supervisorInstanceId !== snapshot.supervisorInstanceId ||
          intent.nativeRequestId !== intent.guardId ||
          state.nativeAckGuards.includes(intent.guardId) ||
          !state.startPlanned.includes(key) ||
          !snapshot.commands.some(
            (command) =>
              command.id === intent.commandId &&
              command.state.attemptId === id &&
              (command.state.request?.type === "START_UNMETERED" ||
                command.state.request?.type === "START_PAID") &&
              command.state.requestHash === intent.actionChecksum &&
              command.state.requestHash === intent.commandInputChecksum
          ) ||
          !state.nativeCreateProofs.some(
            ([proofKey, proof]) =>
              proofKey === key && canonicalJson(proof) === canonicalJson(intent.ownership)
          )
      )
    )
      throw new Error("sealed recovery resource binding differs")
  }
  for (const { id, state } of snapshot.commands) {
    if (
      !attempts.has(state.attemptId) ||
      state.receipt.supervisorInstanceId !== snapshot.supervisorInstanceId ||
      state.receipt.sequence > snapshot.sequence ||
      (state.request &&
        (state.request.commandId !== id ||
          commandAttemptId(state.request) !== state.attemptId ||
          commandRequestHash(state.request) !== state.requestHash))
    )
      throw new Error("sealed recovery command binding differs")
  }
}

/** Unpublished candidate only; the protected publisher must bind it to an independently pinned seal. */
export async function createSealedRecoveryCandidate(
  source: SupervisorAuthorityJournal,
  stream: { epochId: string; supervisorInstanceId: string; lastSequence: number }
): Promise<{
  bytes: Uint8Array
  sha256: string
  sequence: number
  originalLastHash: string
  wrapperLastHash: string
}> {
  if (
    !(source instanceof SupervisorAuthorityJournal) ||
    !Number.isSafeInteger(stream.lastSequence) ||
    stream.lastSequence < 1
  )
    throw new Error("confirmed supervisor journal source is required")
  const records = await source.load()
  const target = records[stream.lastSequence - 1]
  const head = records.at(-1)
  if (!target || !head) throw new Error("confirmed recovery sequence is unavailable")
  const cursor = {
    epochId: stream.epochId,
    supervisorInstanceId: stream.supervisorInstanceId,
    afterSequence: stream.lastSequence - 1,
    afterHash: records[stream.lastSequence - 2]?.hash ?? ZERO,
    limit: 1,
  }
  const page = await source.readCursor(cursor)
  const wrapper = page.records[0]
  if (
    !wrapper ||
    !page.snapshotHead ||
    page.snapshotHead.sequence !== records.length ||
    page.snapshotHead.eventId !== `supervisor:${head.hash}` ||
    wrapper.sequence !== stream.lastSequence ||
    canonicalJson(wrapper.payload.payload) !== canonicalJson(target)
  )
    throw new Error("confirmed supervisor snapshot changed or differs")
  const attempts = new Map<string, AttemptState>(),
    commands = new Map<string, CommandState>()
  restoreJournalState(records.slice(0, stream.lastSequence), attempts, commands)
  const raw = {
    schema: "lyrashield-supervisor-recovery-snapshot/1" as const,
    epochId: stream.epochId,
    supervisorInstanceId: stream.supervisorInstanceId,
    sequence: stream.lastSequence,
    originalHash: target.hash,
    wrapperHash: wrapper.hash,
    attempts: encodeSealedAttempts(attempts),
    commands: encodeCommands(commands),
  }
  const snapshot = sealedRecoverySchema.parse(raw)
  if (canonicalJson(snapshot) !== canonicalJson(raw))
    throw new Error("sealed recovery state was normalized")
  validateSealedRecoverySnapshot(snapshot)
  const bytes = Buffer.from(canonicalJson(snapshot), "utf8")
  // shortcut: retaining every command eventually reaches 1 MiB; upgrade when authenticated historical lookup exists.
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error("sealed recovery snapshot exceeds its bounded capacity")
  const rechecked = await source.readCursor({
    ...cursor,
    snapshotSequence: page.snapshotHead.sequence,
    snapshotHash: page.snapshotHead.recordHash,
  })
  if (canonicalJson(page) !== canonicalJson(rechecked))
    throw new Error("confirmed supervisor snapshot changed while folding")
  return {
    bytes,
    sha256: sha256Hex(bytes.toString("utf8")),
    sequence: snapshot.sequence,
    originalLastHash: snapshot.originalHash,
    wrapperLastHash: snapshot.wrapperHash,
  }
}
