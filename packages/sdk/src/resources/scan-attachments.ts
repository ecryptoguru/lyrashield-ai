import { z } from "zod"
import type { LyraShieldClient } from "../client"
import { LyraShieldError } from "../errors"

const MAX_BYTES = 1024 * 1024

export const ScanAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().positive().max(MAX_BYTES),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
})
export type ScanAttachment = z.infer<typeof ScanAttachmentSchema>

function path(workspaceId: string): string {
  return `/scans/attachments?${new URLSearchParams({ workspaceId })}`
}

function requiredWorkspaceId(client: LyraShieldClient, workspaceId?: string): string {
  const value = workspaceId ?? client.workspaceId
  if (!value)
    throw new LyraShieldError({
      status: 0,
      code: "WORKSPACE_REQUIRED",
      message: "workspaceId is required",
    })
  return value
}

export function listScanAttachments(
  client: LyraShieldClient,
  workspaceId?: string
): Promise<ScanAttachment[]> {
  return client.request("GET", path(requiredWorkspaceId(client, workspaceId)), {
    parse: (data) => z.object({ items: z.array(ScanAttachmentSchema) }).parse(data).items,
  })
}

export interface UploadScanAttachmentInput {
  workspaceId?: string
  filename: string
  mediaType: string
  content: Uint8Array
  idempotencyKey?: string
  signal?: AbortSignal
}

export function uploadScanAttachment(
  client: LyraShieldClient,
  input: UploadScanAttachmentInput
): Promise<ScanAttachment> {
  if (
    !(input.content instanceof Uint8Array) ||
    input.content.byteLength < 1 ||
    input.content.byteLength > MAX_BYTES
  ) {
    throw new LyraShieldError({
      status: 0,
      code: "SCAN_ATTACHMENT_SIZE_EXCEEDED",
      message: "Attachment must contain 1 byte to 1 MiB",
    })
  }
  return client.request("POST", path(requiredWorkspaceId(client, input.workspaceId)), {
    rawBody: input.content,
    signal: input.signal,
    headers: {
      "Content-Type": input.mediaType,
      "x-lyrashield-attachment-filename": encodeURIComponent(input.filename),
      "Idempotency-Key": input.idempotencyKey ?? crypto.randomUUID(),
    },
    parse: (data) => ScanAttachmentSchema.parse(data),
  })
}

export function deleteScanAttachment(
  client: LyraShieldClient,
  id: string,
  options: { workspaceId?: string; idempotencyKey?: string; signal?: AbortSignal } = {}
): Promise<{ id: string; deleted: true }> {
  const workspaceId = requiredWorkspaceId(client, options.workspaceId)
  return client.request(
    "DELETE",
    `/scans/attachments/${encodeURIComponent(id)}?${new URLSearchParams({ workspaceId })}`,
    {
      signal: options.signal,
      headers: { "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID() },
      parse: (data) => z.object({ id: z.string(), deleted: z.literal(true) }).parse(data),
    }
  )
}
