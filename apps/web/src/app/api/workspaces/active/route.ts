import { withCookieMutation } from "../../../../lib/api-auth"
import { cookies, headers } from "next/headers"
import { auth, requireWorkspaceAccess } from "@lyrashield/auth/server"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { isProd } from "@lyrashield/config"
import { z } from "zod"

const ActiveWorkspaceSchema = z.object({ workspaceId: z.string().min(1) })

async function post(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = ActiveWorkspaceSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("INVALID_PARAM", "workspaceId is required", 400)
  }

  try {
    const { session } = await requireWorkspaceAccess(parsed.data.workspaceId)
    if (session.apiKey && !session.apiKey.scopes.includes("write")) {
      return apiError("FORBIDDEN", "You do not have permission to perform this action", 403)
    }
    const cookieStore = await cookies()
    if (!session.apiKey && !session.oauth) {
      await auth.api.updateSession({
        headers: await headers(),
        body: { activeWorkspaceId: parsed.data.workspaceId },
      })
    }
    cookieStore.set("activeWorkspaceId", parsed.data.workspaceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      path: "/",
    })
    return apiSuccess({ workspaceId: parsed.data.workspaceId })
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return apiError("UNAUTHORIZED", "Authentication required", 401)
    }
    return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
  }
}

export const POST = withCookieMutation(post)
