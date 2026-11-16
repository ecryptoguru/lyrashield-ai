import { posix } from "node:path"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import { resourceOwnershipSchema } from "./protocol"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const requestObject = z
  .object({
    binding: z
      .object({ attemptId: id, operationId: id, authorityEpochId: id, sandboxHandle: id })
      .strict(),
    requestId: z.string().uuid(),
    commandId: id,
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(8192)
          .refine((value) => !value.includes("\0"))
      )
      .min(1)
      .max(256),
    cwd: z.string().min(1).max(4096),
    user: z.literal("pentester"),
    timeoutSeconds: z.number().positive().max(300),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  })
  .strict()
export const sandboxToolRequestSchema = requestObject.refine(
  (request) => Buffer.byteLength(canonicalJson(request)) <= 1024 * 1024
)
const descriptorRequest = requestObject.extend({ argv: requestObject.shape.argv.optional() })
const ptyBase = {
  yieldTimeSeconds: z.number().min(0).max(30),
  maxOutputTokens: z.number().int().min(1).max(100000),
}
const ptyStart = z.object({ ...ptyBase, tty: z.boolean() }).strict()
const ptyStdin = z
  .object({
    ...ptyBase,
    sessionId: z.number().int().positive().safe(),
    outputCursor: z.number().int().nonnegative().safe(),
    chars: z.string().refine((value) => Buffer.byteLength(value) <= 64 * 1024),
  })
  .strict()
const ptyTerminate = z.object({ stopSandbox: z.literal(true).optional() }).strict()

export const sandboxToolExecDescriptorSchema = z
  .object({
    schema: z.literal("lyrashield-sandbox-tool-exec/1"),
    request: descriptorRequest,
    workspaceRoot: z.string().min(1).max(4096),
    ownership: resourceOwnershipSchema,
    resultKind: z
      .enum([
        "files/read",
        "files/write",
        "workspace/persist",
        "workspace/hydrate",
        "state/renew",
        "pty/start",
        "pty/stdin",
        "pty/terminate",
      ])
      .optional(),
    pty: z.union([ptyStart, ptyStdin, ptyTerminate]).optional(),
  })
  .strict()
  .refine((descriptor) => {
    const kind = descriptor.resultKind
    if (kind === "pty/stdin" || kind === "pty/terminate")
      return (
        descriptor.request.argv === undefined &&
        (kind === "pty/stdin"
          ? ptyStdin.safeParse(descriptor.pty).success
          : ptyTerminate.safeParse(descriptor.pty).success)
      )
    if (!sandboxToolRequestSchema.safeParse(descriptor.request).success) return false
    return kind === "pty/start"
      ? ptyStart.safeParse(descriptor.pty).success
      : descriptor.pty === undefined
  })
  .refine(
    (descriptor) =>
      descriptor.workspaceRoot.startsWith("/") &&
      descriptor.workspaceRoot === posix.normalize(descriptor.workspaceRoot) &&
      descriptor.workspaceRoot !== "/" &&
      descriptor.request.cwd === descriptor.workspaceRoot &&
      descriptor.ownership.kind === "container" &&
      descriptor.ownership.executorKey === "sandbox" &&
      /^[a-f0-9]{64}$/.test(descriptor.ownership.containerId ?? "")
  )

export type SandboxToolRequest = z.infer<typeof sandboxToolRequestSchema>
export type SandboxToolExecDescriptor = z.infer<typeof sandboxToolExecDescriptorSchema>
