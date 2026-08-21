/**
 * Normalized billing domain events.
 *
 * Single normalizer for Polar and Razorpay webhook payloads → a discriminated
 * union consumed by the webhook track executor and the affiliate dispatcher.
 *
 * Fixes finding 18A: both providers emit `refund.created`, which now maps to
 * `refund_completed` — the affiliate clawback path fires from real webhooks
 * (the old string matching on `order.refunded`/`chargeback.created` matched
 * nothing either provider actually sends; `chargeback.created` is still mapped
 * for providers that do emit it).
 *
 * Kind describes the payment shape; productKind describes the catalog class:
 * - kind "local_purchase_paid" = any one-time paid event (Local SKU purchase,
 *   minute pack, or unknown one-time). Track applicability narrows with
 *   productKind: license fulfillment requires productKind "local"; minute
 *   packs are excluded from commissions (C2) via productKind "minute_pack".
 * - kind "subscription_paid" / "subscription_renewed" = recurring payments.
 */

import {
  isLocalSkuOrderPayload,
  isMinutePackOrderPayload,
  extractProductId,
} from "@lyrashield/pricing"
import { parseLocalProductIds } from "./license-fulfillment"

export type BillingProviderName = "polar" | "razorpay"

export type ProductKind = "subscription" | "local" | "minute_pack" | "unknown"

export type NormalizedEventKind =
  | "subscription_paid"
  | "subscription_renewed"
  | "local_purchase_paid"
  | "refund_completed"
  | "entitlement_transitioned"

interface NormalizedEventBase {
  provider: BillingProviderName
  /** Commit-2 resolved delivery identity (WebhookEvent.externalId). */
  deliveryId: string
  orderId: string | null
  paymentId: string | null
  subscriptionId: string | null
  refundId: string | null
  /** Binding is resolved downstream (notes/metadata when present). */
  workspaceId: string | null
  customerId: string | null
  productKind: ProductKind
  occurredAt: Date | null
  rawType: string
  /**
   * Provider-specific resource record for downstream mappers (affiliate).
   * Engine/provider output — treat as untrusted. Never log it raw.
   */
  entity: Record<string, unknown>
}

export interface SubscriptionPaidEvent extends NormalizedEventBase {
  kind: "subscription_paid"
}

export interface SubscriptionRenewedEvent extends NormalizedEventBase {
  kind: "subscription_renewed"
}

export interface LocalPurchasePaidEvent extends NormalizedEventBase {
  kind: "local_purchase_paid"
}

export interface RefundCompletedEvent extends NormalizedEventBase {
  kind: "refund_completed"
}

export interface EntitlementTransitionedEvent extends NormalizedEventBase {
  kind: "entitlement_transitioned"
}

export type NormalizedBillingEvent =
  | SubscriptionPaidEvent
  | SubscriptionRenewedEvent
  | LocalPurchasePaidEvent
  | RefundCompletedEvent
  | EntitlementTransitionedEvent

/** Raw types that carry a completed money reversal. */
const REFUND_RAW_TYPES = new Set(["refund.created", "order.refunded", "chargeback.created"])

/** Raw types that are paid (money-in) events. */
const PAID_RAW_TYPES = new Set([
  "order.paid",
  "subscription.paid",
  "payment.captured",
  "subscription.charged",
])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value || null
  if (value && typeof value === "object" && "id" in value) return str((value as { id: unknown }).id)
  return null
}

function parseOccurredAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Razorpay timestamps are Unix seconds; large values are treated as ms.
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

interface ProviderFacts {
  entity: Record<string, unknown>
  refundEntity: Record<string, unknown>
  orderEntity: Record<string, unknown>
  paymentEntity: Record<string, unknown>
  subscriptionEntity: Record<string, unknown>
  metaBag: Record<string, unknown> | undefined
  occurredAt: Date | null
}

function extractFacts(provider: BillingProviderName, payload: unknown): ProviderFacts {
  if (provider === "polar") {
    // Polar: { type, data } — the order/refund/subscription object IS data.
    const data = asRecord(asRecord(payload).data)
    return {
      entity: data,
      refundEntity: data,
      orderEntity: data,
      paymentEntity: {},
      subscriptionEntity: data,
      metaBag: asRecord(data.metadata ?? data.notes),
      occurredAt: parseOccurredAt(data.created_at ?? data.createdAt),
    }
  }
  // Razorpay: { event, created_at, payload: { <resource>: { entity } } }
  const rp = asRecord(payload)
  const sections = asRecord(rp.payload)
  const paymentEntity = asRecord(asRecord(sections.payment).entity)
  const refundEntity = asRecord(asRecord(sections.refund).entity)
  const orderEntity = asRecord(asRecord(sections.order).entity)
  const subscriptionEntity = asRecord(asRecord(sections.subscription).entity)
  const primary =
    Object.keys(refundEntity).length > 0
      ? refundEntity
      : Object.keys(paymentEntity).length > 0
        ? paymentEntity
        : Object.keys(subscriptionEntity).length > 0
          ? subscriptionEntity
          : orderEntity
  return {
    entity: primary,
    refundEntity,
    orderEntity,
    paymentEntity,
    subscriptionEntity,
    metaBag: asRecord(primary.metadata ?? primary.notes),
    occurredAt: parseOccurredAt(rp.created_at),
  }
}

/**
 * Whether the entity's product id maps to a Local SKU through the
 * POLAR_LOCAL_PRODUCT_IDS env map (Polar sells under provider product UUIDs,
 * not catalog ids — same resolution the license fulfillment path uses).
 */
function isProviderMappedLocalProduct(entity: Record<string, unknown>): boolean {
  const productId = extractProductId(entity)
  if (!productId) return false
  return Object.values(parseLocalProductIds()).includes(productId)
}

function detectProductKind(facts: ProviderFacts, hasSubscriptionContext: boolean): ProductKind {
  const entity = facts.entity
  if (isLocalSkuOrderPayload(entity) || isProviderMappedLocalProduct(entity)) return "local"
  if (isMinutePackOrderPayload(entity)) return "minute_pack"
  if (
    hasSubscriptionContext ||
    str(facts.metaBag?.plan_id) ||
    str(facts.metaBag?.planId) ||
    str(facts.metaBag?.plan)
  ) {
    return "subscription"
  }
  return "unknown"
}

/**
 * Normalize a validated provider webhook into a domain event.
 *
 * @param input.provider - validated provider name
 * @param input.eventType - raw provider event type (e.g. "refund.created")
 * @param input.payload - validated provider payload (untrusted content)
 * @param input.deliveryId - commit-2 resolved delivery identity
 */
export function normalizeProviderEvent(input: {
  provider: BillingProviderName
  eventType: string
  payload: unknown
  deliveryId: string
}): NormalizedBillingEvent {
  const { provider, eventType, payload, deliveryId } = input
  const facts = extractFacts(provider, payload)

  const hasSubscriptionContext =
    provider === "polar"
      ? Boolean(str(facts.entity.subscription_id) ?? str(facts.metaBag?.subscriptionId))
      : Object.keys(facts.subscriptionEntity).length > 0

  const base = {
    provider,
    deliveryId,
    // Original order reference wins over the entity row id (refund rows carry
    // their own id but reference the original order via order_id). Recurring
    // Razorpay charges have no order — the payment id keeps fulfillment
    // idempotent per cycle.
    orderId:
      str(facts.entity.order_id) ??
      str(facts.orderEntity.id) ??
      str(facts.paymentEntity.order_id) ??
      str(facts.metaBag?.orderId) ??
      str(facts.paymentEntity.id),
    paymentId: str(facts.paymentEntity.id),
    subscriptionId:
      str(facts.subscriptionEntity.id) ??
      str(facts.entity.subscription_id) ??
      str(facts.metaBag?.subscriptionId),
    refundId: REFUND_RAW_TYPES.has(eventType)
      ? (str(facts.refundEntity.id) ?? str(facts.entity.id))
      : null,
    workspaceId: str(facts.metaBag?.workspaceId),
    customerId:
      idOf(facts.entity.customer) ??
      str(facts.entity.customer_id) ??
      str(facts.entity.customerId) ??
      str(facts.metaBag?.customerId),
    productKind: detectProductKind(facts, hasSubscriptionContext),
    occurredAt: facts.occurredAt,
    rawType: eventType,
    entity: facts.entity,
  }

  if (REFUND_RAW_TYPES.has(eventType)) {
    return { kind: "refund_completed", ...base }
  }

  if (PAID_RAW_TYPES.has(eventType)) {
    if (base.productKind !== "subscription") {
      // One-time paid shape: Local SKU purchase, minute pack (C2-excluded from
      // commissions via productKind), or an unrecognized one-time product.
      return { kind: "local_purchase_paid", ...base }
    }
    const isFirstPayment = Boolean(facts.metaBag?.isFirstPayment)
    return isFirstPayment
      ? { kind: "subscription_paid", ...base }
      : { kind: "subscription_renewed", ...base }
  }

  // Everything else is a lifecycle/entitlement transition (created, active,
  // canceled, paused, past_due, state_changed, …).
  return { kind: "entitlement_transitioned", ...base }
}
