import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "./canonical-json"
import { headSchema } from "./independent-journal"
import {
  verifyJournalSeal,
  type JournalSealEvidence,
  type JournalSealEvidenceReader,
} from "./journal-seal"
import type { JournalSealControlGate, JournalSealControlProof } from "./native-journal-seal-gate"
import { R2ConditionalObjectStore } from "./r2-store"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const counter = z.number().int().positive().safe()
export const journalSealPinSchema = z
  .object({
    schema: z.literal("lyrashield-journal-seal-pin/1"),
    epochId: identity,
    supervisorInstanceId: identity,
    revision: counter,
    sealHash: hash,
    lastSequence: counter,
    originalLastHash: hash,
    wrapperLastHash: hash,
    independentHeadHash: hash,
    observedJournalAckHash: hash,
    observedSealAckHash: hash,
  })
  .strict()
export type JournalSealPin = z.infer<typeof journalSealPinSchema>
const envelopeSchema = z
  .object({
    schema: z.literal("lyrashield-root-control-seal-pin/1"),
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    parentPinHash: hash.nullable(),
    pin: journalSealPinSchema,
    signature: hash,
  })
  .strict()
const ackSchema = z
  .object({
    schema: z.literal("lyrashield-journal-seal-observed-mirror-ack/1"),
    epochId: identity,
    supervisorInstanceId: identity,
    revision: counter,
    sealHash: hash,
    signature: hash,
  })
  .strict()
type Stream = { epochId: string; supervisorInstanceId: string }
type CurrentPin = {
  pin: JournalSealPin | null
  etag: string
  hash: string
  bytes: Buffer
  confirmed: boolean
}
export interface ProtectedJournalSealPinOptions extends Stream {
  epoch: number
  productRevision: string
  checkpointSecret: string
  /** Hash authenticated by the installed root-qualified policy, not an API argument. */
  checkpointKeyHash: string
  controlAccountId: string
  controlBucket: string
  genesisRecordHash: string
}
function fail(): never {
  throw new Error("Protected journal seal pin unavailable")
}
function requireProof(value: unknown): asserts value {
  if (!value) fail()
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * Root-control installation only. Its bucket/client credentials must be distinct
 * from journal, worker and backup/restore credentials. No HTTP request installs
 * this object or supplies a seal, acknowledgement, signing key or next pin.
 */
export class ProtectedJournalSealPinStore {
  private readonly installed: Readonly<ProtectedJournalSealPinOptions>
  private readonly key: string
  constructor(
    private readonly control: R2ConditionalObjectStore,
    private readonly evidence: JournalSealEvidenceReader,
    private readonly gate: JournalSealControlGate,
    options: ProtectedJournalSealPinOptions
  ) {
    this.installed = Object.freeze({ ...options })
    identity.parse(options.epochId)
    identity.parse(options.supervisorInstanceId)
    counter.parse(options.epoch)
    z.string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(options.productRevision)
    requireProof(Buffer.byteLength(options.checkpointSecret) >= 32)
    requireProof(sha256Hex(options.checkpointSecret) === hash.parse(options.checkpointKeyHash))
    requireProof(control instanceof R2ConditionalObjectStore)
    this.key = `journal-seal-pins/${options.epochId}/${options.supervisorInstanceId}/current`
  }
  assertEvidenceReader(reader: JournalSealEvidenceReader): void {
    requireProof(reader === this.evidence)
  }
  private sign(value: unknown): string {
    return createHmac("sha256", this.installed.checkpointSecret)
      .update(canonicalJson(value))
      .digest("hex")
  }
  private verifySignature(signature: string, value: unknown): void {
    requireProof(timingSafeEqual(Buffer.from(signature), Buffer.from(this.sign(value))))
  }
  private stream(stream: Stream): void {
    requireProof(
      equal(stream, {
        epochId: this.installed.epochId,
        supervisorInstanceId: this.installed.supervisorInstanceId,
      })
    )
  }
  private acknowledgement(pin: JournalSealPin, envelopeHash: string): Buffer {
    const body = {
      schema: "lyrashield-root-control-seal-observed-cas-ack/1",
      epochId: pin.epochId,
      supervisorInstanceId: pin.supervisorInstanceId,
      revision: pin.revision,
      sealHash: pin.sealHash,
      pinEnvelopeHash: envelopeHash,
    }
    return Buffer.from(canonicalJson({ ...body, signature: this.sign(body) }))
  }
  private acknowledgementKey(envelopeHash: string): string {
    return this.key.replace(/\/current$/, "/observed-cas-acks/" + envelopeHash)
  }
  private async read(permitPending = false): Promise<CurrentPin> {
    const object = await this.control.readBounded(this.key, 4096)
    requireProof(object)
    const raw = Buffer.from(object.bytes).toString("utf8")
    const parsed = JSON.parse(raw)
    if (parsed.schema === "lyrashield-root-control-seal-genesis/1") {
      const genesis = z
        .object({
          schema: z.literal("lyrashield-root-control-seal-genesis/1"),
          productRevision: z.string().regex(/^[a-f0-9]{40}$/),
          epochId: identity,
          supervisorInstanceId: identity,
          signature: hash,
        })
        .strict()
        .parse(parsed)
      const { signature, ...body } = genesis
      this.verifySignature(signature, body)
      this.stream({ epochId: genesis.epochId, supervisorInstanceId: genesis.supervisorInstanceId })
      requireProof(genesis.productRevision === this.installed.productRevision)
      requireProof(
        raw === canonicalJson(genesis) && sha256Hex(raw) === this.installed.genesisRecordHash
      )
      return {
        pin: null,
        etag: object.etag,
        hash: sha256Hex(raw),
        bytes: Buffer.from(object.bytes),
        confirmed: true,
      }
    }
    const value = envelopeSchema.parse(parsed)
    requireProof(raw === canonicalJson(value))
    const { signature, ...body } = value
    this.verifySignature(signature, body)
    this.stream({
      epochId: value.pin.epochId,
      supervisorInstanceId: value.pin.supervisorInstanceId,
    })
    requireProof(value.productRevision === this.installed.productRevision)
    requireProof(
      value.pin.revision === 1
        ? value.parentPinHash === this.installed.genesisRecordHash
        : value.parentPinHash !== null
    )
    const envelopeHash = sha256Hex(raw)
    const ack = await this.control.readBounded(this.acknowledgementKey(envelopeHash), 4096)
    const confirmed =
      ack !== null && Buffer.from(ack.bytes).equals(this.acknowledgement(value.pin, envelopeHash))
    if (ack) requireProof(confirmed)
    requireProof(permitPending || confirmed)
    return {
      pin: value.pin,
      etag: object.etag,
      hash: envelopeHash,
      bytes: Buffer.from(object.bytes),
      confirmed,
    }
  }
  async readCurrent(stream: Stream): Promise<JournalSealPin | null> {
    this.stream(stream)
    return this.gate.withAuthorizedStream(stream, async (proof) => {
      this.bindPolicy(proof)
      proof.assertActive()
      const current = await this.read()
      proof.assertActive()
      return current.pin
    })
  }
  async withBoundedContinuation<T>(
    stream: Stream,
    action: (anchor: {
      pin: JournalSealPin
      seal: JournalSealEvidence["seal"]
      journalHead: JournalSealEvidence["journalHead"]
      assertActive: () => void
    }) => Promise<T>
  ): Promise<T> {
    this.stream(stream)
    return this.gate.withAuthorizedStream(stream, async (proof) => {
      this.bindPolicy(proof)
      proof.assertActive()
      const current = await this.read()
      requireProof(this.evidence.readSealAnchorForContinuation)
      const observed = await this.evidence.readSealAnchorForContinuation(stream)
      requireProof(current.pin && observed)
      const seal = verifyJournalSeal(observed.seal, this.installed.checkpointSecret)
      requireProof(seal.schema === "lyrashield-journal-seal/2")
      requireProof(equal(current.pin, this.pinFromEvidence(stream, observed, false)))
      proof.assertActive()
      // A newer matching head is only an input to the caller's complete local and
      // independent-mirror tail proof. Keep authority locked through that proof.
      const result = await action({
        pin: current.pin,
        seal,
        journalHead: observed.journalHead,
        assertActive: () => proof.assertActive(),
      })
      proof.assertActive()
      const rechecked = await this.read()
      requireProof(rechecked.hash === current.hash)
      proof.assertActive()
      return result
    })
  }
  private async next(stream: Stream): Promise<JournalSealPin> {
    const observed = await this.evidence.readCurrentSealEvidence(stream)
    requireProof(observed)
    return this.pinFromEvidence(stream, observed, true)
  }
  private pinFromEvidence(
    stream: Stream,
    observed: JournalSealEvidence,
    requireCurrentHead: boolean
  ): JournalSealPin {
    const seal = verifyJournalSeal(observed.seal, this.installed.checkpointSecret)
    const head = headSchema.parse(observed.journalHead)
    const ackRaw = Buffer.from(observed.sealObservedAck).toString("utf8")
    requireProof(
      Buffer.byteLength(ackRaw) <= 4096 && observed.journalObservedAck.byteLength <= 4096
    )
    const ack = ackSchema.parse(JSON.parse(ackRaw))
    requireProof(ackRaw === canonicalJson(ack))
    const { signature, ...ackBody } = ack
    this.verifySignature(signature, ackBody)
    requireProof(
      seal.epochId === stream.epochId && seal.supervisorInstanceId === stream.supervisorInstanceId
    )
    requireProof(
      ack.epochId === stream.epochId && ack.supervisorInstanceId === stream.supervisorInstanceId
    )
    requireProof(ack.revision === seal.revision && ack.sealHash === seal.sealHash)
    requireProof(
      head.epochId === stream.epochId && head.supervisorInstanceId === stream.supervisorInstanceId
    )
    requireProof(head.sequence >= seal.lastSequence)
    if (requireCurrentHead)
      requireProof(sha256Hex(canonicalJson(head)) === seal.independentHeadHash)
    requireProof(
      createHash("sha256").update(observed.journalObservedAck).digest("hex") ===
        seal.observedJournalAckHash
    )
    return journalSealPinSchema.parse({
      schema: "lyrashield-journal-seal-pin/1",
      epochId: stream.epochId,
      supervisorInstanceId: stream.supervisorInstanceId,
      revision: seal.revision,
      sealHash: seal.sealHash,
      lastSequence: seal.lastSequence,
      originalLastHash: seal.originalLastHash,
      wrapperLastHash: seal.wrapperLastHash,
      independentHeadHash: seal.independentHeadHash,
      observedJournalAckHash: seal.observedJournalAckHash,
      observedSealAckHash: createHash("sha256").update(observed.sealObservedAck).digest("hex"),
    })
  }
  private async observeCas(
    pin: JournalSealPin,
    bytes: Buffer,
    proof: JournalSealControlProof
  ): Promise<void> {
    proof.assertActive()
    const envelopeHash = sha256Hex(bytes.toString("utf8"))
    const acknowledgement = this.acknowledgement(pin, envelopeHash)
    await this.control.put(this.acknowledgementKey(envelopeHash), acknowledgement, {
      ifNoneMatch: true,
    })
    proof.assertActive()
    const stored = await this.control.readBounded(this.acknowledgementKey(envelopeHash), 4096)
    requireProof(stored && Buffer.from(stored.bytes).equals(acknowledgement))
  }
  private async replayCurrent(
    current: CurrentPin,
    proof: JournalSealControlProof
  ): Promise<"advanced" | "conflict"> {
    requireProof(current.pin)
    proof.assertActive()
    const result = await this.control.put(this.key, current.bytes, { ifMatch: current.etag })
    proof.assertActive()
    if (result === "conflict") return "conflict"
    await this.observeCas(current.pin, current.bytes, proof)
    requireProof((await this.read()).hash === current.hash)
    return "advanced"
  }
  async retryPending(stream: Stream, sealHash: string): Promise<JournalSealPin> {
    this.stream(stream)
    hash.parse(sealHash)
    return this.gate.withAuthorizedStream(stream, async (proof) => {
      this.bindPolicy(proof)
      proof.assertActive()
      const current = await this.read(true)
      requireProof(
        current.pin &&
          current.pin.sealHash === sealHash &&
          equal(current.pin, await this.next(stream))
      )
      if (!current.confirmed)
        requireProof((await this.replayCurrent(current, proof)) === "advanced")
      const confirmed = await this.read()
      requireProof(confirmed.pin && confirmed.hash === current.hash)
      proof.assertActive()
      return confirmed.pin
    })
  }
  private async advance(
    stream: Stream,
    expected: JournalSealPin | null,
    proof: JournalSealControlProof
  ): Promise<"advanced" | "conflict"> {
    const current = await this.read(true)
    const next = await this.next(stream)
    // Retrying the same original update after a lost response reobserves it;
    // an unrelated/newer pin is never treated as that acknowledgement.
    if (current.pin && equal(current.pin, next)) {
      if (equal(current.pin, expected))
        return current.confirmed ? "advanced" : this.replayCurrent(current, proof)
      const seal = await this.evidence.readCurrentSealEvidence(stream)
      if (
        current.pin.revision !== (expected?.revision ?? 0) + 1 ||
        !seal ||
        seal.seal.previousSealHash !== (expected?.sealHash ?? "0".repeat(64)) ||
        seal.seal.firstSequence !== (expected?.lastSequence ?? 0) + 1 ||
        seal.seal.originalPreviousHash !== (expected?.originalLastHash ?? "0".repeat(64)) ||
        seal.seal.wrapperPreviousHash !== (expected?.wrapperLastHash ?? "0".repeat(64))
      )
        return "conflict"
      return current.confirmed ? "advanced" : this.replayCurrent(current, proof)
    }
    requireProof(current.confirmed)
    if (!equal(current.pin, expected)) return "conflict"
    requireProof(next.revision === (current.pin?.revision ?? 0) + 1)
    requireProof(next.lastSequence > (current.pin?.lastSequence ?? 0))
    const seal = await this.evidence.readCurrentSealEvidence(stream)
    requireProof(seal && seal.seal.sealHash === next.sealHash)
    requireProof(seal.seal.previousSealHash === (current.pin?.sealHash ?? "0".repeat(64)))
    requireProof(seal.seal.firstSequence === (current.pin?.lastSequence ?? 0) + 1)
    requireProof(
      seal.seal.originalPreviousHash === (current.pin?.originalLastHash ?? "0".repeat(64))
    )
    requireProof(seal.seal.wrapperPreviousHash === (current.pin?.wrapperLastHash ?? "0".repeat(64)))
    const body = {
      schema: "lyrashield-root-control-seal-pin/1" as const,
      productRevision: this.installed.productRevision,
      parentPinHash: current.hash,
      pin: next,
    }
    const bytes = Buffer.from(canonicalJson({ ...body, signature: this.sign(body) }))
    proof.assertActive()
    const result = await this.control.put(this.key, bytes, { ifMatch: current.etag })
    proof.assertActive()
    if (result === "conflict") return "conflict"
    await this.observeCas(next, bytes, proof)
    requireProof(equal((await this.read()).pin, next))
    return "advanced"
  }
  private bindPolicy(proof: JournalSealControlProof): void {
    const policy = proof.policy
    for (const field of [
      "productRevision",
      "epochId",
      "epoch",
      "supervisorInstanceId",
      "checkpointKeyHash",
      "controlAccountId",
      "controlBucket",
      "genesisRecordHash",
    ] as const)
      requireProof(policy[field] === this.installed[field])
  }
  async compareAndAdvance(input: {
    stream: Stream
    expected: JournalSealPin | null
  }): Promise<"advanced" | "conflict"> {
    this.stream(input.stream)
    if (input.expected) journalSealPinSchema.parse(input.expected)
    return this.gate.withAuthorizedStream(input.stream, async (proof) => {
      this.bindPolicy(proof)
      proof.assertActive()
      return this.advance(input.stream, input.expected, proof)
    })
  }
}
