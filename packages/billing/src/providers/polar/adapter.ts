/**
 * Polar webhook event adapter.
 *
 * Maps Polar webhook events to internal billing actions:
 * - order.paid → creditTopUp (minute pack purchase)
 * - subscription.* → syncSubscription
 * - customer.state_changed → syncSubscription
 *
 * The adapter extracts workspaceId from the event metadata (set at checkout time)
 * and dispatches to the appropriate billing function.
 */

import { logger } from "@lyrashield/logger"
import type { PolarWebhookEvent } from "./webhooks"
import { syncSubscription, downgradeToFree, type SubscriptionStatus } from "../../sync"
import { creditTopUp } from "../../usage/packs"
import { reverseRefund } from "../../usage/refund"
import { MINUTE_PACK_MAP } from "@lyrashield/pricing"
import { resolvePolarCatalogEvent } from "../../provider-catalog-validation"

export interface PolarAdapterResult {
  handled: boolean
  action: string
  workspaceId: string | null
}

/**
 * Process a validated Polar webhook event.
 */
export async function processPolarEvent(event: PolarWebhookEvent): Promise<PolarAdapterResult> {
  const data = event.data
  const metadata = (data.metadata ?? {}) as Record<string, string>
  const workspaceId = metadata.workspaceId ?? null

  try {
    switch (event.type) {
      case "order.paid": {
        // One-time purchase (minute pack)
        if (!workspaceId) {
          logger.warn("Polar order.paid without workspaceId metadata", { eventId: data.id })
          return { handled: false, action: "order.paid.no_workspace", workspaceId: null }
        }

        const catalog = resolvePolarCatalogEvent(event.type, data)
        if (catalog?.kind !== "pack") {
          return { handled: true, action: "order.paid.received", workspaceId }
        }

        const pack = MINUTE_PACK_MAP[catalog.packId]
        const externalId = String(data.id ?? "")

        await creditTopUp(
          workspaceId,
          "polar",
          pack.minutes,
          new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000),
          externalId
        )

        return { handled: true, action: "order.paid.credited", workspaceId }
      }

      case "subscription.created":
      case "subscription.updated":
      case "subscription.active":
      case "subscription.paused":
      case "subscription.resumed":
      case "subscription.past_due":
      case "subscription.canceled":
      case "subscription.revoked":
      case "subscription.uncanceled": {
        if (!workspaceId) {
          logger.warn("Polar subscription event without workspaceId metadata", {
            type: event.type,
          })
          return { handled: false, action: "subscription.no_workspace", workspaceId: null }
        }

        const catalog = resolvePolarCatalogEvent(event.type, data)
        if (catalog?.kind !== "plan") throw new Error("polar_subscription_catalog_mismatch")
        const status = mapPolarSubscriptionStatus(event.type, data)

        const currentPeriodStart = data.current_period_start ?? data.currentPeriodStart
        const currentPeriodEnd = data.current_period_end ?? data.currentPeriodEnd
        const canceledAtValue = data.canceled_at ?? data.canceledAt
        const periodStart = currentPeriodStart ? new Date(currentPeriodStart as string) : undefined
        const periodEnd = currentPeriodEnd ? new Date(currentPeriodEnd as string) : undefined
        const canceledAt = canceledAtValue ? new Date(canceledAtValue as string) : undefined

        await syncSubscription({
          workspaceId,
          provider: "polar",
          externalId: String(data.id ?? ""),
          plan: catalog.plan,
          status,
          interval: catalog.interval,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          canceledAt,
        })

        return { handled: true, action: `subscription.${status}`, workspaceId }
      }

      case "customer.state_changed": {
        // Customer state changes (e.g. blocked) — sync subscription state
        if (!workspaceId) {
          return {
            handled: false,
            action: "customer.state_changed.no_workspace",
            workspaceId: null,
          }
        }

        const state = (data.state ?? "active") as string
        if (state === "blocked" || state === "deleted") {
          // Downgrade to FREE directly — blocked/deleted customers should
          // not retain any paid plan entitlements.
          await downgradeToFree(workspaceId, `customer.${state}`)
        }

        return { handled: true, action: `customer.state_changed.${state}`, workspaceId }
      }

      case "refund.created": {
        // Refund — reverse the entitlement.
        // Polar refund events include data.order_id — use the original order ID
        // (not the refund ID) so reverseRefund can find the MinutePack by
        // its externalId (which was set to the order ID at purchase time).
        if (!workspaceId) {
          return { handled: false, action: "refund.no_workspace", workspaceId: null }
        }

        const orderId = String(data.order_id ?? data.id ?? "")
        await reverseRefund(workspaceId, orderId)

        return { handled: true, action: "refund.reversed", workspaceId }
      }

      default:
        logger.debug("Unhandled Polar event type", { type: event.type })
        return { handled: false, action: "unhandled", workspaceId }
    }
  } catch (error) {
    logger.error("Failed to process Polar event", {
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function mapPolarSubscriptionStatus(
  eventType: string,
  data: Record<string, unknown>
): SubscriptionStatus {
  const status = (data.status ?? "active") as string

  switch (eventType) {
    case "subscription.revoked":
      return "canceled"
    case "subscription.uncanceled":
    case "subscription.resumed":
      return "active"
    case "subscription.active":
      return "active"
    case "subscription.paused":
      return "paused"
    case "subscription.past_due":
      return "past_due"
    case "subscription.canceled":
      return data.status === "active" ? "active" : "canceled"
    default:
      if (
        status === "active" ||
        status === "canceled" ||
        status === "paused" ||
        status === "past_due" ||
        status === "incomplete" ||
        status === "trialing"
      ) {
        return status as SubscriptionStatus
      }
      // Fail-closed: unknown status defaults to past_due, not active.
      // This prevents a malformed/unexpected event from silently granting
      // full access when the subscription state is ambiguous.
      return "past_due"
  }
}
