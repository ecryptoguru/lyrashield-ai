import { z } from "zod"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  prisma,
  getWorkspaceNotificationChannels,
  withActiveWorkspaceNotificationDestination,
} from "@lyrashield/db"
import { sendWorkspaceNotification } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { withCookieMutation, authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { checkNotificationTestRateLimit } from "../../../../../lib/rate-limit"

export const dynamic = "force-dynamic"

const TestSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    channel: z.enum(["slack", "discord"]),
  })
  .strict()

async function post(request: Request) {
  try {
    const session = await getSession()
    if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)
    if (session.apiKey || session.oauth)
      return apiError("FORBIDDEN", "A browser session is required", 403)
    const parsed = TestSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success)
      return apiError("VALIDATION_ERROR", "Provide a workspace and notification channel", 400)
    const { workspaceId, channel } = parsed.data
    await requirePermission(workspaceId, PERMISSIONS.integration.manage)
    const rateLimit = await checkNotificationTestRateLimit({
      workspaceId,
      userId: session.userId,
      channel,
    })
    if (rateLimit.limited) {
      return apiError(
        rateLimit.unavailable ? "SERVICE_UNAVAILABLE" : "RATE_LIMITED",
        rateLimit.unavailable
          ? "Notification testing is temporarily unavailable. Please try again shortly."
          : "Too many test notifications. Please wait before trying again.",
        rateLimit.unavailable ? 503 : 429,
        { "Retry-After": String(Math.max(1, rateLimit.retryAfter)) }
      )
    }
    const integration = (await getWorkspaceNotificationChannels(workspaceId)).find(
      (item) => item.channel === channel
    )
    if (!integration)
      return apiError("NOT_FOUND", "Connect this notification integration before testing it", 404)
    // Record explicit user intent before making the outbound call. No supplied content is sent.
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.notification.test_requested",
        resourceType: "integration",
        metadata: { channel },
      },
    })
    try {
      const sent = await withActiveWorkspaceNotificationDestination(
        workspaceId,
        channel,
        (configRef) =>
          sendWorkspaceNotification(
            channel,
            {
              type: "integration.test",
              title: "LyraShield AI test notification",
              body: "Your notification integration is connected.",
            },
            { workspaceId, configRef }
          )
      )
      if (sent === null) {
        return apiError(
          "INTEGRATION_CHANGED",
          "This notification integration was disconnected. Reconnect it before testing.",
          409
        )
      }
      if (!sent) throw new Error("Notification test was not sent")
    } catch {
      return apiError(
        "DELIVERY_FAILED",
        "The provider could not accept the test. Check the webhook URL and try again.",
        502
      )
    }
    return apiSuccess({ channel, sent: true })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to test notification integration")
    return apiError("INTERNAL_ERROR", "Failed to test notification integration", 500)
  }
}

export const POST = withCookieMutation(post)
