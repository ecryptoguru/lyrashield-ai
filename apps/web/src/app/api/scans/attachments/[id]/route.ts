import { withCookieMutation } from "../../../../../lib/api-auth"
import { softDeleteScanAttachment } from "@lyrashield/db"
import { deleteEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { recordedOperation } from "@/lib/recorded-operation"

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

/**
 * Delete a workspace scan attachment. The row is soft-deleted first so it can
 * never be attached to a new scan; the same transaction enqueues a durable
 * deletion task, so the stored encrypted object is removed best-effort here
 * and retried by the artifact deletion outbox if that attempt fails.
 */
async function del(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")
    if (!workspaceId) {
      return privateResponse(apiError("MISSING_PARAM", "workspaceId is required", 400))
    }
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scanAttachment.delete)

    return privateResponse(
      await recordedOperation(
        request,
        {
          workspaceId,
          operationName: "scan.attachment.delete",
          input: { id },
          session,
        },
        async ({ confirmNotSubmitted }) => {
          const removed = await softDeleteScanAttachment(workspaceId, id)
          if (!removed) {
            confirmNotSubmitted()
            return apiError(
              "SCAN_ATTACHMENT_NOT_FOUND",
              "Attachment not found in this workspace",
              404
            )
          }
          try {
            await deleteEncryptedArtifact(removed.storageUri, workspaceId)
          } catch (storageErr) {
            // The row and durable deletion task already committed together.
            logger.error("Attachment object removal deferred after row deletion", {
              attachmentId: id,
              error: storageErr instanceof Error ? storageErr.message : String(storageErr),
            })
          }
          return apiSuccess({ id, deleted: true })
        }
      )
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return privateResponse(authErr)
    logger.error("Failed to delete scan attachment", { error: String(error) })
    return privateResponse(apiError("INTERNAL_ERROR", "Failed to delete attachment", 500))
  }
}

export const DELETE = withCookieMutation(del)
