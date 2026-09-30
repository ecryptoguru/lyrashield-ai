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
 * - affiliate: commission-relevant events — provider-proven full refunds and paid orders matching
 *              the historical dispatch triggers, minus minute packs (C2).
 */

import { randomUUID } from "node:crypto"
import { prisma, getSystemPrisma, runWithWorkspaceContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { extractProductId } from "@lyrashield/pricing"
import { isHandledPolarEvent } from "./providers/polar/webhooks"
import { processPolarEvent } from "./providers/polar/adapter"
import { isHandledRazorpayEvent } from "./providers/razorpay/webhooks"
import { processRazorpayEvent } from "./providers/razorpay/adapter"
import { issueLicenseForProviderOrder } from "./license-fulfillment"
import { normalizeProviderEvent, type NormalizedBillingEvent } from "./domain-events"
import { assertProviderCatalogEvent } from "./provider-catalog-validation"

export const WEBHOOK_TRACK_CLAIM_PROTOCOL = "durable-claims/1"

export const WEBHOOK_TRACK_IDS = ["billing", "license", "affiliate"] as const
export type WebhookTrackId = (typeof WEBHOOK_TRACK_IDS)[number]

/** Bounded retry budget per track before dead-lettering. */
export const WEBHOOK_TRACK_MAX_ATTEMPTS = 5

/** lastError is a bounded reason string — never payload or customer data. */
const LAST_ERROR_MAX_CHARS = 500
export const WEBHOOK_TRACK_RETRY_DELAY_MS = 60_000
const CLAIM_LEASE_MS = 120_000

/** Handlers injected so this module stays decoupled from package boundaries. */
export interface WebhookTrackHandlers {
  /** Affiliate commission/clawback dispatch (@lyrashield/affiliate). */
  dispatchAffiliate(event: NormalizedBillingEvent): Promise<unknown>
}

function isCommissionRelevant(event: NormalizedBillingEvent): boolean {
  if (event.kind === "refund_completed") return event.productKind !== "minute_pack"
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
    data: tracks.map((track) => ({ webhookEventId, track, nextAttemptAt: new Date() })),
    skipDuplicates: true,
  })
}

export interface WebhookTrackClaim {
  webhookEventId: string
  track: WebhookTrackId
  generation: number
  attempts: number
  token: string
}

export type WebhookTrackClaimResult =
  | { outcome: "claimed"; claim: WebhookTrackClaim }
  | { outcome: "busy" | "missing" }
  | { outcome: "terminal"; status: "succeeded" | "dead_letter" }

/** One atomic reservation shared by ingress and retry consumers. */
export async function claimWebhookTrack(
  webhookEventId: string,
  track: WebhookTrackId,
  generation?: number
): Promise<WebhookTrackClaimResult> {
  // Historical NULL due dates carry no proof of whether an old handler ran.
  // Only newly materialized rows or receipt-reviewed recovery supply due state.
  // Never reclaim an expired handler: its external effect may have completed.
  await prisma.$executeRaw`
    UPDATE "WebhookEventTrack"
    SET status = 'dead_letter', "lastError" = 'claim_expired_requires_receipt_review',
        "claimToken" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "updatedAt" = now()
    WHERE "webhookEventId" = ${webhookEventId} AND track = ${track}
      AND status = 'processing' AND "leaseExpiresAt" <= now()
  `
  const token = randomUUID()
  const rows = await prisma.$queryRaw<Array<{ generation: number; attempts: number }>>`
    UPDATE "WebhookEventTrack"
    SET status = 'processing', attempts = attempts + 1, "claimToken" = ${token},
        "leaseExpiresAt" = now() + ${CLAIM_LEASE_MS} * INTERVAL '1 millisecond',
        "nextAttemptAt" = NULL, "updatedAt" = now()
    WHERE "webhookEventId" = ${webhookEventId} AND track = ${track}
      AND status IN ('pending', 'failed') AND "claimToken" IS NULL
      AND attempts < ${WEBHOOK_TRACK_MAX_ATTEMPTS} AND "nextAttemptAt" <= now()
      AND (${generation ?? null}::integer IS NULL OR generation = ${generation ?? null}::integer)
    RETURNING generation, attempts
  `
  if (rows[0]) return { outcome: "claimed", claim: { webhookEventId, track, token, ...rows[0] } }
  const row = await prisma.webhookEventTrack.findUnique({
    where: { webhookEventId_track: { webhookEventId, track } },
  })
  if (!row) return { outcome: "missing" }
  if (row.status === "succeeded" || row.status === "dead_letter") {
    return { outcome: "terminal", status: row.status }
  }
  return { outcome: "busy" }
}

export async function renewWebhookTrackClaim(claim: WebhookTrackClaim): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "WebhookEventTrack"
    SET "leaseExpiresAt" = now() + ${CLAIM_LEASE_MS} * INTERVAL '1 millisecond', "updatedAt" = now()
    WHERE "webhookEventId" = ${claim.webhookEventId} AND track = ${claim.track}
      AND status = 'processing' AND generation = ${claim.generation}
      AND "claimToken" = ${claim.token} AND "leaseExpiresAt" > now()
  `
  return count === 1
}

export async function markTrackSucceeded(claim: WebhookTrackClaim): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "WebhookEventTrack"
    SET status = 'succeeded', "completedAt" = now(), "lastError" = NULL,
        "claimToken" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "updatedAt" = now()
    WHERE "webhookEventId" = ${claim.webhookEventId} AND track = ${claim.track}
      AND status = 'processing' AND generation = ${claim.generation}
      AND "claimToken" = ${claim.token} AND "leaseExpiresAt" > now()
  `
  return count === 1
}

/** Persist the next generation BEFORE attempting any Redis handoff. */
export async function markTrackFailed(claim: WebhookTrackClaim, error: unknown): Promise<boolean> {
  const dead = claim.attempts >= WEBHOOK_TRACK_MAX_ATTEMPTS
  const count = await prisma.$executeRaw`
    UPDATE "WebhookEventTrack"
    SET status = ${dead ? "dead_letter" : "failed"}, "lastError" = ${boundTrackError(error)},
        generation = generation + ${dead ? 0 : 1},
        "nextAttemptAt" = CASE WHEN ${dead} THEN NULL ELSE now() + ${WEBHOOK_TRACK_RETRY_DELAY_MS} * INTERVAL '1 millisecond' END,
        "claimToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
    WHERE "webhookEventId" = ${claim.webhookEventId} AND track = ${claim.track}
      AND status = 'processing' AND generation = ${claim.generation}
      AND "claimToken" = ${claim.token} AND "leaseExpiresAt" > now()
  `
  return count === 1
}

export async function getWebhookTrackRetrySchedule(webhookEventId: string, track: WebhookTrackId) {
  return prisma.webhookEventTrack.findFirst({
    where: {
      webhookEventId,
      track,
      status: { in: ["pending", "failed"] },
      nextAttemptAt: { not: null },
      claimToken: null,
      attempts: { lt: WEBHOOK_TRACK_MAX_ATTEMPTS },
    },
    select: { generation: true, nextAttemptAt: true },
  })
}

async function runClaimedTrack(
  claim: WebhookTrackClaim,
  execute: () => Promise<void>
): Promise<WebhookTrackRetryOutcome> {
  let leaseLost = false
  let renewal: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    renewal = renewal
      .then(async () => {
        if (!leaseLost) leaseLost = !(await renewWebhookTrackClaim(claim))
      })
      .catch(() => {
        leaseLost = true
      })
  }, CLAIM_LEASE_MS / 4)
  timer.unref()
  try {
    let executionError: unknown
    let failed = false
    try {
      await execute()
    } catch (error) {
      executionError = error
      failed = true
    }
    await renewal
    if (leaseLost) return "busy"
    // Receipt persistence errors must leave processing ownership intact. The
    // handler may have completed an external effect; never turn a failed
    // receipt write into permission to replay that handler automatically.
    if (!failed) return (await markTrackSucceeded(claim)) ? "succeeded" : "busy"
    if (!(await markTrackFailed(claim, executionError))) return "busy"
    logger.error("Webhook track failed", {
      webhookEventId: claim.webhookEventId,
      track: claim.track,
      attempts: claim.attempts,
      reason: boundTrackError(executionError),
    })
    return claim.attempts >= WEBHOOK_TRACK_MAX_ATTEMPTS ? "dead_letter" : "failed"
  } finally {
    clearInterval(timer)
  }
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
  assertProviderCatalogEvent(event.provider, event.rawType, rawPayload)
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

  const summary: TrackRunSummary = {
    allSucceeded: false,
    attempted: 0,
    succeeded: 0,
    failures: [],
    deadLettered: [],
  }
  for (const track of applicable) {
    const result = await claimWebhookTrack(webhookEventId, track)
    if (result.outcome !== "claimed") continue
    summary.attempted++
    const outcome = await runClaimedTrack(result.claim, () =>
      executeWebhookTrack(track, event, rawPayload, handlers)
    )
    if (outcome === "succeeded") summary.succeeded++
    if (outcome === "failed" || outcome === "dead_letter") {
      const failure = { track, error: outcome }
      if (outcome === "dead_letter") summary.deadLettered.push(failure)
      else summary.failures.push(failure)
    }
  }

  summary.allSucceeded =
    summary.failures.length === 0 &&
    summary.deadLettered.length === 0 &&
    // Nothing left non-succeeded among applicable tracks.
    !(await hasUnsatisfiedTrack(webhookEventId))
  if (summary.allSucceeded) {
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
  | "busy"

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
  generation?: number
  handlers: WebhookTrackHandlers
}): Promise<WebhookTrackRetryOutcome> {
  const { webhookEventId, track, generation, handlers } = params
  if (!WEBHOOK_TRACK_IDS.includes(track)) return "missing"
  // Trusted worker lookup, then bind the stored event workspace for domain writes.
  const event = await getSystemPrisma().webhookEvent.findUnique({
    where: { id: webhookEventId },
    select: { provider: true, externalId: true, eventType: true, payload: true, workspaceId: true },
  })
  if (!event) return "missing"
  return runWithWorkspaceContext(event.workspaceId, async () => {
    const result = await claimWebhookTrack(webhookEventId, track, generation)
    if (result.outcome === "terminal") {
      if (result.status === "succeeded") await syncDerivedProcessedState(webhookEventId)
      return result.status === "succeeded" ? "skipped_succeeded" : "skipped_dead_letter"
    }
    if (result.outcome !== "claimed") return result.outcome
    const outcome = await runClaimedTrack(result.claim, async () => {
      const normalized = normalizeProviderEvent({
        provider: event.provider === "razorpay" ? "razorpay" : "polar",
        eventType: event.eventType,
        payload: event.payload,
        deliveryId: event.externalId,
      })
      // Preserve the receipt rather than deleting historical track state.
      if (computeApplicableTracks(normalized).includes(track)) {
        await executeWebhookTrack(track, normalized, event.payload, handlers)
      }
    })
    if (outcome === "succeeded") await syncDerivedProcessedState(webhookEventId)
    return outcome
  })
}
