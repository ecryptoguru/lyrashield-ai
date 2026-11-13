import { posix } from "node:path"
import { z } from "zod"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/)
  .refine((value) => /^[a-z0-9]/.test(value) && /[a-z0-9]$/.test(value))
  .refine((value) => !value.includes(".."))
const readonly = { readOnly: z.literal(true) }
export const protectedSourceResourceSchema = z
  .object({
    grantId: id,
    root: z.literal("/workspace/source"),
    revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    stagedTreeDigest: hash,
    ...readonly,
  })
  .strict()
export const protectedAttachmentResourceSchema = z
  .object({
    id: id,
    checksum: hash,
    byteLength: z.number().int().nonnegative().safe(),
    contentType: z.string().min(1).max(192),
    filename: z.string().min(1).max(512),
    containerPath: z.string().min(1).max(4096),
  })
  .strict()
  .refine(
    (entry) =>
      entry.containerPath.startsWith(`/input/attachments/${entry.id}-`) &&
      entry.containerPath === posix.normalize(entry.containerPath) &&
      !entry.containerPath.includes("..") &&
      !entry.containerPath.includes("\0")
  )
export const protectedAttachmentsResourceSchema = z
  .object({
    grantId: id,
    root: z.literal("/input/attachments"),
    manifestChecksum: hash,
    entries: z.array(protectedAttachmentResourceSchema).max(20),
    ...readonly,
  })
  .strict()
  .refine((value) => new Set(value.entries.map((entry) => entry.id)).size === value.entries.length)
export const protectedRelayResourceSchema = z
  .object({
    grantId: id,
    mountRoot: z.literal("/run/lyrashield-relay/upstream"),
    grantChecksum: hash,
    policyChecksum: hash,
    authorizedHosts: z.array(host).min(1).max(32),
    ...readonly,
  })
  .strict()
export const protectedEgressResourceSchema = z
  .object({
    grantId: id,
    policyPath: z.literal("/run/lyrashield-egress/policy.json"),
    policyChecksum: hash,
    authorizedHosts: z.array(host).max(32),
    relayRequired: z.boolean(),
    ...readonly,
  })
  .strict()
export const executorResourceDescriptorSchema = z
  .object({
    schema: z.literal("lyrashield-executor-resources/1"),
    hostPolicyChecksum: hash,
    imageDigest: image,
    uid: z.literal(1000),
    gid: z.literal(1000),
    workspaceRoot: z.literal("/workspace"),
    workdir: z.literal("/workspace"),
    source: protectedSourceResourceSchema.nullable(),
    attachments: protectedAttachmentsResourceSchema.nullable(),
    relay: protectedRelayResourceSchema.nullable(),
    egress: protectedEgressResourceSchema,
    scratchRoot: z.literal("/workspace/.attachments-scratch"),
    isolation: z
      .object({
        networkPolicyChecksum: hash,
        seccompPolicyChecksum: hash,
        appArmorProfile: z
          .string()
          .min(1)
          .max(192)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
        dropCapabilities: z.literal("ALL"),
        noNewPrivileges: z.literal(true),
        readOnlyRoot: z.literal(true),
        shmMb: z.literal(512),
      })
      .strict(),
    stagingRecordChecksum: hash,
    issuerKeyHash: hash,
  })
  .strict()
  .refine((value) => value.egress.relayRequired === (value.relay !== null))
export type ExecutorResourceDescriptor = z.infer<typeof executorResourceDescriptorSchema>
