/**
 * Razorpay webhook event adapter.
 *
 * Maps Razorpay webhook events to the same internal billing actions as Polar:
 * - payment.captured → creditTopUp (minute pack purchase)
 * - subscription.activated → syncSubscription (active)
 * - subscription.charged → syncSubscription (active) + grantMonthlyPool
 * - subscription.authenticated → durable receipt only; no entitlement
 * - subscription.halted → syncSubscription (past_due)
 * - subscription.cancelled → syncSubscription (canceled)
 * - subscription.paused → syncSubscription (paused)
 * - subscription.pending → syncSubscription (past_due)
 * - subscription.resumed → syncSubscription (active)
 * - subscription.completed → downgradeToFree (ended; no paid access)
 * - subscription.updated → validate receipt/binding only; no inferred state
 * - refund.created → reverseRefund only for a proven full minute-pack refund
 */

import { logger } from "@lyrashield/logger"
import type { RazorpayWebhookEvent } from "./webhooks"
import { downgradeToFree, syncSubscription, type SubscriptionStatus } from "../../sync"
import { creditTopUp } from "../../usage/packs"
import { reverseRefund } from "../../usage/refund"
import { MINUTE_PACK_MAP } from "@lyrashield/pricing"
import { resolveRazorpayCatalogEvent } from "../../provider-catalog-validation"
import { classifyProviderRefundEvidence } from "../../refund-evidence"

export interface RazorpayAdapterResult {
  handled: boolean
  action: string
  workspaceId: string | null
}

/**
 * Process a validated Razorpay webhook event.
 */
export async function processRazorpayEvent(
  event: RazorpayWebhookEvent
): Promise<RazorpayAdapterResult> {
  try {
    switch (event.event) {
      case "payment_link.paid":
        // Local license and affiliate effects run in their dedicated required
        // tracks. Billing records receipt without granting cloud entitlement.
        if (
          !resolveRazorpayCatalogEvent(event.event, event as unknown as Record<string, unknown>)
        ) {
          return { handled: false, action: "payment_link.paid.unrelated", workspaceId: null }
        }
        return { handled: true, action: "payment_link.paid.received", workspaceId: null }

      case "payment.captured": {
        const payment = event.payload.payment?.entity
        if (!payment) {
          return { handled: false, action: "payment.captured.no_data", workspaceId: null }
        }

        const notes = payment.notes ?? {}
        const workspaceId = notes.workspaceId ?? null

        if (!workspaceId) {
          logger.warn("Razorpay payment.captured without workspaceId", { paymentId: payment.id })
          return { handled: false, action: "payment.captured.no_workspace", workspaceId: null }
        }

        const catalog = resolveRazorpayCatalogEvent(
          event.event,
          event as unknown as Record<string, unknown>
        )
        if (!catalog) {
          return { handled: false, action: "payment.captured.non_pack", workspaceId }
        }
        if (catalog.kind !== "pack") throw new Error("razorpay_pack_catalog_mismatch")
        const pack = MINUTE_PACK_MAP[catalog.packId]
        await creditTopUp(
          workspaceId,
          "razorpay",
          pack.minutes,
          new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000),
          payment.id
        )

        return { handled: true, action: "payment.captured.credited", workspaceId }
      }

      case "subscription.authenticated":
      case "subscription.activated":
      case "subscription.charged":
      case "subscription.pending":
      case "subscription.halted":
      case "subscription.paused":
      case "subscription.resumed":
      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.updated": {
        const subscription = event.payload.subscription?.entity
        if (!subscription) {
          return { handled: false, action: "subscription.no_data", workspaceId: null }
        }

        const notes = subscription.notes ?? {}
        const workspaceId = notes.workspaceId ?? null
        if (!workspaceId) {
          logger.warn("Razorpay subscription event without workspaceId", {
            event: event.event,
            subscriptionId: subscription.id,
          })
          return { handled: false, action: "subscription.no_workspace", workspaceId: null }
        }

        const catalog = resolveRazorpayCatalogEvent(
          event.event,
          event as unknown as Record<string, unknown>
        )
        if (catalog?.kind !== "plan") throw new Error("razorpay_subscription_catalog_mismatch")

        // These deliveries are evidence-bearing but must not create or alter
        // entitlement: authentication has not charged the customer and
        // `updated` has no unambiguous lifecycle meaning.
        if (
          event.event === "subscription.authenticated" ||
          event.event === "subscription.updated"
        ) {
          return { handled: true, action: `${event.event}.recorded`, workspaceId }
        }

        if (event.event === "subscription.completed") {
          await downgradeToFree(workspaceId, "subscription.completed")
          return { handled: true, action: "subscription.ended", workspaceId }
        }
        const status = mapRazorpaySubscriptionStatus(event.event, subscription.status)

        const periodStart = subscription.current_start
          ? new Date(subscription.current_start * 1000)
          : undefined
        const periodEnd = subscription.current_end
          ? new Date(subscription.current_end * 1000)
          : undefined
        const canceledAt = subscription.ended_at
          ? new Date(subscription.ended_at * 1000)
          : undefined

        await syncSubscription({
          workspaceId,
          provider: "razorpay",
          externalId: subscription.id,
          plan: catalog.plan,
          status,
          interval: catalog.interval,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          canceledAt,
        })

        return { handled: true, action: `subscription.${status}`, workspaceId }
      }

      case "refund.created": {
        const evidence = classifyProviderRefundEvidence({
          provider: "razorpay",
          eventType: event.event,
          payload: event,
        })
        if (evidence.classification !== "full") {
          return {
            handled: true,
            action: "refund.created.not_full_recorded",
            workspaceId: evidence.workspaceId,
          }
        }
        if (evidence.purchaseKind !== "minute_pack") {
          return {
            handled: true,
            action: "refund.created.full_recorded",
            workspaceId: evidence.workspaceId,
          }
        }
        if (!evidence.workspaceId || !evidence.paymentId || !evidence.refundId) {
          return { handled: false, action: "refund.created.no_identity", workspaceId: null }
        }
        await reverseRefund(evidence.workspaceId, evidence.paymentId, evidence.refundId)
        return {
          handled: true,
          action: "refund.created.reversed",
          workspaceId: evidence.workspaceId,
        }
      }

      default:
        logger.debug("Unhandled Razorpay event", { event: event.event })
        return { handled: false, action: "unhandled", workspaceId: null }
    }
  } catch (error) {
    logger.error("Failed to process Razorpay event", {
      event: event.event,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function mapRazorpaySubscriptionStatus(eventType: string, rawStatus: string): SubscriptionStatus {
  switch (eventType) {
    case "subscription.activated":
    case "subscription.charged":
    case "subscription.resumed":
      return "active"
    case "subscription.cancelled":
      return "canceled"
    case "subscription.paused":
      return "paused"
    case "subscription.pending":
    case "subscription.halted":
      return "past_due"
    default:
      // No unknown lifecycle event may grant entitlement. Callers handle
      // receipt-only event types before reaching this guard.
      void rawStatus
      return "past_due"
  }
}
