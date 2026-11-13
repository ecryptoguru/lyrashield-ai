import { posix } from "node:path"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import { resourceOwnershipSchema } from "./protocol"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const sandboxToolRequestSchema = z
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
  .refine((request) => Buffer.byteLength(canonicalJson(request)) <= 1024 * 1024)

export const sandboxToolExecDescriptorSchema = z
  .object({
    schema: z.literal("lyrashield-sandbox-tool-exec/1"),
    request: sandboxToolRequestSchema,
    workspaceRoot: z.string().min(1).max(4096),
    ownership: resourceOwnershipSchema,
  })
  .strict()
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
