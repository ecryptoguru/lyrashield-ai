import { getSession } from "@lyrashield/auth/server"
import { apiError } from "../../../lib/api-response"

/**
 * Automated deletion is fail-closed until legal retention periods and the
 * billing/audit anonymization contract are approved. The dashboard routes
 * deletion requests through support so they can be reviewed safely.
 */
export async function DELETE() {
  const session = await getSession()
  if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)

  return apiError(
    "ACCOUNT_DELETION_REVIEW_REQUIRED",
    "Email support@lyrashieldai.com from your account address to request deletion.",
    409
  )
}
