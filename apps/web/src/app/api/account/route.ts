import { getSession } from "@lyrashield/auth/server"
import { AccountDeletionBlockedError, deleteUserAccount } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { apiError, apiSuccess } from "../../../lib/api-response"

const DeleteAccountSchema = z.object({ confirmation: z.literal("DELETE") }).strict()

export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)

  const parsed = DeleteAccountSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return apiError("CONFIRMATION_REQUIRED", 'Type "DELETE" to confirm account deletion', 400)
  }

  try {
    await deleteUserAccount(session.userId)
    logger.info("User account deleted", { userId: session.userId })
    return apiSuccess({ deleted: true })
  } catch (error) {
    if (error instanceof AccountDeletionBlockedError) {
      return apiError(
        "OWNERSHIP_TRANSFER_REQUIRED",
        `Transfer ownership of: ${error.workspaces.map((workspace) => workspace.name).join(", ")}`,
        409
      )
    }
    logger.error("Failed to delete user account", {
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return apiError("INTERNAL_ERROR", "Failed to delete account", 500)
  }
}
