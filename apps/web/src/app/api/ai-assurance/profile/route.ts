import { getAiSystemProfile, upsertAiSystemProfile } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { z } from "zod"

const Scalar = z.string().trim().min(1).max(4_000)
const OptionalScalar = z.string().trim().min(1).max(4_000).nullable()
const ProfileSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  systemName: Scalar,
  systemPurpose: Scalar,
  modelProviders: z
    .array(z.object({ provider: Scalar, model: Scalar, deployment: OptionalScalar }))
    .min(1)
    .max(50),
  dataClasses: z.array(Scalar).min(1).max(50),
  dataSources: z.array(Scalar).max(50),
  storageSystems: z.array(Scalar).min(1).max(50),
  toolIntegrations: z.array(Scalar).max(50),
  retentionSummary: OptionalScalar,
  humanOversightSummary: Scalar,
})

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get("workspaceId")
    const targetId = url.searchParams.get("targetId")
    if (!workspaceId || !targetId)
      return apiError("MISSING_PARAM", "workspaceId and targetId are required", 400)
    await requirePermission(workspaceId, PERMISSIONS.aiAssurance.view)
    const profile = await getAiSystemProfile(workspaceId, targetId)
    const response = apiSuccess(
      profile
        ? { profile: profile.profile, version: profile.currentVersion, customerDeclared: true }
        : null
    )
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get AI system profile", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get AI system profile", 500)
  }
}

export async function POST(request: Request) {
  try {
    const parsed = ProfileSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid profile", 400)
    const { workspaceId, targetId, ...profile } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.manage)
    const result = await upsertAiSystemProfile({
      workspaceId,
      targetId,
      createdById: session.userId,
      profile,
    })
    const response = apiSuccess(
      {
        profile: result.profile.profile,
        version: result.version,
        inventorySummary: result.inventorySummary,
        customerDeclared: true,
      },
      201
    )
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (
      error instanceof Error &&
      (error.message === "TARGET_NOT_FOUND" || error.message.startsWith("AI_SYSTEM_PROFILE_"))
    ) {
      return apiError(error.message, "Profile data is incomplete or the target is unavailable", 400)
    }
    logger.error("Failed to save AI system profile", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to save AI system profile", 500)
  }
}
