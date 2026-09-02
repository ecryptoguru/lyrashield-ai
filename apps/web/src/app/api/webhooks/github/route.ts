import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { getSystemPrisma, prisma } from "@lyrashield/db"
import { verifyWebhookSignature } from "@lyrashield/integrations"
import { enqueueScanJob } from "@/lib/queue"
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
    merged: z.boolean().optional(),
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
  const systemPrisma = getSystemPrisma()

  // Idempotency: GitHub retries any delivery that doesn't return 2xx (and can
  // redeliver on its own). The X-GitHub-Delivery id is unique per delivery, and
  // WebhookEvent has @@unique([provider, externalId]) built for exactly this.
  // If we've already recorded this delivery, treat it as a processed no-op so
  // retries don't 500-loop or duplicate side effects.
  const alreadyProcessed = await systemPrisma.webhookEvent.findUnique({
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
        const integration = await systemPrisma.integration.findFirst({
          where: { type: "GITHUB", externalId: String(installation.id) },
        })

        if (integration) {
          try {
            await systemPrisma.$transaction(async (tx) => {
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

              // Match targets that were imported from the same GitHub App
              // installation. This is precise and avoids the previous
              // `startsWith` owner-prefix bug (e.g. "acme" matching
              // "acme-corp/other" or "not-acme/repo").
              //
              // Targets created before Target.installationId existed have a
              // NULL value and would never match the precise predicate, so they
              // would survive an App uninstall and stay scannable after the
              // customer revoked access. Cover that legacy cohort by falling
              // back to an exact owner match (not `startsWith`) for NULL rows.
              await tx.target.updateMany({
                where: {
                  workspaceId: integration.workspaceId,
                  repoProvider: "github",
                  OR: [
                    { installationId: String(installation.id) },
                    { installationId: null, repoOwner: installation.account.login },
                  ],
                },
                data: { deletedAt: new Date() },
              })
            })

            try {
              // The extended client owns the advisory-locked audit chain.
              // Never create audit rows through the broader provider mutation
              // transaction or a raw/system client.
              await prisma.auditLog.create({
                data: {
                  workspaceId: integration.workspaceId,
                  action: "integration.github.disconnected",
                  resourceType: "integration",
                  resourceId: integration.id,
                  metadata: {
                    installationId: installation.id,
                    deliveryId,
                    reason: "installation.deleted",
                  },
                },
              })
            } catch (auditError) {
              // Let GitHub retry the idempotent provider mutation if the audit
              // chain could not be retained. Removing only this delivery marker
              // avoids accepting an unaudited disconnect as complete.
              await systemPrisma.webhookEvent.deleteMany({
                where: { provider: "github", externalId: deliveryId },
              })
              throw auditError
            }
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

      const integration = await systemPrisma.integration.findFirst({
        where: { type: "GITHUB", externalId: String(installation.id) },
      })

      if (integration) {
        try {
          await systemPrisma.webhookEvent.create({
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

          // WP3 loop-closure: a LyraShield fix branch merged. Mark the PR merged,
          // queue a retest of the finding on the new head, and re-evaluate the
          // gate so a merged fix moves the verdict toward READY. Unknown or
          // foreign branches are a no-op (handleFixPrMerged returns null).
          if (
            action === "closed" &&
            pullRequest.merged === true &&
            pullRequest.head.ref.startsWith("lyrashield/fix-")
          ) {
            let loopClosureDelivered = false
            try {
              const { handleFixPrMergedAndReevaluate } = await import("@lyrashield/db")
              const outcome = await handleFixPrMergedAndReevaluate(
                integration.workspaceId,
                pullRequest.head.ref,
                pullRequest.number
              )
              if (outcome) {
                // The retest scan exists but is not queued yet — packages/db
                // cannot reach the scan queue. Enqueue it here; a queue outage
                // deletes the delivery marker below so GitHub redelivers and
                // the merge step no-ops cleanly while the enqueue retries.
                await enqueueScanJob({
                  scanId: outcome.retestScanId,
                  workspaceId: integration.workspaceId,
                  targetId: outcome.targetId,
                  goal: outcome.goal,
                  mode: outcome.mode,
                  ...(outcome.policyId ? { policyId: outcome.policyId } : {}),
                })
                loopClosureDelivered = true
                logger.info("Fix PR merge closed the loop", {
                  retestId: outcome.retestId,
                  findingId: outcome.findingId,
                  retestScanId: outcome.retestScanId,
                })
              } else {
                loopClosureDelivered = true
              }
            } catch (loopErr) {
              // Loop-closure is best-effort for the webhook RESPONSE (it must
              // still 2xx so GitHub does not hammer retries on a permanent
              // failure), but not for DELIVERY: unless the outcome was fully
              // delivered (merge + retest + enqueue), delete the stored event
              // marker so GitHub's automatic redelivery retries the idempotent
              // path — the merge step no-ops on redelivery and only the
              // missing tail is retried. Mirrors the audit-compensation
              // pattern used for the installation.deleted track above.
              if (!loopClosureDelivered) {
                await systemPrisma.webhookEvent
                  .deleteMany({
                    where: { provider: "github", externalId: deliveryId },
                  })
                  .catch(() => undefined)
              }
              logger.error("Fix PR loop-closure failed (marker cleared for redelivery)", {
                error: String(loopErr),
              })
            }
          }
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
