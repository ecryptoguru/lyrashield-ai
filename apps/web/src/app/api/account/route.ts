import { getSession } from "@lyrashield/auth/server"
import {
  AccountDeletionBlockedError,
  AccountDeletionConfirmationRequiredError,
  AccountDeletionActiveScanError,
  AccountDeletionUnsupportedArtifactError,
  deleteUserAccount,
} from "@lyrashield/db"
import { drainArtifactDeletionTasks } from "@lyrashield/evidence-storage"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { apiError, apiSuccess } from "../../../lib/api-response"

const DeleteAccountSchema = z.object({ confirmation: z.string().min(1) }).strict()

export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)

  const body = await request.json().catch(() => null)
  const parsed = DeleteAccountSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(
      "CONFIRMATION_REQUIRED",
      "Type the confirmation phrase to delete this account.",
      400
    )
  }

  try {
    const deletion = await deleteUserAccount(session.userId, parsed.data.confirmation)
    if (deletion.artifactDeletionTaskIds.length > 0) {
      try {
        const drain = await drainArtifactDeletionTasks({
          taskIds: deletion.artifactDeletionTaskIds,
          limit: deletion.artifactDeletionTaskIds.length,
        })
        if (drain.retrying > 0 || drain.deadLettered > 0) {
          logger.warn("Account deleted with durable artifact cleanup pending", {
            pending: drain.retrying + drain.deadLettered,
          })
        }
      } catch (error) {
        // Account deletion already committed with durable outbox rows. A failed
        // eager drain must not report that the account still exists; the worker
        // retries the same tasks through its DB-only sweep.
        logger.warn("Account deleted; eager artifact cleanup will be retried", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    logger.info("User account deleted", { userId: session.userId })
    return apiSuccess({ deleted: true })
  } catch (error) {
    if (error instanceof AccountDeletionConfirmationRequiredError) {
      return apiError(
        "CONFIRMATION_REQUIRED",
        `Type the following to confirm data destruction: ${error.expectedConfirmation}`,
        400,
        undefined,
        {
          deletableWorkspaces: error.deletableWorkspaces,
          expectedConfirmation: error.expectedConfirmation,
        }
      )
    }
    if (error instanceof AccountDeletionBlockedError) {
      return apiError(
        "OWNERSHIP_TRANSFER_REQUIRED",
        `Transfer ownership of: ${error.workspaces.map((workspace) => workspace.name).join(", ")}`,
        409,
        undefined,
        { blockedWorkspaces: error.workspaces }
      )
    }
    if (error instanceof AccountDeletionActiveScanError) {
      return apiError(
        "ACTIVE_SCANS",
        "Finish or cancel active scans before deleting this account.",
        409,
        undefined,
        { blockedWorkspaces: error.workspaces }
      )
    }
    if (error instanceof AccountDeletionUnsupportedArtifactError) {
      return apiError(
        "UNSUPPORTED_EXTERNAL_ARTIFACT",
        "Contact support to remove legacy external artifacts before deleting this account.",
        409,
        undefined,
        { blockedWorkspaces: error.workspaces }
      )
    }
    logger.error("Failed to delete user account", {
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return apiError("INTERNAL_ERROR", "Failed to delete account", 500)
  }
}
