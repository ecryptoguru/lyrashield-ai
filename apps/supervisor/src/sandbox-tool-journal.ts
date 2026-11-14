import { createHash } from "node:crypto"
import { z } from "zod"
import {
  IndependentAuthorityError,
  canonicalJson,
  verifyJournalRecord,
  type AuthorityEvent,
  type IndependentAuthorityJournal,
  type JournalPort,
  type JournalRecord,
} from "@lyrashield/runtime-control"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import {
  sandboxToolResponseBindingSchema,
  type SandboxToolRetainedResponse,
  type SandboxToolResponseBinding,
} from "./sandbox-tool-response"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const binding = z
  .object({
    authorityEpochId: id,
    operationId: id,
    scanId: id,
    workspaceId: id,
    attemptId: id,
  })
  .strict()
const tool = z
  .object({
    requestId: id,
    kind: z.enum(["exec", "pty/start"]),
    commandId: id,
    prepareCommandId: id,
    invocationGuardId: id,
    actionChecksum: hash,
    handleChecksum: hash,
    containerId: hash,
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional(),
    execId: hash.optional(),
    responseChecksum: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    objectDigest: hash.optional(),
  })
  .strict()
export const sandboxToolEventSchema = z
  .object({
    type: z.enum([
      "tool_intent",
      "tool_created",
      "tool_starting",
      "tool_started",
      "tool_response",
      "tool_ack",
    ]),
    supervisorInstanceId: id,
    observedAt: z.string().datetime({ offset: true }),
    binding,
    tool,
  })
  .strict()
  .refine((event) => {
    const terminal = event.type === "tool_response" || event.type === "tool_ack"
    return (
      (event.type === "tool_intent"
        ? event.tool.execId === undefined
        : event.tool.execId !== undefined) &&
      (terminal
        ? event.tool.responseChecksum !== undefined && event.tool.objectDigest !== undefined
        : event.tool.responseChecksum === undefined && event.tool.objectDigest === undefined)
    )
  })
export type SandboxToolEvent = z.infer<typeof sandboxToolEventSchema>
type Original = JournalRecord<SandboxToolEvent>
const sourceSerial = new WeakMap<object, Promise<void>>()

/**
 * Exact signed tool records are usable only after the independent journal has
 * returned and read back its durable mirror acknowledgement. This class does
 * not authorize a tool operation; the caller must hold the native action fence.
 */
export class SandboxToolJournal {
  constructor(
    private readonly source: JournalPort<SandboxToolEvent>,
    private readonly independent: IndependentAuthorityJournal<Original>,
    private readonly sourceSigningSecret: string,
    private readonly epochId: string,
    private readonly supervisorInstanceId: string,
    ownerSupervisorInstanceId: string
  ) {
    id.parse(supervisorInstanceId)
    id.parse(ownerSupervisorInstanceId)
    if (supervisorInstanceId !== `${ownerSupervisorInstanceId}.tools`)
      throw new Error("tool journal requires the derived protected stream identity")
    const stream = independent.streamIdentity()
    if (stream.epochId !== epochId || stream.supervisorInstanceId !== supervisorInstanceId)
      throw new Error("independent journal has a foreign tool stream identity")
  }

  private wrap(original: Original): AuthorityEvent<Original> {
    const payload = sandboxToolEventSchema.parse(original.payload)
    if (
      payload.binding.authorityEpochId !== this.epochId ||
      payload.supervisorInstanceId !== this.supervisorInstanceId
    )
      throw new IndependentAuthorityError("AUTHORITY_CONFLICT", "foreign tool journal stream")
    return {
      epochId: payload.binding.authorityEpochId,
      operationId: payload.binding.operationId,
      scanId: payload.binding.scanId,
      workspaceId: payload.binding.workspaceId,
      attemptId: payload.binding.attemptId,
      eventId: `supervisor:${original.hash}`,
      payload: original,
    }
  }

  private async readSource(): Promise<Original[]> {
    const originals = (await this.source.load()).map((record) =>
      verifyJournalRecord(record, this.sourceSigningSecret, (value) =>
        sandboxToolEventSchema.parse(value)
      )
    )
    let previous = "0".repeat(64)
    for (const [index, record] of originals.entries()) {
      if (record.sequence !== index + 1 || record.previousHash !== previous)
        throw new IndependentAuthorityError("AUTHORITY_CONFLICT", "invalid tool source chain")
      previous = record.hash
    }
    projectSandboxToolHistory(originals.map((record) => record.payload))
    return originals
  }

  private async readConfirmed(): Promise<Original[]> {
    const originals = await this.readSource()
    const confirmed = await this.independent.loadConfirmed()
    if (
      confirmed.length !== originals.length ||
      confirmed.some(
        (record, index) =>
          canonicalJson(record.payload) !== canonicalJson(this.wrap(originals[index]!))
      )
    )
      throw new IndependentAuthorityError("REPLAY_REQUIRED", "tool source requires exact recovery")
    return originals
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = (sourceSerial.get(this.source) ?? Promise.resolve()).then(operation)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    sourceSerial.set(this.source, settled)
    return run.finally(() => {
      if (sourceSerial.get(this.source) === settled) sourceSerial.delete(this.source)
    })
  }

  async load(): Promise<Original[]> {
    return this.exclusive(() => this.readConfirmed())
  }

  /** The caller must hold the authenticated attempt fence for this exact ACK. */
  async recoverAcknowledgement(
    binding: SandboxToolResponseBinding,
    requestId: string,
    responseChecksum: string,
    verifyRetained: (proof: SandboxToolRetainedResponse, event: SandboxToolEvent) => Promise<void>
  ): Promise<void> {
    const checked = sandboxToolResponseBindingSchema.parse(binding)
    const selected = await this.exclusive(async () => {
      const original = (await this.readSource()).at(-1)
      const event = original?.payload
      const handle = createHash("sha256").update(canonicalJson(checked.sandboxHandle)).digest("hex")
      if (
        !original ||
        !event ||
        event.type !== "tool_ack" ||
        event.binding.attemptId !== checked.attemptId ||
        event.binding.operationId !== checked.operationId ||
        event.binding.authorityEpochId !== checked.authorityEpochId ||
        event.tool.requestId !== requestId ||
        event.tool.handleChecksum !== handle ||
        event.tool.responseChecksum !== responseChecksum ||
        !event.tool.objectDigest
      )
        throw new IndependentAuthorityError(
          "REPLAY_REQUIRED",
          "exact pending tool acknowledgement is unavailable"
        )
      return {
        sequence: original.sequence,
        hash: original.hash,
        objectDigest: event.tool.objectDigest,
        event: structuredClone(event),
      }
    })
    await verifyRetained({ responseChecksum, objectDigest: selected.objectDigest }, selected.event)
    await this.recoverExactTail(selected)
  }

  /** Replay only the exact signed source tail; never repeat a physical tool operation. */
  async recoverExactTail(input: { sequence: number; hash: string }): Promise<Original> {
    return this.exclusive(async () => {
      const sequence = z.number().int().positive().safe().parse(input.sequence)
      const expectedHash = hash.parse(input.hash)
      const originals = await this.readSource()
      const original = originals.at(-1)
      if (!original || original.sequence !== sequence || original.hash !== expectedHash)
        throw new IndependentAuthorityError("AUTHORITY_CONFLICT", "tool recovery identity differs")
      if (!this.source.confirmRecord)
        throw new IndependentAuthorityError(
          "AUTHORITY_UNKNOWN",
          "tool source fsync confirmation is unavailable"
        )
      const confirmedSource = await this.source.confirmRecord(original)
      if (canonicalJson(confirmedSource) !== canonicalJson(original))
        throw new IndependentAuthorityError(
          "AUTHORITY_CONFLICT",
          "tool source confirmation changed"
        )
      await this.independent.appendIntent(this.wrap(original))
      const confirmed = await this.readConfirmed()
      if (canonicalJson(confirmed.at(-1)) !== canonicalJson(original))
        throw new IndependentAuthorityError(
          "AUTHORITY_CONFLICT",
          "tool recovery confirmation changed"
        )
      return original
    })
  }

  async append(input: SandboxToolEvent): Promise<Original> {
    return this.exclusive(async () => {
      const event = sandboxToolEventSchema.parse(input)
      if (
        event.binding.authorityEpochId !== this.epochId ||
        event.supervisorInstanceId !== this.supervisorInstanceId
      )
        throw new IndependentAuthorityError("AUTHORITY_CONFLICT", "foreign tool journal stream")
      const originals = await this.readConfirmed()
      const history = originals.map((record) => record.payload)
      const states = projectSandboxToolHistory(history)
      const sameRequest = states.get(event.tool.requestId) ?? []
      if (event.type === "tool_response" || event.type === "tool_ack") {
        const prior = sameRequest.find((entry) => entry.type === event.type)
        if (prior) {
          if (
            canonicalJson({ ...prior, observedAt: "" }) !==
            canonicalJson({ ...event, observedAt: "" })
          )
            throw new Error("sandbox tool response transition changed")
          return originals.find((record) => record.payload === prior)!
        }
      }
      if (
        event.type === "tool_intent" &&
        (sameRequest.length > 0 ||
          [...states.values()].some(
            (entries) =>
              entries[0]?.tool.commandId === event.tool.commandId ||
              (entries[0]?.binding.attemptId === event.binding.attemptId &&
                entries.at(-1)?.type !== "tool_ack")
          ))
      )
        throw new Error("sandbox tool operation is already recorded or unresolved")
      projectSandboxToolHistory([...history, event])
      const record = await this.source.append(event)
      verifyJournalRecord(record, this.sourceSigningSecret, (value) =>
        sandboxToolEventSchema.parse(value)
      )
      await this.independent.appendIntent(this.wrap(record))
      const confirmed = await this.readConfirmed()
      if (canonicalJson(confirmed.at(-1)) !== canonicalJson(record))
        throw new IndependentAuthorityError("AUTHORITY_CONFLICT", "tool confirmation changed")
      return record
    })
  }
}
