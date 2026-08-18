/**
 * Webhook dispatch — `dispatch({provider, event, payload})`.
 *
 * Fan-out to commission.engine.onOrderPaid / commission.clawback.onRefund /
 * commission.local.onOrderPaid.
 *
 * This is called by Track A's billing/webhook/route.ts.
 */

import { logger } from "@lyrashield/logger"
import { onOrderPaid, type OrderPaidPayload } from "./commission/engine"
import { onRefund, type RefundPayload, type ClawbackReason } from "./commission/clawback"
import { onLocalOrderPaid, type LocalOrderPaidPayload } from "./commission/local"
import { LOCAL_SKUS, LOCAL_SKU_MAP } from "@lyrashield/pricing"

export interface WebhookDispatchInput {
  provider: string
  event: string
  payload: Record<string, unknown>
}

export interface WebhookDispatchResult {
  handled: boolean
  result?: unknown
  error?: string
}

/**
 * Dispatch a billing webhook event to the appropriate affiliate handler.
 */
export async function dispatch(
  input: WebhookDispatchInput
): Promise<WebhookDispatchResult> {
  const { provider, event, payload } = input

  logger.info("Affiliate webhook dispatch", { provider, event })

  try {
    // Cloud subscription order.paid
    if (event === "order.paid" || event === "subscription.paid") {
      const isLocal = isLocalSkuOrder(payload)

      if (isLocal) {
        const localPayload = mapLocalOrderPayload(provider, payload)
        if (localPayload) {
          const result = await onLocalOrderPaid(localPayload)
          return { handled: true, result }
        }
      } else {
        const orderPayload = mapOrderPaidPayload(provider, payload)
        if (orderPayload) {
          const result = await onOrderPaid(orderPayload)
          return { handled: true, result }
        }
      }
    }

    // Refund / chargeback
    if (event === "order.refunded" || event === "chargeback.created") {
      const reason: ClawbackReason = event === "chargeback.created" ? "CHARGEBACK" : "REFUND"
      const refundPayload = mapRefundPayload(provider, payload, reason)
      if (refundPayload) {
        const result = await onRefund(refundPayload)
        return { handled: true, result }
      }
    }

    // Unhandled event
    return { handled: false }
  } catch (error) {
    logger.error("Affiliate webhook dispatch error", {
      provider,
      event,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      handled: false,
      error: error instanceof Error ? error.message : "Dispatch error",
    }
  }
}

/**
 * Safely access a nested property from a Record<string, unknown>.
 */
function getProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key]
}

function getMetadata(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = payload.metadata
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>
  }
  return undefined
}

/**
 * Check if the order is for a Local SKU (one-time license).
 */
function isLocalSkuOrder(payload: Record<string, unknown>): boolean {
  const meta = getMetadata(payload)
  const skuId = (getProp(payload, "skuId") ?? getProp(payload, "productId") ?? (meta ? getProp(meta, "productId") : undefined)) as
    | string
    | undefined
  if (!skuId) return false
  return skuId in LOCAL_SKU_MAP || LOCAL_SKUS.some((s) => s.id === skuId)
}

/**
 * Map a webhook payload to OrderPaidPayload for Cloud subscriptions.
 */
function mapOrderPaidPayload(
  provider: string,
  payload: Record<string, unknown>
): OrderPaidPayload | null {
  const externalId = (getProp(payload, "id") ?? getProp(payload, "orderId") ?? getProp(payload, "chargeId")) as string | undefined
  if (!externalId) return null

  const meta = getMetadata(payload)

  return {
    provider,
    externalId,
    providerSubscriptionId: (getProp(payload, "subscriptionId") ?? (meta ? getProp(meta, "subscriptionId") : undefined)) as
      | string
      | null
      | undefined,
    customerId: (getProp(payload, "customerId") ?? getProp(payload, "customer") ?? "") as string,
    grossAmount: String(getProp(payload, "amount") ?? getProp(payload, "grossAmount") ?? "0"),
    discountAmount: String(getProp(payload, "discountAmount") ?? getProp(payload, "discount") ?? "0"),
    taxAmount: String(getProp(payload, "taxAmount") ?? getProp(payload, "tax") ?? "0"),
    currency: (getProp(payload, "currency") ?? "USD") as string,
    isAnnual: Boolean(getProp(payload, "isAnnual") ?? (meta ? getProp(meta, "isAnnual") : undefined)),
    planId: (getProp(payload, "planId") ?? (meta ? getProp(meta, "planId") : undefined)) as string | undefined,
    promoCode: (getProp(payload, "promoCode") ?? (meta ? getProp(meta, "promoCode") : undefined)) as string | null | undefined,
    cookieToken: (getProp(payload, "cookieToken") ?? (meta ? getProp(meta, "affToken") : undefined)) as string | null | undefined,
    subid: (getProp(payload, "subid") ?? (meta ? getProp(meta, "subid") : undefined)) as string | null | undefined,
    isFirstPayment: Boolean(getProp(payload, "isFirstPayment") ?? (meta ? getProp(meta, "isFirstPayment") : undefined)),
  }
}

/**
 * Map a webhook payload to LocalOrderPaidPayload for Local licenses.
 */
function mapLocalOrderPayload(
  provider: string,
  payload: Record<string, unknown>
): LocalOrderPaidPayload | null {
  const externalId = (getProp(payload, "id") ?? getProp(payload, "orderId") ?? getProp(payload, "chargeId")) as string | undefined
  if (!externalId) return null

  const meta = getMetadata(payload)
  const skuId = (getProp(payload, "skuId") ?? getProp(payload, "productId") ?? (meta ? getProp(meta, "productId") : undefined)) as string
  if (!skuId) return null

  return {
    provider,
    externalId,
    customerId: (getProp(payload, "customerId") ?? getProp(payload, "customer") ?? "") as string,
    grossAmount: String(getProp(payload, "amount") ?? getProp(payload, "grossAmount") ?? "0"),
    discountAmount: String(getProp(payload, "discountAmount") ?? getProp(payload, "discount") ?? "0"),
    taxAmount: String(getProp(payload, "taxAmount") ?? getProp(payload, "tax") ?? "0"),
    currency: (getProp(payload, "currency") ?? "USD") as string,
    skuId,
    promoCode: (getProp(payload, "promoCode") ?? (meta ? getProp(meta, "promoCode") : undefined)) as string | null | undefined,
    cookieToken: (getProp(payload, "cookieToken") ?? (meta ? getProp(meta, "affToken") : undefined)) as string | null | undefined,
    subid: (getProp(payload, "subid") ?? (meta ? getProp(meta, "subid") : undefined)) as string | null | undefined,
  }
}

/**
 * Map a webhook payload to RefundPayload.
 */
function mapRefundPayload(
  provider: string,
  payload: Record<string, unknown>,
  reason: ClawbackReason
): RefundPayload | null {
  const externalId = (getProp(payload, "id") ?? getProp(payload, "orderId") ?? getProp(payload, "chargeId") ?? getProp(payload, "originalId")) as
    | string
    | undefined
  if (!externalId) return null

  return {
    provider,
    externalId,
    refundAmount: String(getProp(payload, "refundAmount") ?? getProp(payload, "amount") ?? "0"),
    reason,
    isChargeback: reason === "CHARGEBACK",
  }
}
