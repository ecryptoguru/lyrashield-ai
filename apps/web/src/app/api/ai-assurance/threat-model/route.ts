import { getThreatModel, saveThreatModel, threatModelMarkdown } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { z } from "zod"

const Scalar = z.string().trim().min(1).max(4_000)
const OptionalScalar = z.string().trim().min(1).max(4_000).nullable()
const ThreatSchema = z.object({
  title: Scalar,
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  description: Scalar,
  mitigation: OptionalScalar,
  testPlan: OptionalScalar,
  owner: OptionalScalar,
  reviewDate: z.string().date().nullable(),
})
const ThreatModelSchema = z
  .object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1),
    scope: Scalar,
    assets: z.array(Scalar).max(50),
    trustBoundaries: z.array(Scalar).max(50),
    threats: z.array(ThreatSchema).max(50),
  })
  .superRefine((value, context) => {
    value.threats.forEach((threat, index) => {
      if (["HIGH", "CRITICAL"].includes(threat.severity)) {
        for (const field of ["mitigation", "testPlan", "owner"] as const) {
          if (!threat[field]) {
            context.addIssue({
              code: "custom",
              path: ["threats", index, field],
              message: `${field} is required for high-impact threats`,
            })
          }
        }
      }
    })
  })

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get("workspaceId")
    const targetId = url.searchParams.get("targetId")
    if (!workspaceId || !targetId)
      return apiError("MISSING_PARAM", "workspaceId and targetId are required", 400)
    await requirePermission(workspaceId, PERMISSIONS.aiAssurance.view)
    const model = await getThreatModel(workspaceId, targetId)
    const content = model?.currentVersion?.content
    const format = url.searchParams.get("format")
    if (format === "markdown" && content) {
      return new Response(
        threatModelMarkdown(content as Parameters<typeof threatModelMarkdown>[0]),
        {
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="threat-model-${targetId}.md"`,
          },
        }
      )
    }
    const response = apiSuccess(
      model?.currentVersion
        ? {
            content: model.currentVersion.content,
            version: model.currentVersion,
            customerDeclared: true,
          }
        : null
    )
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get threat model", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get threat model", 500)
  }
}

export async function POST(request: Request) {
  try {
    const parsed = ThreatModelSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid threat model",
        400
      )
    const { workspaceId, targetId, ...content } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.manage)
    const version = await saveThreatModel({
      workspaceId,
      targetId,
      createdById: session.userId,
      content,
    })
    const response = apiSuccess({ content, version, customerDeclared: true }, 201)
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (
      error instanceof Error &&
      (error.message === "TARGET_NOT_FOUND" || error.message.startsWith("THREAT_MODEL_"))
    ) {
      return apiError(
        error.message,
        "Threat model data is incomplete or the target is unavailable",
        400
      )
    }
    logger.error("Failed to save threat model", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to save threat model", 500)
  }
}
