import { z } from "zod"
import { authorityActionSchema, resourceOwnershipSchema } from "@lyrashield/runtime-control"

export const NATIVE_EXECUTOR_SOCKET = "/run/lyrashield/control/native-executor.sock"
export const NATIVE_REQUEST_BYTES = 64 * 1024
export const NATIVE_RESPONSE_BYTES = 2 * 1024 * 1024
const guardId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/)
const effect = {
  schema: z.literal(1),
  guardId,
  action: authorityActionSchema,
}
export const nativeExecutorRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...effect, method: z.literal("create") }).strict(),
  z.object({ ...effect, method: z.literal("start"), ownership: resourceOwnershipSchema }).strict(),
  z.object({ ...effect, method: z.literal("tool") }).strict(),
  z.object({ ...effect, method: z.literal("tool-observe") }).strict(),
  z
    .object({
      schema: z.literal(1),
      method: z.literal("inspect"),
      ownership: resourceOwnershipSchema,
    })
    .strict(),
  z
    .object({ schema: z.literal(1), method: z.literal("stop"), ownership: resourceOwnershipSchema })
    .strict(),
  z
    .object({
      schema: z.literal(1),
      method: z.literal("pty-read"),
      ownership: resourceOwnershipSchema,
      sessionId: z.number().int().positive().safe(),
      outputCursor: z.number().int().nonnegative().safe(),
      maxOutputBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024),
    })
    .strict(),
  z
    .object({
      schema: z.literal(1),
      method: z.literal("result-read"),
      ownership: resourceOwnershipSchema,
      offset: z.number().int().nonnegative().safe(),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024),
    })
    .strict(),
])
export type NativeExecutorRequest = z.infer<typeof nativeExecutorRequestSchema>
