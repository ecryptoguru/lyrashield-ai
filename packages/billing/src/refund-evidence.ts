import {
  extractProductId,
  isLocalSkuOrderPayload,
  isMinutePackOrderPayload,
} from "@lyrashield/pricing"
import { parseLocalProductIds } from "./license-fulfillment"
import type { BillingProviderName, ProductKind } from "./domain-events"

export type RefundClassification = "full" | "partial" | "unknown"

export interface ProviderRefundEvidence {
  classification: RefundClassification
  purchaseKind: ProductKind
  workspaceId: string | null
  orderId: string | null
  paymentId: string | null
  refundId: string | null
  currency: "USD" | "INR" | null
  amountMinor: bigint | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function minor(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  }
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null
}

function currency(value: unknown): "USD" | "INR" | null {
  if (typeof value !== "string") return null
  const code = value.toUpperCase()
  return code === "USD" || code === "INR" ? code : null
}

function purchaseKind(entity: Record<string, unknown>): ProductKind {
  if (isMinutePackOrderPayload(entity)) return "minute_pack"
  if (isLocalSkuOrderPayload(entity)) return "local"
  const productId = extractProductId(entity)
  if (productId && Object.values(parseLocalProductIds()).includes(productId)) return "local"
  const metadata = record(entity.metadata ?? entity.notes)
  if (
    string(entity.subscription_id) ??
    string(metadata.subscriptionId) ??
    string(metadata.plan_id) ??
    string(metadata.planId) ??
    string(metadata.plan)
  ) {
    return "subscription"
  }
  return "unknown"
}

/** Classify signed refund evidence before any entitlement or affiliate mutation. */
export function classifyProviderRefundEvidence(input: {
  provider: BillingProviderName
  eventType: string
  payload: unknown
}): ProviderRefundEvidence {
  const root = record(input.payload)

  if (input.provider === "polar") {
    const order = record(root.data)
    const metadata = record(order.metadata)
    const status = string(order.status)
    const amountMinor = minor(order.total_amount ?? order.totalAmount)
    const orderCurrency = currency(order.currency)
    return {
      classification:
        input.eventType === "order.refunded" &&
        status === "refunded" &&
        amountMinor !== null &&
        orderCurrency !== null
          ? "full"
          : input.eventType === "order.refunded" && status === "partially_refunded"
            ? "partial"
            : "unknown",
      purchaseKind: purchaseKind(order),
      workspaceId: string(metadata.workspaceId),
      orderId: string(order.id),
      paymentId: null,
      refundId: string(order.refund_id ?? order.refundId) ?? string(root.id),
      currency: orderCurrency,
      amountMinor,
    }
  }

  const sections = record(root.payload)
  const payment = record(record(sections.payment).entity)
  const refund = record(record(sections.refund).entity)
  const metadata = record(payment.notes ?? payment.metadata)
  const paymentAmount = minor(payment.amount)
  const refundedAmount = minor(payment.amount_refunded ?? payment.amountRefunded)
  const refundAmount = minor(refund.amount)
  const paymentCurrency = currency(payment.currency)
  const refundCurrency = currency(refund.currency)
  const processed = string(refund.status) === "processed"
  const cumulativeFull =
    paymentAmount !== null &&
    paymentAmount > 0n &&
    refundedAmount !== null &&
    refundAmount !== null &&
    paymentAmount === refundedAmount &&
    refundAmount > 0n &&
    refundAmount <= paymentAmount
  const currenciesMatch = paymentCurrency !== null && paymentCurrency === refundCurrency
  const cumulativePartial =
    processed &&
    paymentAmount !== null &&
    paymentAmount > 0n &&
    refundedAmount !== null &&
    refundedAmount > 0n &&
    refundedAmount < paymentAmount &&
    refundAmount !== null &&
    refundAmount > 0n &&
    refundAmount <= refundedAmount &&
    currenciesMatch
  const classification: RefundClassification =
    input.eventType === "refund.created" &&
    processed &&
    string(payment.refund_status ?? payment.refundStatus) === "full" &&
    cumulativeFull &&
    currenciesMatch
      ? "full"
      : input.eventType === "refund.created" && cumulativePartial
        ? "partial"
        : "unknown"

  return {
    classification,
    purchaseKind: purchaseKind({ ...payment, notes: metadata }),
    workspaceId: string(metadata.workspaceId),
    orderId: string(payment.order_id ?? payment.orderId),
    paymentId: string(payment.id) ?? string(refund.payment_id ?? refund.paymentId),
    refundId: string(refund.id),
    currency: currenciesMatch ? paymentCurrency : null,
    amountMinor: classification === "full" ? paymentAmount : refundAmount,
  }
}
