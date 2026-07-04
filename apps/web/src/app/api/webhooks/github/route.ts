import { NextResponse, type NextRequest } from "next/server"
import { prisma } from "@lyrashield/db"
import { verifyWebhookSignature } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

export async function POST(request: NextRequest) {
  const payload = await request.text()
  const signature = request.headers.get("x-hub-signature-256")
  const eventType = request.headers.get("x-github-event")
  const deliveryId = request.headers.get("x-github-delivery")

  if (!verifyWebhookSignature(payload, signature)) {
    return NextResponse.json(
      { success: false, error: { code: "INVALID_SIGNATURE", message: "Webhook signature verification failed" } },
      { status: 401 }
    )
  }

  if (!eventType || !deliveryId) {
    return NextResponse.json(
      { success: false, error: { code: "MISSING_HEADERS", message: "x-github-event and x-github-delivery are required" } },
      { status: 400 }
    )
  }

  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "INVALID_JSON", message: "Payload is not valid JSON" } },
      { status: 400 }
    )
  }

  const event = body as Record<string, unknown>

  try {
    if (eventType === "installation") {
      const action = event.action as string
      const installation = event.installation as { id: number; account: { login: string } }

      if (action === "deleted") {
        const integration = await prisma.integration.findFirst({
          where: { type: "GITHUB", externalId: String(installation.id) },
        })

        if (integration) {
          await prisma.integration.update({
            where: { id: integration.id },
            data: { status: "disconnected", deletedAt: new Date() },
          })

          await prisma.target.updateMany({
            where: {
              workspaceId: integration.workspaceId,
              repoProvider: "github",
              repoFullName: { contains: installation.account.login },
            },
            data: { deletedAt: new Date() },
          })

          await prisma.auditLog.create({
            data: {
              workspaceId: integration.workspaceId,
              action: "integration.github.disconnected",
              resourceType: "integration",
              resourceId: integration.id,
              metadata: { installationId: installation.id, reason: "installation.deleted" },
            },
          })

          logger.info("GitHub installation deleted, targets disabled", { installationId: installation.id })
        }
      }
    } else if (eventType === "pull_request") {
      const action = event.action as string
      const pullRequest = event.pull_request as { number: number; head: { ref: string }; base: { ref: string } }
      const repository = event.repository as { full_name: string; id: number }
      const installation = event.installation as { id: number }

      const integration = await prisma.integration.findFirst({
        where: { type: "GITHUB", externalId: String(installation.id) },
      })

      if (integration) {
        await prisma.webhookEvent.create({
          data: {
            workspaceId: integration.workspaceId,
            provider: "github",
            eventType: `pull_request.${action}`,
            externalId: `${deliveryId}`,
            payload: {
              action,
              repoFullName: repository.full_name,
              repoId: repository.id,
              prNumber: pullRequest.number,
              headRef: pullRequest.head.ref,
              baseRef: pullRequest.base.ref,
              installationId: installation.id,
            },
          },
        })

        logger.info("Pull request webhook stored", {
          deliveryId,
          repo: repository.full_name,
          prNumber: pullRequest.number,
          action,
        })
      }
    } else {
      logger.debug("Unhandled GitHub webhook event type", { eventType, deliveryId })
    }

    return NextResponse.json({ success: true, data: { processed: true } })
  } catch (error) {
    logger.error("Failed to process GitHub webhook", { error: String(error), eventType, deliveryId })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to process webhook" } },
      { status: 500 }
    )
  }
}
