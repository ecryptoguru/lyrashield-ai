import { z } from "zod"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  prisma,
  listNotificationIntegrations,
  saveNotificationIntegration,
  disableNotificationIntegration,
} from "@lyrashield/db"
import { uploadEncryptedArtifact, deleteEncryptedArtifact } from "@lyrashield/evidence-storage"
import { validateNotificationWebhookUrl } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { withCookieMutation, authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export const dynamic = "force-dynamic"

const ChannelSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    channel: z.enum(["slack", "discord"]),
  })
  .strict()
const SaveSchema = ChannelSchema.extend({
  webhookUrl: z.string().min(1).max(2048),
  name: z.string().trim().min(1).max(100).optional(),
}).strict()

async function cleanup(storageUri: string, workspaceId: string) {
  await deleteEncryptedArtifact(storageUri, workspaceId).catch(() => {
    // Never log artifact references, webhook secrets, or underlying storage errors.
    logger.warn("Notification credential cleanup failed", { workspaceId })
  })
}

export async function GET(request: Request) {
  try {
    const workspaceId = z
      .string()
      .min(1)
      .max(128)
      .safeParse(new URL(request.url).searchParams.get("workspaceId"))
    if (!workspaceId.success) return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
    await requirePermission(workspaceId.data, PERMISSIONS.notification.view)
    return apiSuccess(await listNotificationIntegrations(workspaceId.data))
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list notification integrations")
    return apiError("INTERNAL_ERROR", "Failed to load notification integrations", 500)
  }
}

async function post(request: Request) {
  let orphan: { storageUri: string; workspaceId: string } | undefined
  try {
    const session = await getSession()
    if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)
    if (session.apiKey || session.oauth)
      return apiError("FORBIDDEN", "A browser session is required", 403)
    const parsed = SaveSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success)
      return apiError(
        "VALIDATION_ERROR",
        "Provide a workspace, channel, and valid webhook URL",
        400
      )
    const { workspaceId, channel, webhookUrl, name } = parsed.data
    await requirePermission(workspaceId, PERMISSIONS.integration.manage)
    if (!validateNotificationWebhookUrl(channel, webhookUrl)) {
      return apiError(
        "VALIDATION_ERROR",
        "Use a valid HTTPS incoming webhook URL from this provider",
        400
      )
    }
    const sealed = await uploadEncryptedArtifact({
      workspaceId,
      ownerId: "integrations",
      namespace: "notification-integrations",
      type: `${channel}-webhook`,
      content: JSON.stringify({ webhookUrl }),
    })
    orphan = { storageUri: sealed.storageUri, workspaceId }
    const saved = await saveNotificationIntegration({
      workspaceId,
      channel,
      configRef: sealed.storageUri,
      ...(name ? { name } : {}),
    })
    // The new reference is durable now, including if the separate audit write fails.
    orphan = undefined
    if (saved.previousConfigRef && saved.previousConfigRef !== sealed.storageUri) {
      await cleanup(saved.previousConfigRef, workspaceId)
    }
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.notification.connected",
        resourceType: "integration",
        resourceId: saved.integration.id,
        metadata: { channel },
      },
    })
    return apiSuccess(saved.integration)
  } catch (error) {
    if (orphan) await cleanup(orphan.storageUri, orphan.workspaceId)
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to save notification integration")
    return apiError("INTERNAL_ERROR", "Failed to save notification integration", 500)
  }
}

async function remove(request: Request) {
  try {
    const session = await getSession()
    if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)
    if (session.apiKey || session.oauth)
      return apiError("FORBIDDEN", "A browser session is required", 403)
    const parsed = ChannelSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success)
      return apiError("VALIDATION_ERROR", "Provide a workspace and notification channel", 400)
    const { workspaceId, channel } = parsed.data
    await requirePermission(workspaceId, PERMISSIONS.integration.manage)
    const disabled = await disableNotificationIntegration(workspaceId, channel)
    if (!disabled) return apiError("NOT_FOUND", "Notification integration not found", 404)
    // The shared delivery lock has drained old sends and the reference is cleared at commit.
    if (disabled.previousConfigRef) await cleanup(disabled.previousConfigRef, workspaceId)
    const integration = disabled.integration
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.notification.disabled",
        resourceType: "integration",
        resourceId: integration.id,
        metadata: { channel },
      },
    })
    return apiSuccess(integration)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to disable notification integration")
    return apiError("INTERNAL_ERROR", "Failed to disable notification integration", 500)
  }
}

export const POST = withCookieMutation(post)
export const DELETE = withCookieMutation(remove)
