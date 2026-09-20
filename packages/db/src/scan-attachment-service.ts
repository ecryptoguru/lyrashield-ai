import type { ScanAttachment } from "./generated/prisma"
import { withWorkspaceRLS } from "./rls"
import {
  SCAN_ATTACHMENT_MAX_BYTES,
  SCAN_ATTACHMENT_MAX_COUNT,
  SCAN_ATTACHMENT_MAX_TOTAL_BYTES,
  SCAN_ATTACHMENT_WORKSPACE_LIMIT,
  validateScanAttachmentUpload,
} from "@lyrashield/types"

/**
 * Workspace-scoped scan attachments — supporting files uploaded ahead of a
 * scan and recorded in the immutable execution plan. Everything here is
 * scoped by `workspaceId` under RLS; a row from another workspace is
 * indistinguishable from a missing one.
 */

export type ScanAttachmentErrorCode =
  | "SCAN_ATTACHMENT_NOT_FOUND"
  | "SCAN_ATTACHMENT_UNAVAILABLE"
  | "SCAN_ATTACHMENT_LIMIT_EXCEEDED"
  | "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED"
  | "SCAN_ATTACHMENT_CHECKSUM_INVALID"
  | "SCAN_ATTACHMENT_NAME_INVALID"
  | "SCAN_ATTACHMENT_SIZE_EXCEEDED"
  | "SCAN_ATTACHMENT_EMPTY"

export class ScanAttachmentError extends Error {
  constructor(
    readonly code: ScanAttachmentErrorCode,
    message: string
  ) {
    super(message)
    this.name = "ScanAttachmentError"
  }
}

/** Public projection — the private storage URI and key ref never leave the
 * service layer; callers get only display/validation fields. */
export interface ScanAttachmentSummary {
  id: string
  filename: string
  mediaType: string
  byteLength: number
  checksum: string
  createdAt: Date
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function toSummary(row: ScanAttachment): ScanAttachmentSummary {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
    checksum: row.checksum,
    createdAt: row.createdAt,
  }
}

export interface CreateScanAttachmentRecordInput {
  workspaceId: string
  filename: string
  mediaType: string
  byteLength: number
  checksum: string
  storageUri: string
  encryptionKeyRef: string
  createdById: string
}

/**
 * Persist the metadata record for an already-uploaded encrypted artifact.
 * Validates filename/mediaType/size again at the boundary — the route's
 * checks are never the only gate.
 */
export async function createScanAttachmentRecord(
  input: CreateScanAttachmentRecordInput
): Promise<ScanAttachmentSummary> {
  const validation = validateScanAttachmentUpload(input.filename, input.mediaType, input.byteLength)
  if (!validation.ok) {
    throw new ScanAttachmentError(
      validation.code as ScanAttachmentErrorCode,
      "Attachment failed upload validation"
    )
  }
  if (!SHA256_HEX.test(input.checksum)) {
    throw new ScanAttachmentError(
      "SCAN_ATTACHMENT_CHECKSUM_INVALID",
      "Attachment checksum must be a lowercase sha256 hex digest"
    )
  }

  return withWorkspaceRLS(input.workspaceId, async (tx) => {
    const activeCount = await tx.scanAttachment.count({
      where: { workspaceId: input.workspaceId, status: "ACTIVE", deletedAt: null },
    })
    if (activeCount >= SCAN_ATTACHMENT_WORKSPACE_LIMIT) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_LIMIT_EXCEEDED",
        `Workspace already has ${activeCount} stored attachments`
      )
    }
    const row = await tx.scanAttachment.create({
      data: {
        workspaceId: input.workspaceId,
        filename: input.filename,
        mediaType: input.mediaType,
        byteLength: input.byteLength,
        checksum: input.checksum,
        storageUri: input.storageUri,
        encryptionKeyRef: input.encryptionKeyRef,
        status: "ACTIVE",
        createdById: input.createdById,
      },
    })
    return toSummary(row)
  })
}

/** List the workspace's attachable (active, not deleted) attachments. */
export async function listScanAttachments(
  workspaceId: string,
  limit = 100
): Promise<ScanAttachmentSummary[]> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const rows = await tx.scanAttachment.findMany({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    })
    return rows.map(toSummary)
  })
}

/**
 * Resolve attachment IDs for scan admission. Every id must name an ACTIVE,
 * non-deleted row owned by this workspace with a well-formed checksum and an
 * allowed media type, and the set must stay within the count/aggregate limits.
 * Unknown and cross-workspace ids share the NOT_FOUND code — the existence of
 * another workspace's attachment is not disclosed.
 */
export async function resolveScanAttachments(
  workspaceId: string,
  attachmentIds: string[]
): Promise<ScanAttachment[]> {
  const uniqueIds = [...new Set(attachmentIds)]
  if (uniqueIds.length > SCAN_ATTACHMENT_MAX_COUNT) {
    throw new ScanAttachmentError(
      "SCAN_ATTACHMENT_LIMIT_EXCEEDED",
      `A scan accepts at most ${SCAN_ATTACHMENT_MAX_COUNT} attachments`
    )
  }
  if (uniqueIds.length === 0) return []

  const rows = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.scanAttachment.findMany({
      where: { id: { in: uniqueIds }, workspaceId },
    })
  )

  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_NOT_FOUND",
        "Attachment not found in this workspace"
      )
    }
    if (row.status !== "ACTIVE" || row.deletedAt !== null) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_UNAVAILABLE",
        "Attachment was deleted and cannot be attached to a new scan"
      )
    }
    if (!SHA256_HEX.test(row.checksum)) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_CHECKSUM_INVALID",
        "Stored attachment checksum is malformed"
      )
    }
    if (row.byteLength <= 0 || row.byteLength > SCAN_ATTACHMENT_MAX_BYTES) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_SIZE_EXCEEDED",
        "Stored attachment exceeds the per-file limit"
      )
    }
    const typeCheck = validateScanAttachmentUpload(row.filename, row.mediaType, row.byteLength)
    if (!typeCheck.ok) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
        "Stored attachment type is not allowed for scans"
      )
    }
  }

  const totalBytes = uniqueIds.reduce((sum, id) => sum + (byId.get(id)?.byteLength ?? 0), 0)
  if (totalBytes > SCAN_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new ScanAttachmentError(
      "SCAN_ATTACHMENT_LIMIT_EXCEEDED",
      `Attachments total ${totalBytes} bytes, over the ${SCAN_ATTACHMENT_MAX_TOTAL_BYTES}-byte scan limit`
    )
  }

  return uniqueIds.map((id) => byId.get(id)!)
}

/**
 * Soft-delete an attachment. Returns the row's storage URI so the caller can
 * remove the encrypted object through the artifact deletion path. Already
 * deleted rows return null — idempotent.
 */
export async function softDeleteScanAttachment(
  workspaceId: string,
  attachmentId: string
): Promise<{ storageUri: string } | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const result = await tx.scanAttachment.updateMany({
      where: { id: attachmentId, workspaceId, deletedAt: null },
      data: { status: "DELETED", deletedAt: new Date() },
    })
    if (result.count !== 1) return null
    const row = await tx.scanAttachment.findUnique({
      where: { id: attachmentId },
      select: { storageUri: true },
    })
    return row ? { storageUri: row.storageUri } : null
  })
}

/** The model's Prisma payload type re-exported for worker plumbing. */
export type { ScanAttachment }
