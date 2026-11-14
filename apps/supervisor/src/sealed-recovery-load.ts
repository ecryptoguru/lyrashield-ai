import { createHash } from "node:crypto"
import {
  canonicalJson,
  ProtectedJournalSealPinStore,
  StoredJournalSealEvidenceReader,
  type BoundedConditionalObjectStore,
} from "@lyrashield/runtime-control"
import type { AttemptState, CommandState } from "./journal-events"
import { MAX_SNAPSHOT_BYTES, validateSealedRecoverySnapshot } from "./sealed-recovery"
import { sealedRecoverySchema, type SealedRecoverySnapshot } from "./sealed-recovery-schema"

interface RecoveryLoadOptions {
  stream: { epochId: string; supervisorInstanceId: string }
  pin: ProtectedJournalSealPinStore
  evidence: StoredJournalSealEvidenceReader
  store: Pick<BoundedConditionalObjectStore, "readBounded">
}

export function decodeSealedAttempts(snapshot: SealedRecoverySnapshot): Map<string, AttemptState> {
  const attempts = new Map<string, AttemptState>()
  for (const { id, state } of snapshot.attempts) {
    const { nativeAckGuards, nativeCreateProofs, nativeRetirements, nativeStartIntents, ...rest } =
      state
    attempts.set(id, {
      ...rest,
      plans: new Map(state.plans),
      grants: new Map(state.grants),
      planned: new Map(state.planned),
      resources: new Map(state.resources),
      createAcknowledged: new Set(state.createAcknowledged),
      startPlanned: new Set(state.startPlanned),
      startAcknowledged: new Set(state.startAcknowledged),
      nativeAckGuards: new Set(nativeAckGuards),
      nativeCreateProofs: new Map(nativeCreateProofs),
      nativeRetirements: new Map(nativeRetirements ?? []),
      nativeStartIntents: new Map(nativeStartIntents),
      createdExecutors: new Set(state.createdExecutors),
    })
  }
  return attempts
}

/** Reads only a pinned, exact-head recovery base. Tail recovery needs a separate authenticated contract. */
export async function loadSealedRecoveryBase(options: RecoveryLoadOptions): Promise<{
  sequence: number
  originalHash: string
  wrapperHash: string
  attempts: Map<string, AttemptState>
  commands: Map<string, CommandState>
}> {
  if (
    !(options.pin instanceof ProtectedJournalSealPinStore) ||
    !(options.evidence instanceof StoredJournalSealEvidenceReader)
  )
    throw new Error("protected recovery snapshot readers are required")
  const pin = await options.pin.readCurrent(options.stream)
  const evidence = await options.evidence.readCurrentSealEvidence(options.stream)
  if (
    !pin ||
    !evidence ||
    evidence.seal.schema !== "lyrashield-journal-seal/2" ||
    pin.sealHash !== evidence.seal.sealHash ||
    pin.revision !== evidence.seal.revision ||
    pin.lastSequence !== evidence.seal.lastSequence ||
    pin.originalLastHash !== evidence.seal.originalLastHash ||
    pin.wrapperLastHash !== evidence.seal.wrapperLastHash ||
    pin.independentHeadHash !== evidence.seal.independentHeadHash ||
    evidence.journalHead.sequence !== evidence.seal.lastSequence
  )
    throw new Error("pinned exact-head recovery snapshot is unavailable")
  const seal = evidence.seal
  const key = `epochs/${seal.epochId}/supervisors/${seal.supervisorInstanceId}/recovery-snapshots/${seal.sealHash}`
  const object = await options.store.readBounded(
    key,
    Math.min(MAX_SNAPSHOT_BYTES, seal.recoverySnapshotBytes)
  )
  if (
    !object ||
    !object.etag ||
    object.bytes.byteLength !== seal.recoverySnapshotBytes ||
    createHash("sha256").update(object.bytes).digest("hex") !== seal.recoverySnapshotSha256
  )
    throw new Error("sealed recovery snapshot is unavailable or changed")
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)
  const snapshot = sealedRecoverySchema.parse(JSON.parse(raw))
  if (
    canonicalJson(snapshot) !== raw ||
    snapshot.epochId !== seal.epochId ||
    snapshot.supervisorInstanceId !== seal.supervisorInstanceId ||
    snapshot.sequence !== seal.lastSequence ||
    snapshot.originalHash !== seal.originalLastHash ||
    snapshot.wrapperHash !== seal.wrapperLastHash
  )
    throw new Error("sealed recovery snapshot anchor differs")
  validateSealedRecoverySnapshot(snapshot)
  const attempts = decodeSealedAttempts(snapshot)
  const commands = new Map<string, CommandState>(
    snapshot.commands.map(({ id, state }) => [id, state])
  )
  const [again, finalPin, finalEvidence] = await Promise.all([
    options.store.readBounded(key, seal.recoverySnapshotBytes),
    options.pin.readCurrent(options.stream),
    options.evidence.readCurrentSealEvidence(options.stream),
  ])
  if (
    !again ||
    again.etag !== object.etag ||
    !Buffer.from(again.bytes).equals(Buffer.from(object.bytes)) ||
    canonicalJson(finalPin) !== canonicalJson(pin) ||
    !finalEvidence ||
    canonicalJson(finalEvidence.seal) !== canonicalJson(seal) ||
    canonicalJson(finalEvidence.journalHead) !== canonicalJson(evidence.journalHead) ||
    !Buffer.from(finalEvidence.journalObservedAck).equals(
      Buffer.from(evidence.journalObservedAck)
    ) ||
    !Buffer.from(finalEvidence.sealObservedAck).equals(Buffer.from(evidence.sealObservedAck))
  )
    throw new Error("sealed recovery snapshot changed during readback")
  return {
    sequence: snapshot.sequence,
    originalHash: snapshot.originalHash,
    wrapperHash: snapshot.wrapperHash,
    attempts,
    commands,
  }
}
