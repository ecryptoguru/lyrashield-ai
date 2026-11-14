import { z } from "zod"
import {
  canonicalJson,
  nativeEngineResultInputSchema,
  nativeEngineResultChunkSchema,
  resourceOwnershipSchema,
  NATIVE_ENGINE_RESULT_CHUNK_BYTES,
  NATIVE_ENGINE_RESULT_MAX_BYTES,
  type NativeEngineResultChunk,
  type ResourceOwnership,
} from "@lyrashield/runtime-control"
import type { SupervisorAuthorityJournal } from "./authority-journal"
import type { AttemptState, CommandState } from "./journal-events"
import { restoreJournalState } from "./restore-state"

const rootChunkSchema = z
  .object({
    schema: z.literal(1),
    offset: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().positive().max(NATIVE_ENGINE_RESULT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    chunkBase64: z.string().max(4 * Math.ceil(NATIVE_ENGINE_RESULT_CHUNK_BYTES / 3)),
  })
  .strict()
/** Installed private journal chooses ownership; the worker still independently verifies the root digest. */
export function createSupervisorNativeResultReader(options: {
  journal: Pick<SupervisorAuthorityJournal, "load" | "readCursor">
  epochId: string
  supervisorInstanceId: string
  consumeReceipts: (operationId: string) => Promise<unknown>
  readNative: (ownership: ResourceOwnership, offset: number) => Promise<unknown>
}) {
  return async (value: unknown): Promise<NativeEngineResultChunk> => {
    const input = nativeEngineResultInputSchema.parse(value)
    await options.consumeReceipts(input.operationId)
    const unavailable = {
      kind: "unknown" as const,
      operationId: input.operationId,
      attemptId: input.attemptId,
    }
    const pending = { ...unavailable, kind: "pending" as const }
    const records = await options.journal.load()
    const tail = records.at(-1)
    if (!tail) return unavailable
    const attempts = new Map<string, AttemptState>(),
      commands = new Map<string, CommandState>()
    restoreJournalState(records, attempts, commands)
    const attempt = attempts.get(input.attemptId)
    if (
      !attempt ||
      attempt.binding.operationId !== input.operationId ||
      attempt.binding.authorityEpochId !== options.epochId
    )
      return unavailable
    if (!attempt.plans.has("engine") || !attempt.startAcknowledged.has("engine")) return pending
    if (attempt.status === "UNKNOWN") return unavailable
    const started = records.filter(
      (record) =>
        record.payload.type === "resource_started" &&
        record.payload.attemptId === input.attemptId &&
        record.payload.executorKey === "engine"
    )
    const event = started.at(-1)?.payload
    if (
      event?.type !== "resource_started" ||
      event.ownership.executorKey !== "engine" ||
      event.ownership.kind !== "container" ||
      started.some(
        (record) =>
          record.payload.type === "resource_started" &&
          canonicalJson(record.payload.ownership) !== canonicalJson(event.ownership)
      )
    )
      return unavailable
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
      canonicalJson(page.records[0]?.payload.payload) !== canonicalJson(tail)
    )
      return unavailable
    let chunk: z.infer<typeof rootChunkSchema>
    try {
      chunk = rootChunkSchema.parse(
        await options.readNative(resourceOwnershipSchema.parse(event.ownership), input.offset)
      )
    } catch {
      return pending
    }
    if (chunk.offset !== input.offset) return unavailable
    const result = nativeEngineResultChunkSchema.parse({
      ...input,
      kind: "available",
      sha256: `sha256:${chunk.sha256}`,
      totalBytes: chunk.totalBytes,
      base64: chunk.chunkBase64,
      eof: chunk.offset + Buffer.from(chunk.chunkBase64, "base64").length === chunk.totalBytes,
    })
    await options.consumeReceipts(input.operationId)
    const repeated = await options.journal.readCursor(cursor)
    if (
      canonicalJson(page.snapshotHead) !== canonicalJson(repeated.snapshotHead) ||
      canonicalJson(page.records) !== canonicalJson(repeated.records)
    )
      return unavailable
    return result
  }
}
