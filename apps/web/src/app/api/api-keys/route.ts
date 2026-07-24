import { createApiKey, listApiKeys, prisma, API_KEY_SCOPES } from "@lyrashield/db"
import { requireWorkspaceAccess } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { z } from "zod"

/**
 * Workspace API keys (for the MCP server, CLI, and CI).
 *
 * Management requires an ADMIN+ browser session — API keys cannot mint or
 * list other API keys (no self-propagation), which is why both handlers
 * reject key-authenticated callers explicitly.
 */

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session } = await requireWorkspaceAccess(workspaceId, "ADMIN")
    if (session.apiKey) {
      return apiError("FORBIDDEN", "API keys cannot manage API keys", 403)
    }

    const keys = await listApiKeys(workspaceId)
    return apiSuccess(keys)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list API keys", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list API keys", 500)
  }
}

const CreateApiKeySchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresAt: z.iso.datetime().optional(),
})

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = CreateApiKeySchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, name, scopes, expiresAt } = parsed.data

    const { session } = await requireWorkspaceAccess(workspaceId, "ADMIN")
    if (session.apiKey) {
      return apiError("FORBIDDEN", "API keys cannot manage API keys", 403)
    }

    const created = await createApiKey({
      workspaceId,
      name,
      scopes,
      createdById: session.userId,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "api_key.created",
        resourceType: "api_key",
        resourceId: created.apiKey.id,
        metadata: { prefix: created.apiKey.prefix, scopes: created.apiKey.scopes },
      },
    })

    // rawKey is returned exactly once, at creation. It is never retrievable
    // again — the UI must tell the user to store it now.
    return apiSuccess({ ...created.apiKey, rawKey: created.rawKey }, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "KEY_LIMIT_REACHED") {
      return apiError("KEY_LIMIT_REACHED", "This workspace already has 20 active API keys", 400)
    }
    if (error instanceof Error && error.message === "INVALID_EXPIRY") {
      return apiError("VALIDATION_ERROR", "Expiry must be in the future", 400)
    }
    logger.error("Failed to create API key", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create API key", 500)
  }
}
