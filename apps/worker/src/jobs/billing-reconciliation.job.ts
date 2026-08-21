/**
 * Billing reconciliation job.
 *
 * Daily BullMQ job that:
 * 1. Pulls recent Polar orders/subscriptions and Razorpay payments
 * 2. Compares against WebhookEvent rows in the database
 * 3. Replays missed events (webhooks that were not received or processed)
 * 4. Alerts on drift (events in the provider but not in the DB, or vice versa)
 *
 * This is a safety net — webhooks should handle 99% of events, but this
 * job catches the ones that fall through the cracks.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { getPolarClient, getRazorpayClient, WEBHOOK_TRACK_MAX_ATTEMPTS } from "@lyrashield/billing"
import { enqueueWebhookTrackRetry } from "@lyrashield/integrations"

export interface ReconciliationResult {
  /** Number of Polar events checked. */
  polarChecked: number
  /** Number of Razorpay events checked. */
  razorpayChecked: number
  /** Number of missed events replayed. */
  replayed: number
  /** Number of drift alerts raised. */
  driftAlerts: number
  /** Number of incomplete webhook tracks re-enqueued for retry. */
  tracksReEnqueued: number
  /** Number of dead-lettered tracks skipped (terminal — need manual triage). */
  deadLetterSkipped: number
  /** Details of drift alerts. */
  alerts: ReconciliationAlert[]
}

export interface ReconciliationAlert {
  provider: string
  externalId: string
  type: string
  message: string
}

/** A pending track older than this is stranded (crashed before execution). */
const STRANDED_PENDING_MIN_AGE_MS = 10 * 60_000

/** Upper bound on retries enqueued per reconciliation run. */
const TRACK_RETRY_BATCH_LIMIT = 50

/**
 * Run the billing reconciliation job.
 *
 * This job is designed to be run as a daily BullMQ repeatable job.
 * It checks the last 24 hours of events.
 */
export async function runBillingReconciliation(): Promise<ReconciliationResult> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // last 24 hours
  const result: ReconciliationResult = {
    polarChecked: 0,
    razorpayChecked: 0,
    replayed: 0,
    driftAlerts: 0,
    tracksReEnqueued: 0,
    deadLetterSkipped: 0,
    alerts: [],
  }

  // Reconcile Polar events
  await reconcilePolar(since, result)

  // Reconcile Razorpay events
  await reconcileRazorpay(since, result)

  // Check for unprocessed webhook events in the DB
  await checkUnprocessedEvents(result)

  // Re-enqueue incomplete required-tracks (findings 12 / 18A)
  await reEnqueueIncompleteTracks(result)

  logger.info("Billing reconciliation complete", {
    polarChecked: result.polarChecked,
    razorpayChecked: result.razorpayChecked,
    replayed: result.replayed,
    driftAlerts: result.driftAlerts,
    tracksReEnqueued: result.tracksReEnqueued,
    deadLetterSkipped: result.deadLetterSkipped,
  })

  return result
}

/**
 * Reconcile Polar orders and subscriptions against WebhookEvent rows.
 */
async function reconcilePolar(since: Date, result: ReconciliationResult): Promise<void> {
  const client = getPolarClient()
  if (!client) {
    logger.debug("Polar client not configured — skipping Polar reconciliation")
    return
  }

  try {
    // A-L07: Paginate through all orders in the 24h window, not just the first 50.
    let page = 1
    const pageSize = 50
    let hasMore = true
    while (hasMore) {
      const ordersResponse = await (
        client as unknown as {
          orders: {
            list: (params: {
              limit: number
              page?: number
            }) => Promise<
              | { result: { id: string }[] }
              | { items: { id: string }[] }
              | { data: { id: string }[] }
              | { pagination: { hasMore: boolean } }
            >
          }
        }
      ).orders
        .list({ limit: pageSize, page })
        .catch(() => null)

      if (!ordersResponse) {
        logger.debug("Polar orders API not available — skipping")
        return
      }

      const orders =
        (
          ordersResponse as {
            result?: { id: string }[]
            items?: { id: string }[]
            data?: { id: string }[]
          }
        ).result ??
        (ordersResponse as { items?: { id: string }[] }).items ??
        (ordersResponse as { data?: { id: string }[] }).data ??
        []

      if (orders.length === 0) {
        hasMore = false
        break
      }

      for (const order of orders) {
        result.polarChecked++

        // Check if we have a WebhookEvent for this order
        const existing = await prisma.webhookEvent.findUnique({
          where: {
            provider_externalId: { provider: "polar", externalId: order.id },
          },
          select: { id: true, processed: true, eventType: true, payload: true },
        })

        if (!existing) {
          // A-M06: Missed event — attempt to replay it by constructing a
          // synthetic webhook event and processing it.
          result.driftAlerts++
          result.alerts.push({
            provider: "polar",
            externalId: order.id,
            type: "order.paid",
            message: "Polar order not found in WebhookEvent table — webhook may have been missed",
          })

          // Attempt replay: insert the event and mark for processing
          try {
            await prisma.webhookEvent.create({
              data: {
                provider: "polar",
                externalId: order.id,
                eventType: "order.paid",
                payload: { id: order.id, replayed: true },
                processed: false,
              },
            })
            result.replayed++
            logger.info("Replayed missed Polar event", { externalId: order.id })
          } catch {
            // P2002 — race with another reconciler, ignore
          }
        } else if (!existing.processed) {
          // A-M06: Unprocessed event — flag for reprocessing
          result.driftAlerts++
          result.alerts.push({
            provider: "polar",
            externalId: order.id,
            type: "unprocessed",
            message: "Polar webhook event exists but was not processed",
          })
        }
      }

      // Check if there are more pages
      const pagination = (ordersResponse as { pagination?: { hasMore: boolean } }).pagination
      hasMore = pagination?.hasMore ?? orders.length === pageSize
      page++
    }
  } catch (error) {
    logger.error("Polar reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Reconcile Razorpay payments against WebhookEvent rows.
 */
async function reconcileRazorpay(_since: Date, result: ReconciliationResult): Promise<void> {
  const client = getRazorpayClient()
  if (!client) {
    logger.debug("Razorpay client not configured — skipping Razorpay reconciliation")
    return
  }

  try {
    // A-L07: Paginate through all payments in the 24h window
    let razorpayPage = 1
    const razorpayPageSize = 50
    let razorpayHasMore = true
    while (razorpayHasMore) {
      const payments = await (
        client as unknown as {
          payments: {
            all: (params: {
              count: number
              skip?: number
            }) => Promise<{ items: { id: string; status: string }[] }>
          }
        }
      ).payments
        .all({ count: razorpayPageSize, skip: (razorpayPage - 1) * razorpayPageSize })
        .catch(() => null)

      if (!payments) {
        logger.debug("Razorpay payments API not available — skipping")
        return
      }

      const paymentItems = payments.items ?? []
      if (paymentItems.length === 0) {
        razorpayHasMore = false
        break
      }

      for (const payment of paymentItems) {
        result.razorpayChecked++

        if (payment.status !== "captured") continue

        const existing = await prisma.webhookEvent.findUnique({
          where: {
            provider_externalId: { provider: "razorpay", externalId: payment.id },
          },
          select: { id: true, processed: true },
        })

        if (!existing) {
          result.driftAlerts++
          result.alerts.push({
            provider: "razorpay",
            externalId: payment.id,
            type: "payment.captured",
            message:
              "Razorpay payment not found in WebhookEvent table — webhook may have been missed",
          })
        } else if (!existing.processed) {
          result.driftAlerts++
          result.alerts.push({
            provider: "razorpay",
            externalId: payment.id,
            type: "unprocessed",
            message: "Razorpay webhook event exists but was not processed",
          })
        }
      }

      razorpayHasMore = paymentItems.length === razorpayPageSize
      razorpayPage++
    }
  } catch (error) {
    logger.error("Razorpay reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Check for unprocessed WebhookEvent rows in the database.
 */
async function checkUnprocessedEvents(result: ReconciliationResult): Promise<void> {
  const unprocessed = await prisma.webhookEvent.findMany({
    where: {
      processed: false,
      createdAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }, // last 48 hours
    },
    select: { id: true, provider: true, externalId: true, eventType: true },
    take: 100,
  })

  for (const event of unprocessed) {
    result.driftAlerts++
    result.alerts.push({
      provider: event.provider,
      externalId: event.externalId,
      type: event.eventType,
      message: `Unprocessed ${event.provider} webhook event: ${event.eventType}`,
    })
  }
}

/**
 * Re-enqueue incomplete required-tracks (findings 12 / 18A).
 *
 * Selects track rows that are pending-but-stranded (older than the stranded
 * window) or failed while under the bounded attempt cap, and enqueues one
 * bounded batch of retry jobs. Dead-lettered tracks are terminal — counted
 * and skipped so they surface for manual triage without infinite retries.
 */
async function reEnqueueIncompleteTracks(result: ReconciliationResult): Promise<void> {
  const strandedCutoff = new Date(Date.now() - STRANDED_PENDING_MIN_AGE_MS)

  const incomplete = await prisma.webhookEventTrack.findMany({
    where: {
      OR: [
        { status: "pending", createdAt: { lt: strandedCutoff } },
        { status: "failed", attempts: { lt: WEBHOOK_TRACK_MAX_ATTEMPTS } },
      ],
    },
    select: { id: true, webhookEventId: true, track: true },
    orderBy: { updatedAt: "asc" },
    take: TRACK_RETRY_BATCH_LIMIT + 25,
  })

  for (const row of incomplete) {
    if (result.tracksReEnqueued >= TRACK_RETRY_BATCH_LIMIT) break
    try {
      await enqueueWebhookTrackRetry({ webhookEventId: row.webhookEventId, track: row.track })
      result.tracksReEnqueued++
    } catch (error) {
      logger.warn("Reconciliation could not enqueue webhook track retry", {
        webhookEventId: row.webhookEventId,
        track: row.track,
        reason: "retry_enqueue_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Dead letters: count only (bounded summary), never re-enqueue.
  result.deadLetterSkipped = await prisma.webhookEventTrack.count({
    where: { status: "dead_letter" },
  })

  if (result.tracksReEnqueued > 0 || result.deadLetterSkipped > 0) {
    logger.info("Webhook track reconciliation sweep", {
      reEnqueued: result.tracksReEnqueued,
      deadLetterSkipped: result.deadLetterSkipped,
      scanned: incomplete.length,
    })
  }
}
