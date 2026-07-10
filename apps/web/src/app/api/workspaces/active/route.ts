import { cookies } from "next/headers"
import { requireWorkspaceAccess } from "@lyrashield/auth/server"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

const ActiveWorkspaceSchema = z.object({ workspaceId: z.string().min(1) })

export async function POST(request: Request) {
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
    await requireWorkspaceAccess(parsed.data.workspaceId)
    const cookieStore = await cookies()
    cookieStore.set("activeWorkspaceId", parsed.data.workspaceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
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
