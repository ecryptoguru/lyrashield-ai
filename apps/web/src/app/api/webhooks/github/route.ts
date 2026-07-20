import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { verifyWebhookSignature } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

const GitHubInstallationDeletedEventSchema = z.object({
  action: z.literal("deleted"),
  installation: z.object({
    id: z.number().int().positive(),
    account: z.object({ login: z.string().min(1).max(255) }),
  }),
})

const GitHubPullRequestEventSchema = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    full_name: z.string().min(1).max(255),
    id: z.number().int().positive(),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ ref: z.string().min(1).max(255) }),
    base: z.object({ ref: z.string().min(1).max(255) }),
  }),
})

function invalidPayloadResponse() {
  return NextResponse.json(
    { success: false, error: { code: "INVALID_PAYLOAD", message: "Webhook payload is invalid" } },
    { status: 400 }
  )
}

export async function POST(request: NextRequest) {
  const payload = await request.text()
  const signature = request.headers.get("x-hub-signature-256")
  const eventType = request.headers.get("x-github-event")
  const deliveryId = request.headers.get("x-github-delivery")

  if (!verifyWebhookSignature(payload, signature)) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "INVALID_SIGNATURE", message: "Webhook signature verification failed" },
      },
      { status: 401 }
    )
  }

  if (!eventType || !deliveryId) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "MISSING_HEADERS",
          message: "x-github-event and x-github-delivery are required",
        },
      },
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

  const event =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null

  // Idempotency: GitHub retries any delivery that doesn't return 2xx (and can
  // redeliver on its own). The X-GitHub-Delivery id is unique per delivery, and
  // WebhookEvent has @@unique([provider, externalId]) built for exactly this.
  // If we've already recorded this delivery, treat it as a processed no-op so
  // retries don't 500-loop or duplicate side effects.
  const alreadyProcessed = await prisma.webhookEvent.findUnique({
    where: { provider_externalId: { provider: "github", externalId: String(deliveryId) } },
  })
  if (alreadyProcessed) {
    logger.info("Duplicate GitHub webhook delivery ignored", { deliveryId, eventType })
    return NextResponse.json({ success: true, data: { processed: true, duplicate: true } })
  }

  try {
    if (eventType === "installation") {
      if (!event) return invalidPayloadResponse()
      const action = event.action as string

      if (action === "deleted") {
        const parsedEvent = GitHubInstallationDeletedEventSchema.safeParse(body)
        if (!parsedEvent.success) return invalidPayloadResponse()
        const { installation } = parsedEvent.data
        const integration = await prisma.integration.findFirst({
          where: { type: "GITHUB", externalId: String(installation.id) },
        })

        if (integration) {
          try {
            await prisma.$transaction(async (tx) => {
              // Persist the unique delivery before side effects so retries cannot
              // duplicate the disconnect audit event or target mutation.
              await tx.webhookEvent.create({
                data: {
                  workspaceId: integration.workspaceId,
                  provider: "github",
                  eventType: "installation.deleted",
                  externalId: deliveryId,
                  payload: {
                    installationId: installation.id,
                    accountLogin: installation.account.login,
                  },
                },
              })

              await tx.integration.update({
                where: { id: integration.id },
                data: { status: "disconnected", deletedAt: new Date() },
              })

              // Match repos owned by this account exactly, by "owner/" prefix.
              // A `contains` substring match previously disabled unrelated targets
              // (login "acme" also matched "not-acme/repo" or "acme-corp/other").
              // NOTE follow-up: once Target stores the numeric installationId, match
              // on that instead of the login prefix for full precision.
              await tx.target.updateMany({
                where: {
                  workspaceId: integration.workspaceId,
                  repoProvider: "github",
                  repoFullName: { startsWith: `${installation.account.login}/` },
                },
                data: { deletedAt: new Date() },
              })

              await tx.auditLog.create({
                data: {
                  workspaceId: integration.workspaceId,
                  action: "integration.github.disconnected",
                  resourceType: "integration",
                  resourceId: integration.id,
                  metadata: { installationId: installation.id, reason: "installation.deleted" },
                },
              })
            })
          } catch (err) {
            if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
              logger.info("Concurrent duplicate GitHub delivery ignored", { deliveryId })
              return NextResponse.json({
                success: true,
                data: { processed: true, duplicate: true },
              })
            }
            throw err
          }

          logger.info("GitHub installation deleted, targets disabled", {
            installationId: installation.id,
          })
        }
      }
    } else if (eventType === "pull_request") {
      const parsedEvent = GitHubPullRequestEventSchema.safeParse(body)
      if (!parsedEvent.success) return invalidPayloadResponse()
      const { action, pull_request: pullRequest, repository, installation } = parsedEvent.data

      const integration = await prisma.integration.findFirst({
        where: { type: "GITHUB", externalId: String(installation.id) },
      })

      if (integration) {
        try {
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
        } catch (err) {
          // Handle the race where two concurrent redeliveries both pass the
          // pre-check above: the unique (provider, externalId) constraint
          // rejects the second insert (P2002). Treat as an idempotent no-op.
          if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
            logger.info("Concurrent duplicate GitHub delivery ignored", { deliveryId })
          } else {
            throw err
          }
        }
      }
    } else {
      logger.debug("Unhandled GitHub webhook event type", { eventType, deliveryId })
    }

    return NextResponse.json({ success: true, data: { processed: true } })
  } catch (error) {
    logger.error("Failed to process GitHub webhook", {
      error: String(error),
      eventType,
      deliveryId,
    })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to process webhook" } },
      { status: 500 }
    )
  }
}
