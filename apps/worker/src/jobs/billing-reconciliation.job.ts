/**
 * Billing reconciliation job.
 *
 * Daily worker job that:
 * 1. Pulls paid Polar orders and captured Razorpay payments since its durable checkpoint
 * 2. Compares them against persisted WebhookEvent rows
 * 3. Reports unprocessed events and provider/webhook drift to operators
 *
 * This is report-only. It never synthesizes webhook payloads, retries tracks,
 * or changes billing or entitlements.
 */

import { randomUUID } from "node:crypto"
import { getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { getPolarClient, getRazorpayClient } from "@lyrashield/billing"

export interface ReconciliationResult {
  /** Number of Polar events checked. */
  polarChecked: number
  /** Number of Razorpay events checked. */
  razorpayChecked: number
  /** Legacy metric retained for compatibility; provider-only rows are never synthesized. */
  replayed: number
  /** Number of drift alerts raised. */
  driftAlerts: number
  /** True only when every provider and database check completed and the cursor advanced. */
  completed: boolean
  /** True when another worker currently owns the reconciliation lease. */
  skipped: boolean
  /** Details of drift alerts. */
  alerts: ReconciliationAlert[]
}

interface ReconciliationAlert {
  provider: string
  externalId?: string
  type: string
  message: string
}

interface ReconciliationLease {
  token: string
  runStartedAt: Date
  coverageFrom: Date
  lastCompletedAt: Date | null
}

// Rescan orders/payments for status changes after creation. Polar retries
// subscription charges for 21 days; Razorpay can capture late-authorized
// payments for up to 5 days. Three extra days cover scheduler delay.
const RECONCILIATION_OVERLAP_MS = 24 * 24 * 60 * 60 * 1000
const RECONCILIATION_LEASE_ID = "singleton"

class ReconciliationLeaseLostError extends Error {
  constructor() {
    super("Billing reconciliation lease was lost before completion")
    this.name = "ReconciliationLeaseLostError"
  }
}

async function hasProviderWebhookEvent(provider: "polar" | "razorpay", objectId: string) {
  // Keep the cross-workspace check on the system client. These exact JSONB
  // expressions are backed by the provider-specific partial indexes in
  // 20260928140000_webhook_provider_object_lookup.
  const rows =
    provider === "polar"
      ? await getSystemPrisma().$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "WebhookEvent"
          WHERE provider = 'polar' AND "eventType" = 'order.paid'
            AND (payload #> '{data,id}') = to_jsonb(${objectId}::text)
          LIMIT 1
        `
      : await getSystemPrisma().$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "WebhookEvent"
          WHERE provider = 'razorpay' AND "eventType" = 'payment.captured'
            AND (payload #> '{payload,payment,entity,id}') = to_jsonb(${objectId}::text)
          LIMIT 1
        `

  return rows.length > 0
}

async function acquireReconciliationLease(): Promise<ReconciliationLease | null> {
  const token = randomUUID()
  const rows = await getSystemPrisma().$queryRaw<
    Array<{ checked_through: Date; coverage_from: Date; last_completed_at: Date | null }>
  >`
    INSERT INTO public."billing_reconciliation_state" (
      "id", "coverage_from", "last_completed_at", "lease_token", "lease_expires_at", "updated_at"
    ) VALUES (
      ${RECONCILIATION_LEASE_ID}, now() - INTERVAL '24 days', NULL,
      ${token}, now() + INTERVAL '30 minutes', now()
    )
    ON CONFLICT ("id") DO UPDATE SET
      "lease_token" = EXCLUDED."lease_token",
      "lease_expires_at" = EXCLUDED."lease_expires_at",
      "updated_at" = now()
    WHERE "billing_reconciliation_state"."lease_expires_at" IS NULL
      OR "billing_reconciliation_state"."lease_expires_at" <= now()
    RETURNING "coverage_from", "last_completed_at", now() AS checked_through
  `
  const state = rows[0]
  return state
    ? {
        token,
        runStartedAt: state.checked_through,
        coverageFrom: state.coverage_from,
        lastCompletedAt: state.last_completed_at,
      }
    : null
}

async function renewReconciliationLease(token: string): Promise<void> {
  const updated = await getSystemPrisma().$executeRaw`
    UPDATE public."billing_reconciliation_state"
    SET "lease_expires_at" = now() + INTERVAL '30 minutes', "updated_at" = now()
    WHERE "id" = ${RECONCILIATION_LEASE_ID}
      AND "lease_token" = ${token}
      AND "lease_expires_at" > now()
  `
  if (updated !== 1) throw new ReconciliationLeaseLostError()
}

async function completeReconciliationLease(token: string, completedAt: Date): Promise<boolean> {
  const updated = await getSystemPrisma().$executeRaw`
    UPDATE public."billing_reconciliation_state"
    SET "last_completed_at" = ${completedAt},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = now()
    WHERE "id" = ${RECONCILIATION_LEASE_ID}
      AND "lease_token" = ${token}
      AND "lease_expires_at" > now()
  `
  return updated === 1
}

async function releaseReconciliationLease(token: string): Promise<void> {
  await getSystemPrisma().$executeRaw`
    UPDATE public."billing_reconciliation_state"
    SET "lease_token" = NULL, "lease_expires_at" = NULL, "updated_at" = now()
    WHERE "id" = ${RECONCILIATION_LEASE_ID} AND "lease_token" = ${token}
  `
}

function recordProviderCheckFailure(
  result: ReconciliationResult,
  provider: "polar" | "razorpay"
): void {
  result.driftAlerts++
  result.alerts.push({
    provider,
    type: "provider_check_failed",
    message: `${provider} reconciliation failed; provider events were not checked`,
  })
}

/**
 * Run the billing reconciliation job.
 *
 * It checks from the last successful cursor with a 24-day overlap, plus every
 * still-unprocessed webhook. A first run establishes a 24-day baseline.
 */
export async function runBillingReconciliation(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    polarChecked: 0,
    razorpayChecked: 0,
    replayed: 0,
    driftAlerts: 0,
    completed: false,
    skipped: false,
    alerts: [],
  }

  const lease = await acquireReconciliationLease()
  if (!lease) {
    result.skipped = true
    logger.info("Billing reconciliation skipped; another worker holds the lease")
    return result
  }

  const until = lease.runStartedAt
  const since = lease.lastCompletedAt
    ? new Date(lease.lastCompletedAt.getTime() - RECONCILIATION_OVERLAP_MS)
    : lease.coverageFrom

  try {
    const polarComplete = await reconcilePolar(since, until, result, lease.token)
    const razorpayComplete = await reconcileRazorpay(since, until, result, lease.token)

    await renewReconciliationLease(lease.token)
    await checkUnprocessedEvents(result)

    if (polarComplete && razorpayComplete) {
      await renewReconciliationLease(lease.token)
      result.completed = await completeReconciliationLease(lease.token, until)
      if (!result.completed) throw new ReconciliationLeaseLostError()
    }
  } finally {
    try {
      await releaseReconciliationLease(lease.token)
    } catch (error) {
      logger.error("Billing reconciliation lease release failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (result.driftAlerts > 0) {
    const alertSamples = result.alerts.slice(0, 20)
    logger.warn("operator_alert", {
      code: "reconciliation_drift",
      severity: "warning",
      alertCount: result.driftAlerts,
      alertSamples,
      truncatedAlertCount: Math.max(0, result.driftAlerts - alertSamples.length),
    })
  }

  logger.info("Billing reconciliation complete", {
    polarChecked: result.polarChecked,
    razorpayChecked: result.razorpayChecked,
    replayed: result.replayed,
    driftAlerts: result.driftAlerts,
    completed: result.completed,
    initialBaseline: lease.lastCompletedAt === null,
    coverageFrom: since.toISOString(),
    checkedThrough: until.toISOString(),
  })

  return result
}

/**
 * Reconcile paid Polar orders against WebhookEvent rows.
 */
async function reconcilePolar(
  since: Date,
  until: Date,
  result: ReconciliationResult,
  leaseToken: string
): Promise<boolean> {
  const client = getPolarClient()
  if (!client) {
    logger.debug("Polar client not configured — skipping Polar reconciliation")
    recordProviderCheckFailure(result, "polar")
    return false
  }

  try {
    // The API has no modified-at filter. Descending creation order lets this
    // stop once orders are older than the transition lookback.
    for await (const page of await client.orders.list({
      limit: 100,
      sorting: ["-created_at"],
    })) {
      await renewReconciliationLease(leaseToken)
      for (const order of page.result.items) {
        if (order.createdAt < since) break
        if (order.createdAt > until || !order.paid) continue

        result.polarChecked++

        // Check if we have a WebhookEvent for this order. WebhookEvent is
        // FORCE RLS strict, so a cross-workspace reconciliation sweep must
        // read it through the system client (same justification as the
        // GitHub webhook route) — the plain client returns empty rows under
        // the NOBYPASSRLS runtime role and every order false-flags as
        // "webhook may have been missed".
        const existing = await hasProviderWebhookEvent("polar", order.id)

        if (!existing) {
          result.driftAlerts++
          result.alerts.push({
            provider: "polar",
            externalId: order.id,
            type: "order.paid",
            message: "Polar order not found in WebhookEvent table — webhook may have been missed",
          })
        }
      }
      if (page.result.items.some((order) => order.createdAt < since)) break
    }
    return true
  } catch (error) {
    if (error instanceof ReconciliationLeaseLostError) throw error
    logger.error("Polar reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    recordProviderCheckFailure(result, "polar")
    return false
  }
}

/**
 * Reconcile Razorpay payments against WebhookEvent rows.
 */
async function reconcileRazorpay(
  since: Date,
  until: Date,
  result: ReconciliationResult,
  leaseToken: string
): Promise<boolean> {
  const client = getRazorpayClient()
  if (!client) {
    logger.debug("Razorpay client not configured — skipping Razorpay reconciliation")
    recordProviderCheckFailure(result, "razorpay")
    return false
  }

  try {
    const from = Math.floor(since.getTime() / 1000)
    const to = Math.floor(until.getTime() / 1000)
    let razorpayPage = 1
    const razorpayPageSize = 50
    let razorpayHasMore = true
    while (razorpayHasMore) {
      await renewReconciliationLease(leaseToken)
      const payments = await client.payments.all({
        count: razorpayPageSize,
        skip: (razorpayPage - 1) * razorpayPageSize,
        from,
        to,
      })

      if (!payments || !Array.isArray(payments.items)) {
        logger.debug("Razorpay payments API returned an invalid response — skipping")
        recordProviderCheckFailure(result, "razorpay")
        return false
      }

      const paymentItems = payments.items
      if (paymentItems.length === 0) {
        razorpayHasMore = false
        break
      }

      for (const payment of paymentItems) {
        if (payment.created_at < from || payment.created_at > to) continue
        result.razorpayChecked++

        if (payment.status !== "captured") continue

        // Cross-workspace provider reconciliation — system client (see the
        // Polar note above: WebhookEvent is FORCE RLS strict).
        const existing = await hasProviderWebhookEvent("razorpay", payment.id)

        if (!existing) {
          result.driftAlerts++
          result.alerts.push({
            provider: "razorpay",
            externalId: payment.id,
            type: "payment.captured",
            message:
              "Razorpay payment not found in WebhookEvent table — webhook may have been missed",
          })
        }
      }

      razorpayHasMore = paymentItems.length === razorpayPageSize
      razorpayPage++
    }
    return true
  } catch (error) {
    if (error instanceof ReconciliationLeaseLostError) throw error
    logger.error("Razorpay reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    recordProviderCheckFailure(result, "razorpay")
    return false
  }
}

/**
 * Check for unprocessed WebhookEvent rows in the database.
 */
async function checkUnprocessedEvents(result: ReconciliationResult): Promise<void> {
  // Cross-workspace sweep over every provider's events — system client
  // (WebhookEvent is FORCE RLS strict; the plain client sees nothing under
  // the runtime role).
  const webhookEvent = getSystemPrisma().webhookEvent
  const where = { processed: false }
  const [unprocessedCount, unprocessed] = await Promise.all([
    webhookEvent.count({ where }),
    webhookEvent.findMany({
      where,
      select: { id: true, provider: true, externalId: true, eventType: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    }),
  ])

  result.driftAlerts += unprocessedCount

  for (const event of unprocessed) {
    result.alerts.push({
      provider: event.provider,
      externalId: event.externalId,
      type: event.eventType,
      message: `Unprocessed ${event.provider} webhook event: ${event.eventType}`,
    })
  }
}
