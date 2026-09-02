import { withCookieMutation } from "../../../lib/api-auth"
import {
  createLiveAiSafetyPlan,
  LiveAiSafetyError,
  prisma,
  upsertLiveAiSafetySettings,
} from "@lyrashield/db"
import { PERMISSIONS } from "@lyrashield/auth"
import { requirePermission } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { AiSafetyCaseSchema } from "@lyrashield/types"
import { z } from "zod"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"

const WorkspaceSchema = z.object({ workspaceId: z.string().min(1) })
const SettingsSchema = WorkspaceSchema.extend({ incidentContact: z.string().email().nullable() })
const PlanRequestSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  endpointUrl: z.string().min(1),
  approvedHost: z.string().min(1),
  authMode: z.enum(["NO_AUTH", "TEST_CREDENTIAL"]),
  credentialId: z.string().min(1).optional(),
  incidentContact: z.string().email(),
  maxRequests: z.number().int().min(1).max(25),
  maxDurationSeconds: z.number().int().min(1).max(900),
  maxResponseBytes: z.number().int().min(1).max(1_048_576),
  rawSampleStorage: z.enum(["DISABLED", "ENCRYPTED_PRIVATE"]),
  destructiveTestsAllowed: z.literal(false),
  cases: z.array(AiSafetyCaseSchema).min(1).max(5),
})

function privateResponse(data: unknown, status = 200) {
  const response = apiSuccess(data, status)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function privateError(code: string, message: string, status: number) {
  const response = apiError(code, message, status)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

export async function GET(request: Request) {
  try {
    const parsed = WorkspaceSchema.safeParse({
      workspaceId: new URL(request.url).searchParams.get("workspaceId"),
    })
    if (!parsed.success) return privateError("MISSING_PARAM", "workspaceId is required", 400)
    await requirePermission(parsed.data.workspaceId, PERMISSIONS.agent.view)
    const [settings, plans] = await Promise.all([
      prisma.liveAiSafetySettings.findUnique({
        where: { workspaceId: parsed.data.workspaceId },
        select: { incidentContact: true, updatedAt: true },
      }),
      prisma.liveAiSafetyPlan.findMany({
        where: { workspaceId: parsed.data.workspaceId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          targetId: true,
          endpointUrl: true,
          approvedHost: true,
          authMode: true,
          status: true,
          maxRequests: true,
          maxDurationSeconds: true,
          terminalReason: true,
          createdAt: true,
        },
      }),
    ])
    return privateResponse({ settings, plans })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to load live AI safety state", { error: String(error) })
    return privateError("INTERNAL_ERROR", "Failed to load live safety settings", 500)
  }
}

async function put(request: Request) {
  try {
    const parsed = SettingsSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return privateError("INVALID_PARAM", "A valid incident contact is required", 400)
    const { session } = await requirePermission(
      parsed.data.workspaceId,
      PERMISSIONS.aiAssurance.manage
    )
    return privateResponse(
      await upsertLiveAiSafetySettings({ ...parsed.data, createdById: session.userId })
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof LiveAiSafetyError)
      return privateError(error.code, "Invalid safety settings", 400)
    logger.error("Failed to update live AI safety settings", { error: String(error) })
    return privateError("INTERNAL_ERROR", "Failed to update live safety settings", 500)
  }
}

async function post(request: Request) {
  try {
    const parsed = PlanRequestSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return privateError("INVALID_PARAM", "Invalid live safety plan", 400)
    const { session } = await requirePermission(parsed.data.workspaceId, PERMISSIONS.agent.act)
    const plan = await createLiveAiSafetyPlan({
      ...parsed.data,
      createdById: session.userId,
    })
    return privateResponse({ id: plan.id, status: plan.status, createdAt: plan.createdAt }, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof LiveAiSafetyError) {
      return privateError(error.code, "This target is not ready for a safe live test", 409)
    }
    logger.error("Failed to create live AI safety plan", { error: String(error) })
    return privateError("INTERNAL_ERROR", "Failed to create live safety plan", 500)
  }
}

export const PUT = withCookieMutation(put)

export const POST = withCookieMutation(post)
