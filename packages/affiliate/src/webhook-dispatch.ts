/**
 * Webhook dispatch — affiliate fan-out from normalized billing domain events.
 *
 * Consumes the structural subset of @lyrashield/billing's NormalizedBillingEvent
 * (no package dependency — structural typing keeps the boundary clean).
 *
 * Finding 18A fix: refunds are keyed off the normalized `refund_completed`
 * kind, so `refund.created` — the raw type BOTH providers actually emit — now
 * fires the clawback path. The previous string matching (`order.refunded` /
 * `chargeback.created`) matched no real delivery.
 *
 * C2 exclusion preserved exactly: minute packs are never commissionable.
 */

import { logger } from "@lyrashield/logger"
import { isLocalSkuOrderPayload, isMinutePackOrderPayload } from "@lyrashield/pricing"
import { onOrderPaid, type OrderPaidPayload } from "./commission/engine"
import { onRefund, type RefundPayload, type ClawbackReason } from "./commission/clawback"
import { onLocalOrderPaid, type LocalOrderPaidPayload } from "./commission/local"

/** Structural subset of the billing NormalizedBillingEvent union. */
export interface NormalizedEventDispatchInput {
  provider: string
  kind:
    | "subscription_paid"
    | "subscription_renewed"
    | "local_purchase_paid"
    | "refund_completed"
    | "entitlement_transitioned"
  rawType: string
  productKind: "subscription" | "local" | "minute_pack" | "unknown"
  refundId?: string | null
  /** Provider resource record (untrusted content — never log raw). */
  entity: Record<string, unknown>
}

export interface WebhookDispatchResult {
  handled: boolean
  result?: unknown
  error?: string
}

/**
 * Dispatch a normalized billing event to the appropriate affiliate handler.
 */
export async function dispatch(
  input: NormalizedEventDispatchInput
): Promise<WebhookDispatchResult> {
  const { provider, kind, rawType, productKind, entity } = input

  logger.info("Affiliate webhook dispatch", { provider, kind: kind, rawType })

  try {
    // Money reversal → clawback (both providers emit `refund.created`).
    if (kind === "refund_completed") {
      const reason: ClawbackReason = rawType === "chargeback.created" ? "CHARGEBACK" : "REFUND"
      const refundPayload = mapRefundPayload(provider, entity, reason, input.refundId)
      if (refundPayload) {
        const result = await onRefund(refundPayload)
        return { handled: true, result }
      }
      logger.warn("Affiliate clawback skipped — refund payload missing order reference", {
        provider,
        refundId: input.refundId ?? undefined,
      })
      return { handled: false }
    }

    if (
      kind === "subscription_paid" ||
      kind === "subscription_renewed" ||
      kind === "local_purchase_paid"
    ) {
      if (productKind === "minute_pack" || isMinutePackOrderPayload(entity)) {
        // C2: Minute packs are one-time prepaid purchases, NOT subscriptions.
        // The founder-confirmed spec forbids affiliate commission on minute
        // packs. Skip commission creation entirely.
        logger.info("Affiliate dispatch: skipping minute-pack order (no commission)", {
          provider,
          rawType,
        })
        return { handled: true, result: { skipped: "minute_pack_no_commission" } }
      }

      if (productKind === "local" || isLocalSkuOrderPayload(entity)) {
        const localPayload = mapLocalOrderPayload(provider, entity)
        if (localPayload) {
          const result = await onLocalOrderPaid(localPayload)
          return { handled: true, result }
        }
        return { handled: false }
      }

      const orderPayload = mapOrderPaidPayload(provider, entity)
      if (orderPayload) {
        const result = await onOrderPaid(orderPayload)
        return { handled: true, result }
      }
      return { handled: false }
    }

    // Entitlement transitions carry no commission relevance.
    return { handled: false }
  } catch (error) {
    logger.error("Affiliate webhook dispatch error", {
      provider,
      kind,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Safely access a nested property from a Record<string, unknown>.
 */
function getProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key]
}

function getMetadata(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = payload.metadata ?? payload.notes
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>
  }
  return undefined
}

/**
 * Map a normalized paid event's entity to OrderPaidPayload for Cloud subscriptions.
 */
function mapOrderPaidPayload(
  provider: string,
  payload: Record<string, unknown>
): OrderPaidPayload | null {
  const externalId = (getProp(payload, "id") ??
    getProp(payload, "orderId") ??
    getProp(payload, "chargeId")) as string | undefined
  if (!externalId) return null

  const meta = getMetadata(payload)

  return {
    provider,
    externalId,
    providerSubscriptionId: (getProp(payload, "subscriptionId") ??
      getProp(payload, "subscription_id") ??
      (meta ? getProp(meta, "subscriptionId") : undefined)) as string | null | undefined,
    customerId: (getProp(payload, "customerId") ?? getProp(payload, "customer") ?? "") as string,
    customerEmail: (getProp(payload, "customerEmail") ??
      getProp(payload, "email") ??
      (meta ? getProp(meta, "customerEmail") : undefined)) as string | undefined,
    grossAmount: String(getProp(payload, "amount") ?? getProp(payload, "grossAmount") ?? "0"),
    discountAmount: String(
      getProp(payload, "discountAmount") ?? getProp(payload, "discount") ?? "0"
    ),
    taxAmount: String(getProp(payload, "taxAmount") ?? getProp(payload, "tax") ?? "0"),
    currency: (getProp(payload, "currency") ?? "USD") as string,
    isAnnual: Boolean(
      getProp(payload, "isAnnual") ?? (meta ? getProp(meta, "isAnnual") : undefined)
    ),
    planId: (getProp(payload, "planId") ?? (meta ? getProp(meta, "planId") : undefined)) as
      string | undefined,
    promoCode: (getProp(payload, "promoCode") ??
      (meta ? getProp(meta, "promoCode") : undefined)) as string | null | undefined,
    // C1: Look for cookieToken, then fall back to affiliate_id/click_id from
    // checkout metadata (the checkout route sets these directly in metadata).
    cookieToken: (getProp(payload, "cookieToken") ??
      (meta ? getProp(meta, "affToken") : undefined)) as string | null | undefined,
    affiliateId: (meta
      ? (getProp(meta, "affiliate_id") ?? getProp(meta, "affiliateId"))
      : undefined) as string | null | undefined,
    clickId: (meta ? (getProp(meta, "click_id") ?? getProp(meta, "clickId")) : undefined) as
      string | null | undefined,
    subid: (getProp(payload, "subid") ?? (meta ? getProp(meta, "subid") : undefined)) as
      string | null | undefined,
    isFirstPayment: Boolean(
      getProp(payload, "isFirstPayment") ?? (meta ? getProp(meta, "isFirstPayment") : undefined)
    ),
  }
}

/**
 * Map a normalized paid event's entity to LocalOrderPaidPayload for Local licenses.
 */
function mapLocalOrderPayload(
  provider: string,
  payload: Record<string, unknown>
): LocalOrderPaidPayload | null {
  const externalId = (getProp(payload, "id") ??
    getProp(payload, "orderId") ??
    getProp(payload, "chargeId")) as string | undefined
  if (!externalId) return null

  const meta = getMetadata(payload)
  const skuId = (getProp(payload, "skuId") ??
    getProp(payload, "productId") ??
    (meta ? getProp(meta, "productId") : undefined)) as string
  if (!skuId) return null

  return {
    provider,
    externalId,
    customerId: (getProp(payload, "customerId") ?? getProp(payload, "customer") ?? "") as string,
    customerEmail: (getProp(payload, "customerEmail") ??
      getProp(payload, "email") ??
      (meta ? getProp(meta, "customerEmail") : undefined)) as string | undefined,
    grossAmount: String(getProp(payload, "amount") ?? getProp(payload, "grossAmount") ?? "0"),
    discountAmount: String(
      getProp(payload, "discountAmount") ?? getProp(payload, "discount") ?? "0"
    ),
    taxAmount: String(getProp(payload, "taxAmount") ?? getProp(payload, "tax") ?? "0"),
    currency: (getProp(payload, "currency") ?? "USD") as string,
    skuId,
    promoCode: (getProp(payload, "promoCode") ??
      (meta ? getProp(meta, "promoCode") : undefined)) as string | null | undefined,
    cookieToken: (getProp(payload, "cookieToken") ??
      (meta ? getProp(meta, "affToken") : undefined)) as string | null | undefined,
    subid: (getProp(payload, "subid") ?? (meta ? getProp(meta, "subid") : undefined)) as
      string | null | undefined,
  }
}

/**
 * Map a normalized refund event's entity to RefundPayload.
 *
 * The clawback lookup keys on the ORIGINAL order/payment id (the same
 * conversion id used at commission creation), so order references win over
 * the refund's own row id.
 */
function mapRefundPayload(
  provider: string,
  payload: Record<string, unknown>,
  reason: ClawbackReason,
  refundId?: string | null
): RefundPayload | null {
  const externalId = (getProp(payload, "order_id") ??
    getProp(payload, "orderId") ??
    getProp(payload, "originalId") ??
    getProp(payload, "chargeId") ??
    getProp(payload, "charge_id") ??
    getProp(payload, "payment_id") ??
    getProp(payload, "paymentId") ??
    getProp(payload, "id")) as string | undefined
  if (!externalId) return null

  return {
    provider,
    externalId,
    refundId: refundId ?? null,
    refundAmount: String(getProp(payload, "refundAmount") ?? getProp(payload, "amount") ?? "0"),
    reason,
    isChargeback: reason === "CHARGEBACK",
  }
}
