import { withCookieMutation } from "../../../../lib/api-auth"
import {
  createScanAttachmentRecord,
  listScanAttachments,
  prisma,
  ScanAttachmentError,
} from "@lyrashield/db"
import { deleteEncryptedArtifact, uploadEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import {
  SCAN_ATTACHMENT_MAX_BYTES,
  SCAN_ATTACHMENT_FILENAME_PATTERN,
  validateScanAttachmentUpload,
} from "@lyrashield/types"

/**
 * Workspace-scoped scan attachment upload. Attachments are immutable input
 * evidence for future scans — text, Markdown, JSON, YAML, and OpenAPI only.
 * They are referenced by ID (never by host path) in POST /api/scans and are
 * staged read-only by the worker under checksum verification.
 */

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function filenameFromRequest(request: Request): string {
  const value = request.headers.get("x-lyrashield-attachment-filename")
  if (!value) throw new ScanAttachmentError("SCAN_ATTACHMENT_NAME_INVALID", "Missing filename")
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ScanAttachmentError("SCAN_ATTACHMENT_NAME_INVALID", "Invalid filename encoding")
  }
}

async function readBodyWithinLimit(request: Request): Promise<Buffer> {
  const declaredLength = request.headers.get("content-length")
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > SCAN_ATTACHMENT_MAX_BYTES)
  ) {
    throw new ScanAttachmentError("SCAN_ATTACHMENT_SIZE_EXCEEDED", "Attachment too large")
  }
  if (!request.body) {
    throw new ScanAttachmentError("SCAN_ATTACHMENT_EMPTY", "Attachment body is required")
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > SCAN_ATTACHMENT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ScanAttachmentError("SCAN_ATTACHMENT_SIZE_EXCEEDED", "Attachment too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, byteLength)
}

function attachmentErrorResponse(error: unknown): Response | null {
  if (error instanceof ScanAttachmentError) {
    const status = error.code === "SCAN_ATTACHMENT_NOT_FOUND" ? 404 : 400
    return privateResponse(
      apiError(error.code, "Attachment failed validation: unsupported type, name, or size", status)
    )
  }
  return null
}

async function post(request: Request) {
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")
    if (!workspaceId) {
      return privateResponse(apiError("MISSING_PARAM", "workspaceId is required", 400))
    }

    // Authenticate before reading the potentially large upload stream.
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)

    const filename = filenameFromRequest(request)
    if (!SCAN_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
      throw new ScanAttachmentError("SCAN_ATTACHMENT_NAME_INVALID", "Invalid filename")
    }
    const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim()
    const content = await readBodyWithinLimit(request)
    const validation = validateScanAttachmentUpload(filename, mediaType, content.byteLength)
    if (!validation.ok) {
      throw new ScanAttachmentError(
        validation.code as ScanAttachmentError["code"],
        "Attachment failed upload validation"
      )
    }

    // Reject obvious active/executable content even when the declared type
    // passes — attachments are staged as inert bytes, and a polyglot file
    // must never reach the engine workspace under a text name.
    if (content.includes(0x00)) {
      throw new ScanAttachmentError(
        "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
        "Binary content is not an allowed attachment"
      )
    }

    let stored: Awaited<ReturnType<typeof uploadEncryptedArtifact>> | null = null
    try {
      stored = await uploadEncryptedArtifact({
        workspaceId,
        ownerId: session.userId,
        type: "scan-attachment",
        namespace: "scan-attachments",
        content,
        contentType: mediaType,
      })
      const record = await createScanAttachmentRecord({
        workspaceId,
        filename,
        mediaType,
        byteLength: stored.byteLength,
        checksum: stored.checksum,
        storageUri: stored.storageUri,
        encryptionKeyRef: stored.encryptionKeyRef,
        createdById: session.userId,
      })
      await prisma.auditLog
        .create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "scan.attachment_uploaded",
            resourceType: "scan_attachment",
            resourceId: record.id,
          },
        })
        .catch((auditErr) =>
          logger.warn("Failed to record attachment upload audit", {
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          })
        )
      return privateResponse(apiSuccess(record, 201))
    } catch (error) {
      if (stored) {
        await Promise.resolve(deleteEncryptedArtifact(stored.storageUri, workspaceId)).catch(() => {
          logger.error("Failed to compensate attachment upload")
        })
      }
      throw error
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return privateResponse(authErr)
    const attachmentErr = attachmentErrorResponse(error)
    if (attachmentErr) return attachmentErr
    logger.error("Failed to upload scan attachment", { error: String(error) })
    return privateResponse(apiError("INTERNAL_ERROR", "Failed to upload attachment", 500))
  }
}

export async function GET(request: Request) {
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")
    if (!workspaceId) {
      return privateResponse(apiError("MISSING_PARAM", "workspaceId is required", 400))
    }
    await requirePermission(workspaceId, PERMISSIONS.scan.view)
    const items = await listScanAttachments(workspaceId)
    return privateResponse(apiSuccess({ items }))
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return privateResponse(authErr)
    logger.error("Failed to list scan attachments", { error: String(error) })
    return privateResponse(apiError("INTERNAL_ERROR", "Failed to list attachments", 500))
  }
}

export const POST = withCookieMutation(post)
