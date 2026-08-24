/**
 * Webhook required-track execution and durable state.
 *
 * Each ingested billing webhook gets one WebhookEventTrack row per applicable
 * track. The parent `processed` flag is a DERIVED compatibility flag: set only
 * when every applicable track row is "succeeded". A failed or pending required
 * track never yields a 200-and-done outcome — the ingress answers 5xx and the
 * track is durably queued for retry (queue authority: @lyrashield/integrations).
 *
 * Applicability matrix (computeApplicableTracks):
 * - billing:   always (entitlements/pack credit/refund reversal adapters)
 * - license:   local-purchase-paid shape with productKind "local" (both providers)
 * - affiliate: commission-relevant events — refund completions (both providers,
 *              fixes the `refund.created` clawback gap) and paid orders matching
 *              the historical dispatch triggers, minus minute packs (C2).
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { extractProductId } from "@lyrashield/pricing"
import { isHandledPolarEvent } from "./providers/polar/webhooks"
import { processPolarEvent } from "./providers/polar/adapter"
import { isHandledRazorpayEvent } from "./providers/razorpay/webhooks"
import { processRazorpayEvent } from "./providers/razorpay/adapter"
import { issueLicenseForProviderOrder } from "./license-fulfillment"
import { normalizeProviderEvent, type NormalizedBillingEvent } from "./domain-events"

export const WEBHOOK_TRACK_IDS = ["billing", "license", "affiliate"] as const
export type WebhookTrackId = (typeof WEBHOOK_TRACK_IDS)[number]

/** Bounded retry budget per track before dead-lettering. */
export const WEBHOOK_TRACK_MAX_ATTEMPTS = 5

/** lastError is a bounded reason string — never payload or customer data. */
const LAST_ERROR_MAX_CHARS = 500

/** Handlers injected so this module stays decoupled from package boundaries. */
export interface WebhookTrackHandlers {
  /** Affiliate commission/clawback dispatch (@lyrashield/affiliate). */
  dispatchAffiliate(event: NormalizedBillingEvent): Promise<unknown>
}

function isCommissionRelevant(event: NormalizedBillingEvent): boolean {
  if (event.kind === "refund_completed") return true
  return (
    (event.productKind === "subscription" || event.productKind === "local") &&
    (event.kind === "subscription_paid" ||
      event.kind === "subscription_renewed" ||
      event.kind === "local_purchase_paid")
  )
}

/** Tracks that must succeed before the parent event counts as processed. */
export function computeApplicableTracks(event: NormalizedBillingEvent): WebhookTrackId[] {
  const tracks: WebhookTrackId[] = ["billing"]
  if (event.kind === "local_purchase_paid" && event.productKind === "local") {
    tracks.push("license")
  }
  if (isCommissionRelevant(event)) tracks.push("affiliate")
  return tracks
}

/** Idempotently materialize pending track rows for a claimed event. */
export async function ensureWebhookTrackRows(
  webhookEventId: string,
  tracks: WebhookTrackId[]
): Promise<void> {
  await prisma.webhookEventTrack.createMany({
    data: tracks.map((track) => ({ webhookEventId, track })),
    skipDuplicates: true,
  })
}

export async function markTrackSucceeded(
  webhookEventId: string,
  track: WebhookTrackId
): Promise<void> {
  await prisma.webhookEventTrack.updateMany({
    where: { webhookEventId, track },
    data: { status: "succeeded", completedAt: new Date(), lastError: null },
  })
}

export async function markTrackFailed(
  webhookEventId: string,
  track: WebhookTrackId,
  error: unknown,
  opts: { deadLetter?: boolean; attempts?: number } = {}
): Promise<void> {
  const message = boundTrackError(error)
  await prisma.webhookEventTrack.updateMany({
    where: { webhookEventId, track },
    data: {
      status: opts.deadLetter ? "dead_letter" : "failed",
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      lastError: message,
    },
  })
}

/** Truncate an error message into a bounded, log-safe reason string. */
export function boundTrackError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.length > LAST_ERROR_MAX_CHARS ? raw.slice(0, LAST_ERROR_MAX_CHARS) : raw
}

/**
 * Derived compatibility flag: `processed` becomes true only when every
 * applicable track row is "succeeded". Events without any track rows are
 * legacy rows — keep their historical whole-row semantics.
 */
export async function syncDerivedProcessedState(webhookEventId: string): Promise<boolean> {
  const [total, remaining] = await Promise.all([
    prisma.webhookEventTrack.count({ where: { webhookEventId } }),
    prisma.webhookEventTrack.count({
      where: { webhookEventId, status: { not: "succeeded" } },
    }),
  ])
  if (total === 0 || remaining > 0) return false
  await prisma.webhookEvent.updateMany({
    where: { id: webhookEventId, processed: false },
    data: { processed: true, processedAt: new Date() },
  })
  return true
}

/** Extract a buyer email from a provider order entity (identifiers only in logs). */
function extractBuyerEmail(entity: Record<string, unknown>): string | undefined {
  const customer = entity.customer
  const fromCustomerObj =
    customer && typeof customer === "object" && !Array.isArray(customer)
      ? (customer as Record<string, unknown>).email
      : undefined
  const meta = entity.metadata ?? entity.notes
  const fromMeta =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? ((meta as Record<string, unknown>).customerEmail ?? (meta as Record<string, unknown>).email)
      : undefined
  const email = (entity.customer_email ??
    entity.customerEmail ??
    entity.email ??
    entity.payer_email ??
    entity.buyer_email ??
    fromCustomerObj ??
    fromMeta) as string | undefined
  return typeof email === "string" && email.includes("@") ? email : undefined
}

/** Track B: mint a license for a Local SKU purchase. */
async function runLicenseTrack(event: NormalizedBillingEvent): Promise<void> {
  if (event.kind !== "local_purchase_paid" || event.productKind !== "local") return

  const entity = event.entity
  const productId = extractProductId(entity)
  if (!productId) throw new Error("license_track_missing_product_id")
  if (!event.orderId) throw new Error("license_track_missing_order_id")

  const buyerEmail = extractBuyerEmail(entity)
  if (!buyerEmail) {
    logger.warn("Local SKU purchase missing buyer email — cannot fulfill license", {
      provider: event.provider,
      orderId: event.orderId,
      productId,
    })
    throw new Error("license_track_missing_buyer_email")
  }

  const seatBag = [entity.seats, entity.seat_count, entity.quantity]
  const meta = entity.metadata ?? entity.notes
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>
    seatBag.push(m.seats, m.seatCount, m.seat_count)
  }
  const seatRaw = seatBag.find((v) => typeof v === "number" && v > 0) ?? 1
  const seatCount = Math.floor(seatRaw as number)

  logger.info("Fulfilling license for Local SKU purchase", {
    provider: event.provider,
    orderId: event.orderId,
    sku: productId,
  })

  await issueLicenseForProviderOrder({
    provider: event.provider,
    productId,
    buyerEmail,
    seatCount,
    orderId: event.orderId,
    workspaceId: event.workspaceId ?? undefined,
  })
}

/**
 * Execute ONE track's handler for a normalized event.
 *
 * @param track - which track to run (retry jobs run exactly one)
 * @param event - normalized domain event
 * @param rawPayload - validated provider payload as stored on WebhookEvent
 * @param handlers - injected cross-package handlers
 */
export async function executeWebhookTrack(
  track: WebhookTrackId,
  event: NormalizedBillingEvent,
  rawPayload: unknown,
  handlers: WebhookTrackHandlers
): Promise<void> {
  switch (track) {
    case "billing": {
      if (event.provider === "polar") {
        const payload = rawPayload as Parameters<typeof processPolarEvent>[0]
        if (!isHandledPolarEvent(payload.type)) return
        await processPolarEvent(payload)
        return
      }
      const payload = rawPayload as Parameters<typeof processRazorpayEvent>[0]
      if (!isHandledRazorpayEvent(payload.event)) return
      await processRazorpayEvent(payload)
      return
    }
    case "license":
      await runLicenseTrack(event)
      return
    case "affiliate":
      await handlers.dispatchAffiliate(event)
      return
  }
}

/** One failed (or dead-lettered) track outcome. */
export interface TrackFailure {
  track: WebhookTrackId
  /** Bounded reason string — identifiers/reason codes only. */
  error: string
}

export interface TrackRunSummary {
  allSucceeded: boolean
  attempted: number
  succeeded: number
  failures: TrackFailure[]
  deadLettered: TrackFailure[]
}

/**
 * Execute every applicable track of a freshly claimed (or stranded) webhook
 * event, materializing durable WebhookEventTrack rows and updating the parent
 * `processed` derived flag when all applicable tracks have succeeded.
 *
 * Already-succeeded tracks are never re-run; a track that has dead-lettered is
 * not re-run inline either (only manual/reconciliation intervention resets it).
 */
export async function runApplicableTracks(params: {
  webhookEventId: string
  event: NormalizedBillingEvent
  rawPayload: unknown
  handlers: WebhookTrackHandlers
}): Promise<TrackRunSummary> {
  const { webhookEventId, event, rawPayload, handlers } = params
  const applicable = computeApplicableTracks(event)
  await ensureWebhookTrackRows(webhookEventId, applicable)

  const rows = await prisma.webhookEventTrack.findMany({ where: { webhookEventId } })
  const summary: TrackRunSummary = {
    allSucceeded: true,
    attempted: 0,
    succeeded: 0,
    failures: [],
    deadLettered: [],
  }

  for (const track of applicable) {
    const row = rows.find((r) => r.track === track)
    if (row?.status === "succeeded" || row?.status === "dead_letter") continue

    const attempts = (row?.attempts ?? 0) + 1
    summary.attempted++
    try {
      await executeWebhookTrack(track, event, rawPayload, handlers)
      await markTrackSucceeded(webhookEventId, track)
      summary.succeeded++
    } catch (error) {
      const bounded = boundTrackError(error)
      const dead = attempts >= WEBHOOK_TRACK_MAX_ATTEMPTS
      await markTrackFailed(webhookEventId, track, error, { deadLetter: dead, attempts })
      logger.error("Webhook track failed", {
        webhookEventId,
        track,
        attempts,
        deadLetter: dead,
        reason: bounded,
      })
      const failure: TrackFailure = { track, error: bounded }
      if (dead) summary.deadLettered.push(failure)
      else summary.failures.push(failure)
    }
  }

  summary.allSucceeded =
    summary.failures.length === 0 &&
    summary.deadLettered.length === 0 &&
    // Nothing left non-succeeded among applicable tracks.
    !(await hasUnsatisfiedTrack(webhookEventId))
  if (summary.allSucceeded && summary.attempted > 0) {
    await syncDerivedProcessedState(webhookEventId)
  }
  return summary
}

async function hasUnsatisfiedTrack(webhookEventId: string): Promise<boolean> {
  return (
    (await prisma.webhookEventTrack.count({
      where: { webhookEventId, status: { not: "succeeded" } },
    })) > 0
  )
}

/** Outcome of one retry-job execution attempt. */
export type WebhookTrackRetryOutcome =
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "skipped_succeeded"
  | "skipped_dead_letter"
  | "not_applicable"
  | "missing"

/**
 * Re-execute exactly ONE track for a stored webhook event (worker retry job).
 *
 * Reloads the event + track row, re-normalizes the stored payload, guards on
 * terminal states (succeeded / dead_letter), executes only that track, and
 * updates durable state. The caller decides whether to enqueue the next
 * delayed attempt based on the returned outcome.
 */
export async function retryWebhookTrack(params: {
  webhookEventId: string
  track: WebhookTrackId
  handlers: WebhookTrackHandlers
}): Promise<WebhookTrackRetryOutcome> {
  const { webhookEventId, track, handlers } = params

  const event = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
    select: { provider: true, externalId: true, eventType: true, payload: true },
  })
  if (!event || !WEBHOOK_TRACK_IDS.includes(track as WebhookTrackId)) return "missing"

  const row = await prisma.webhookEventTrack.findUnique({
    where: { webhookEventId_track: { webhookEventId, track } },
  })
  if (!row) return "missing"
  if (row.status === "succeeded") return "skipped_succeeded"
  if (row.status === "dead_letter") return "skipped_dead_letter"

  const normalized = normalizeProviderEvent({
    provider: event.provider === "razorpay" ? "razorpay" : "polar",
    eventType: event.eventType,
    payload: event.payload,
    deliveryId: event.externalId,
  })

  // Track no longer applies (applicability rules changed since ingestion):
  // remove the stale row so it cannot block the derived processed flag.
  if (!computeApplicableTracks(normalized).includes(track)) {
    await prisma.webhookEventTrack.delete({
      where: { webhookEventId_track: { webhookEventId, track } },
    })
    await syncDerivedProcessedState(webhookEventId)
    return "not_applicable"
  }

  const attempts = row.attempts + 1
  try {
    await executeWebhookTrack(track, normalized, event.payload, handlers)
    await markTrackSucceeded(webhookEventId, track)
    await syncDerivedProcessedState(webhookEventId)
    logger.info("Webhook track retry succeeded", { webhookEventId, track, attempts })
    return "succeeded"
  } catch (error) {
    const dead = attempts >= WEBHOOK_TRACK_MAX_ATTEMPTS
    await markTrackFailed(webhookEventId, track, error, { deadLetter: dead, attempts })
    logger.error("Webhook track retry failed", {
      webhookEventId,
      track,
      attempts,
      deadLetter: dead,
      reason: boundTrackError(error),
    })
    return dead ? "dead_letter" : "failed"
  }
}
