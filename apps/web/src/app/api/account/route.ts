import { getSession } from "@lyrashield/auth/server"
import {
  AccountDeletionBlockedError,
  AccountDeletionConfirmationRequiredError,
  deleteUserAccount,
} from "@lyrashield/db"
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
    await deleteUserAccount(session.userId, parsed.data.confirmation)
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
    logger.error("Failed to delete user account", {
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return apiError("INTERNAL_ERROR", "Failed to delete account", 500)
  }
}
