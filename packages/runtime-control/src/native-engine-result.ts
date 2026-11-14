import { z } from "zod"

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
export const NATIVE_ENGINE_RESULT_MAX_BYTES = 96 * 1024 * 1024
export const NATIVE_ENGINE_RESULT_CHUNK_BYTES = 1024 * 1024
export const nativeEngineResultInputSchema = z
  .object({
    operationId: id,
    attemptId: id,
    offset: z.number().int().nonnegative().safe().max(NATIVE_ENGINE_RESULT_MAX_BYTES),
  })
  .strict()
export const nativeEngineResultChunkSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.enum(["pending", "unknown"]), operationId: id, attemptId: id }).strict(),
    z
      .object({
        kind: z.literal("available"),
        operationId: id,
        attemptId: id,
        sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        totalBytes: z.number().int().positive().max(NATIVE_ENGINE_RESULT_MAX_BYTES),
        offset: z.number().int().nonnegative().safe(),
        base64: z.string().max(4 * Math.ceil(NATIVE_ENGINE_RESULT_CHUNK_BYTES / 3)),
        eof: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "available") return
    const bytes = Buffer.from(value.base64, "base64")
    if (
      bytes.toString("base64") !== value.base64 ||
      bytes.length > NATIVE_ENGINE_RESULT_CHUNK_BYTES ||
      value.offset + bytes.length > value.totalBytes ||
      value.eof !== (value.offset + bytes.length === value.totalBytes) ||
      (!value.eof && bytes.length === 0)
    )
      context.addIssue({ code: "custom", message: "Engine result chunk bounds differ" })
  })
export type NativeEngineResultChunk = z.infer<typeof nativeEngineResultChunkSchema>
