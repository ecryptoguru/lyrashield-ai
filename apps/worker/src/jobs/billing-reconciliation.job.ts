/**
 * Billing reconciliation job.
 *
 * Daily worker job that:
 * 1. Pulls paid Polar orders and captured Razorpay payments since its durable checkpoint
 * 2. Compares them against persisted WebhookEvent rows — and, for processed
 *    pack settlements, verifies the internal MinutePack credit exists
 * 3. Reports unprocessed events and provider/webhook drift to operators
 *
 * This is report-only. It never synthesizes webhook payloads, retries tracks,
 * or changes billing or entitlements.
 */

import { randomUUID } from "node:crypto"
import { getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  getPolarClient,
  getRazorpayClient,
  isMinutePackOrderPayload,
} from "@lyrashield/billing"

export interface ReconciliationResult {
  /** Number of Polar events checked. */
  polarChecked: number
  /** Number of Razorpay events checked. */
  razorpayChecked: number
  /**
   * Pack settlements whose internal MinutePack credit was verified. Only
   * settlements with a fully processed receipt are probed — a pending receipt
   * is already reported by the unprocessed sweep, and double-counting it here
   * would inflate the drift signal.
   */
  packCreditsVerified: number
  /** Legacy metric retained for compatibility; provider-only rows are never synthesized. */
  replayed: number
  /** Number of drift alerts raised. */
  driftAlerts: number
  /** True only when every provider and database check completed and the cursor advanced. */
  completed: boolean
  /** True when the run did not sweep — see skipReason. */
  skipped: boolean
  /**
   * "lease_held": another worker currently owns the reconciliation lease.
   * "daily_complete": the durable cursor already completed a run inside the
   * current daily window, so replicas/restarts do not re-list providers.
   */
  skipReason?: "lease_held" | "daily_complete"
  /**
   * Window-independent billing backlog signal. The moving coverage window
   * must never make a pre-existing revenue exception disappear, so older
   * unresolved rows are preserved here even when they fall outside the
   * per-event drift scan.
   */
  backlog: {
    /** Unprocessed Polar/Razorpay webhook events older than this run's coverage window. */
    unprocessedBeforeCoverage: number
    /** Dead-lettered webhook tracks awaiting operator receipt review. */
    deadLetterTracks: number
  }
  /**
   * Receipt-integrity signal: settlement objects holding more than one
   * webhook receipt inside the coverage window. Provider redeliveries mint a
   * fresh delivery id per attempt, so duplication is expected — the money
   * rails stay idempotent on the provider object key. This is an audit
   * signal, not per-row drift.
   */
  duplicates: {
    /** Settlement objects with more than one in-window settlement receipt. */
    settlementDeliveries: number
  }
  /** Bounded identifier-only sample behind `duplicates`, for the alert log. */
  duplicateSamples: Array<{ provider: string; objectId: string; receipts: number }>
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
/** Reconciliation runs at most once per day; the durable cursor enforces it. */
const RECONCILIATION_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * Billing drift only ever involves money rails. WebhookEvent is shared with
 * non-billing providers (e.g. GitHub deliveries); those rows must never be
 * counted or sampled as billing drift.
 */
const BILLING_PROVIDERS = ["polar", "razorpay"] as const
/**
 * Bound provider listing so a pathological response stream cannot turn the
 * daily report into an unbounded API crawl. Hitting the bound means coverage
 * is incomplete — the run fails and the cursor does not advance.
 */
const MAX_PROVIDER_PAGES = 200
const UNPROCESSED_SAMPLE_LIMIT = 100
/** Bounded sample for receipt-integrity probes (duplicates, orphan refunds). */
const RECEIPT_INTEGRITY_SAMPLE_LIMIT = 50

class ReconciliationLeaseLostError extends Error {
  constructor() {
    super("Billing reconciliation lease was lost before completion")
    this.name = "ReconciliationLeaseLostError"
  }
}

interface ProviderWebhookReceipt {
  id: string
  processed: boolean
}

async function findProviderWebhookReceipt(
  provider: "polar" | "razorpay",
  objectId: string
): Promise<ProviderWebhookReceipt | null> {
  // Keep the cross-workspace check on the system client. These exact JSONB
  // expressions are backed by the provider-specific partial indexes in
  // 20260928140000_webhook_provider_object_lookup.
  // Provider redeliveries mint a fresh delivery id per attempt, so one
  // settlement can have several receipts — prefer a processed sibling: the
  // settlement counts as received when some delivery of it fully applied.
  const rows =
    provider === "polar"
      ? await getSystemPrisma().$queryRaw<ProviderWebhookReceipt[]>`
          SELECT id, processed FROM "WebhookEvent"
          WHERE provider = 'polar' AND "eventType" = 'order.paid'
            AND (payload #> '{data,id}') = to_jsonb(${objectId}::text)
          ORDER BY processed DESC, "createdAt" DESC
          LIMIT 1
        `
      : await getSystemPrisma().$queryRaw<ProviderWebhookReceipt[]>`
          SELECT id, processed FROM "WebhookEvent"
          WHERE provider = 'razorpay' AND "eventType" = 'payment.captured'
            AND (payload #> '{payload,payment,entity,id}') = to_jsonb(${objectId}::text)
          ORDER BY processed DESC, "createdAt" DESC
          LIMIT 1
        `

  return rows[0] ?? null
}

/** Narrow a provider entity to a plain record for the pack predicate. */
function entityRecord(entity: unknown): Record<string, unknown> {
  return typeof entity === "object" && entity !== null && !Array.isArray(entity)
    ? (entity as Record<string, unknown>)
    : {}
}

/**
 * Report-only credit verification for a settled pack purchase.
 *
 * The billing track keys its MinutePack credit on (provider, externalId) —
 * the provider settlement object id — and that key survives workspace
 * attribution loss (the pack stays account-owned with workspaceId NULL). A
 * processed settlement receipt without that row means money moved and the
 * credit was still never applied: report it, never replay it.
 *
 * Cross-workspace sweep over MinutePack (workspace-scoped, account-owned) —
 * system client, same justification as the WebhookEvent lookups above.
 */
async function verifyPackSettlementCredit(
  provider: "polar" | "razorpay",
  objectId: string,
  entity: Record<string, unknown>,
  result: ReconciliationResult
): Promise<void> {
  if (!isMinutePackOrderPayload(entity)) return
  const credit = await getSystemPrisma().minutePack.findFirst({
    where: { provider, externalId: objectId, deletedAt: null },
    select: { id: true },
  })
  if (credit) {
    result.packCreditsVerified++
    return
  }
  result.driftAlerts++
  result.alerts.push({
    provider,
    externalId: objectId,
    type: "settlement_credit_missing",
    message: `${provider} settlement was processed but its minute-pack credit does not exist`,
  })
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
    packCreditsVerified: 0,
    replayed: 0,
    driftAlerts: 0,
    completed: false,
    skipped: false,
    backlog: { unprocessedBeforeCoverage: 0, deadLetterTracks: 0 },
    duplicates: { settlementDeliveries: 0 },
    duplicateSamples: [],
    alerts: [],
  }

  const lease = await acquireReconciliationLease()
  if (!lease) {
    result.skipped = true
    result.skipReason = "lease_held"
    logger.info("Billing reconciliation skipped; another worker holds the lease")
    return result
  }

  // The daily schedule is durable, not just a timer: once a run has completed
  // inside the current day the cursor itself suppresses provider listing, so
  // replica startups and worker restarts never repeat the sweep early.
  // setInterval timers can only fire late, never early, so the scheduled tick
  // at or after 24h is unaffected.
  if (
    lease.lastCompletedAt &&
    lease.runStartedAt.getTime() - lease.lastCompletedAt.getTime() <
      RECONCILIATION_DAILY_INTERVAL_MS
  ) {
    await releaseReconciliationLease(lease.token)
    result.skipped = true
    result.skipReason = "daily_complete"
    logger.info("Billing reconciliation skipped; daily coverage already complete", {
      lastCompletedAt: lease.lastCompletedAt.toISOString(),
    })
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
    await checkBillingEventBacklog(result, { since, until })
    await checkSettlementReceiptIntegrity(result, { since, until })

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

  // Separate backlog/health signal: unresolved billing exceptions that predate
  // (or are invisible to) this run's coverage window stay operator-visible
  // forever — a later, narrower window can never make them disappear.
  if (
    result.backlog.unprocessedBeforeCoverage > 0 ||
    result.backlog.deadLetterTracks > 0
  ) {
    logger.warn("operator_alert", {
      code: "reconciliation_backlog",
      severity: "warning",
      unprocessedBeforeCoverage: result.backlog.unprocessedBeforeCoverage,
      deadLetterTracks: result.backlog.deadLetterTracks,
      coverageFrom: since.toISOString(),
    })
  }

  // Duplicate settlement receipts are reported once per settlement object as
  // a receipt-health signal — provider redeliveries mint a fresh delivery id
  // per attempt, so duplication is expected; what matters for audit is that
  // the money rails stay idempotent on the provider object key.
  if (result.duplicates.settlementDeliveries > 0) {
    logger.warn("operator_alert", {
      code: "reconciliation_duplicates",
      severity: "warning",
      settlementDeliveries: result.duplicates.settlementDeliveries,
      samples: result.duplicateSamples,
      truncated: result.duplicates.settlementDeliveries >= RECEIPT_INTEGRITY_SAMPLE_LIMIT,
    })
  }

  logger.info("Billing reconciliation complete", {
    polarChecked: result.polarChecked,
    razorpayChecked: result.razorpayChecked,
    packCreditsVerified: result.packCreditsVerified,
    replayed: result.replayed,
    driftAlerts: result.driftAlerts,
    completed: result.completed,
    backlog: result.backlog,
    duplicates: result.duplicates,
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
    // stop once orders are older than the transition lookback. The page count
    // is still bounded: a provider that never yields an out-of-window order
    // would otherwise keep the sweep listing forever.
    let polarPage = 0
    for await (const page of await client.orders.list({
      limit: 100,
      sorting: ["-created_at"],
    })) {
      if (++polarPage > MAX_PROVIDER_PAGES) {
        logger.error("Polar reconciliation exceeded the bounded page limit", {
          pages: MAX_PROVIDER_PAGES,
        })
        recordProviderCheckFailure(result, "polar")
        return false
      }
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
        const receipt = await findProviderWebhookReceipt("polar", order.id)

        if (!receipt) {
          result.driftAlerts++
          result.alerts.push({
            provider: "polar",
            externalId: order.id,
            type: "order.paid",
            message: "Polar order not found in WebhookEvent table — webhook may have been missed",
          })
        } else if (receipt.processed) {
          // The receipt applied — now prove the money produced its internal
          // record. Unprocessed receipts are already reported by the
          // unprocessed sweep; probing them here would double-count drift.
          await verifyPackSettlementCredit("polar", order.id, entityRecord(order), result)
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
      if (razorpayPage > MAX_PROVIDER_PAGES) {
        logger.error("Razorpay reconciliation exceeded the bounded page limit", {
          pages: MAX_PROVIDER_PAGES,
        })
        recordProviderCheckFailure(result, "razorpay")
        return false
      }
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
        const receipt = await findProviderWebhookReceipt("razorpay", payment.id)

        if (!receipt) {
          result.driftAlerts++
          result.alerts.push({
            provider: "razorpay",
            externalId: payment.id,
            type: "payment.captured",
            message:
              "Razorpay payment not found in WebhookEvent table — webhook may have been missed",
          })
        } else if (receipt.processed) {
          await verifyPackSettlementCredit(
            "razorpay",
            payment.id,
            entityRecord(payment),
            result
          )
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
 * Report unprocessed billing webhook rows with explicit coverage semantics.
 *
 * Two scopes, both bounded to the money rails (polar/razorpay) — non-billing
 * providers share the WebhookEvent table but are never revenue drift:
 * 1. Coverage window: unprocessed events created inside [since, until) become
 *    per-event drift alerts (bounded sample of UNPROCESSED_SAMPLE_LIMIT).
 * 2. Backlog: unprocessed events older than `since` plus dead-lettered track
 *    rows are counted into the separate `result.backlog` health signal so a
 *    new, narrower time window can never make them disappear.
 */
async function checkBillingEventBacklog(
  result: ReconciliationResult,
  coverage: { since: Date; until: Date }
): Promise<void> {
  // Cross-workspace sweep over billing-provider events — system client
  // (WebhookEvent is FORCE RLS strict; the plain client sees nothing under
  // the runtime role).
  const systemPrisma = getSystemPrisma()
  const billingScope = { provider: { in: [...BILLING_PROVIDERS] } }
  const inWindowWhere = {
    processed: false,
    ...billingScope,
    createdAt: { gte: coverage.since, lt: coverage.until },
  }
  const [unprocessedCount, unprocessed, olderCount, deadLetterTracks] = await Promise.all([
    systemPrisma.webhookEvent.count({ where: inWindowWhere }),
    systemPrisma.webhookEvent.findMany({
      where: inWindowWhere,
      select: { id: true, provider: true, externalId: true, eventType: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: UNPROCESSED_SAMPLE_LIMIT,
    }),
    systemPrisma.webhookEvent.count({
      where: {
        processed: false,
        ...billingScope,
        createdAt: { lt: coverage.since },
      },
    }),
    // WebhookEventTrack rows only exist for billing-provider events, so the
    // dead-letter count is already provider-scoped by construction.
    systemPrisma.webhookEventTrack.count({ where: { status: "dead_letter" } }),
  ])

  result.driftAlerts += unprocessedCount
  result.backlog.unprocessedBeforeCoverage = olderCount
  result.backlog.deadLetterTracks = deadLetterTracks

  for (const event of unprocessed) {
    result.alerts.push({
      provider: event.provider,
      externalId: event.externalId,
      type: event.eventType,
      message: `Unprocessed ${event.provider} webhook event: ${event.eventType}`,
    })
  }
}

/**
 * Receipt-integrity probes for the settlement log — report-only.
 *
 * Two anomalies the per-provider sweep and the unprocessed sweep cannot see:
 *
 * 1. Duplicate deliveries: provider redeliveries mint a fresh delivery id
 *    (Polar `webhook-id`; Razorpay `X-Razorpay-Event-ID`), so one settlement
 *    object can accumulate several settlement receipts. The credit/refund
 *    rails stay idempotent on the provider object id, so duplication is a
 *    once-per-object audit signal (`result.duplicates`), not per-row drift.
 * 2. Out-of-order settlement lifecycle: a PROCESSED refund receipt whose
 *    settlement object has no captured/paid receipt at all means a reversal
 *    was applied for money whose settlement we never recorded — real drift
 *    (`refund_without_settlement`), one alert per orphaned refund.
 *
 * Both probes are bounded raw SQL on the system client (WebhookEvent is
 * FORCE RLS strict) inside the run's coverage window. They never replay,
 * reprocess, or mutate billing state.
 */
async function checkSettlementReceiptIntegrity(
  result: ReconciliationResult,
  coverage: { since: Date; until: Date }
): Promise<void> {
  const systemPrisma = getSystemPrisma()

  const duplicateGroups = await systemPrisma.$queryRaw<
    Array<{ provider: string; objectId: string; receipts: number }>
  >`
    SELECT provider, object_id AS "objectId", COUNT(*)::int AS receipts
    FROM (
      SELECT 'polar'::text AS provider, payload #>> '{data,id}' AS object_id, "createdAt"
      FROM "WebhookEvent"
      WHERE provider = 'polar' AND "eventType" = 'order.paid'
      UNION ALL
      SELECT 'razorpay'::text, payload #>> '{payload,payment,entity,id}', "createdAt"
      FROM "WebhookEvent"
      WHERE provider = 'razorpay' AND "eventType" = 'payment.captured'
    ) deliveries
    WHERE object_id IS NOT NULL
      AND "createdAt" >= ${coverage.since} AND "createdAt" < ${coverage.until}
    GROUP BY provider, object_id
    HAVING COUNT(*) > 1
    ORDER BY receipts DESC
    LIMIT ${RECEIPT_INTEGRITY_SAMPLE_LIMIT}
  `
  result.duplicates.settlementDeliveries = duplicateGroups.length
  result.duplicateSamples = duplicateGroups

  // Razorpay refund receipts carry the settlement payment id on either the
  // payment entity or the refund entity; Polar order.refunded carries the
  // order itself at data.id.
  const [polarOrphans, razorpayOrphans] = await Promise.all([
    systemPrisma.$queryRaw<Array<{ id: string; externalId: string; objectId: string }>>`
      SELECT r.id, r."externalId", r.payload #>> '{data,id}' AS "objectId"
      FROM "WebhookEvent" r
      WHERE r.provider = 'polar' AND r."eventType" = 'order.refunded' AND r.processed
        AND r."createdAt" >= ${coverage.since} AND r."createdAt" < ${coverage.until}
        AND r.payload #>> '{data,id}' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "WebhookEvent" s
          WHERE s.provider = 'polar' AND s."eventType" = 'order.paid'
            AND (s.payload #> '{data,id}') = (r.payload #> '{data,id}')
        )
      ORDER BY r."createdAt" ASC
      LIMIT ${RECEIPT_INTEGRITY_SAMPLE_LIMIT}
    `,
    systemPrisma.$queryRaw<Array<{ id: string; externalId: string; objectId: string }>>`
      SELECT r.id, r."externalId",
        COALESCE(
          r.payload #>> '{payload,payment,entity,id}',
          r.payload #>> '{payload,refund,entity,payment_id}'
        ) AS "objectId"
      FROM "WebhookEvent" r
      WHERE r.provider = 'razorpay' AND r."eventType" = 'refund.created' AND r.processed
        AND r."createdAt" >= ${coverage.since} AND r."createdAt" < ${coverage.until}
        AND COALESCE(
          r.payload #>> '{payload,payment,entity,id}',
          r.payload #>> '{payload,refund,entity,payment_id}'
        ) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "WebhookEvent" s
          WHERE s.provider = 'razorpay' AND s."eventType" = 'payment.captured'
            AND (s.payload #> '{payload,payment,entity,id}') = to_jsonb(
              COALESCE(
                r.payload #>> '{payload,payment,entity,id}',
                r.payload #>> '{payload,refund,entity,payment_id}'
              )::text
            )
        )
      ORDER BY r."createdAt" ASC
      LIMIT ${RECEIPT_INTEGRITY_SAMPLE_LIMIT}
    `,
  ])

  for (const [provider, orphans] of [
    ["polar", polarOrphans],
    ["razorpay", razorpayOrphans],
  ] as const) {
    for (const orphan of orphans) {
      result.driftAlerts++
      result.alerts.push({
        provider,
        externalId: orphan.objectId,
        type: "refund_without_settlement",
        message: `${provider} refund was processed for a settlement with no captured/paid receipt — out-of-order or missing settlement event`,
      })
    }
  }
}
