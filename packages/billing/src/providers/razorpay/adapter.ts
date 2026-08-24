/**
 * Razorpay webhook event adapter.
 *
 * Maps Razorpay webhook events to the same internal billing actions as Polar:
 * - payment.captured → creditTopUp (minute pack purchase)
 * - subscription.activated → syncSubscription (active)
 * - subscription.charged → syncSubscription (active) + grantMonthlyPool
 * - subscription.cancelled → syncSubscription (canceled)
 * - subscription.paused → syncSubscription (paused)
 * - subscription.pending → syncSubscription (past_due)
 * - refund.created → reverseRefund
 */

import { logger } from "@lyrashield/logger"
import type { RazorpayWebhookEvent } from "./webhooks"
import { syncSubscription, type SubscriptionStatus, type BillingInterval } from "../../sync"
import { creditTopUp } from "../../usage/packs"
import { reverseRefund } from "../../usage/refund"
import { MINUTE_PACK_MAP, type CloudPlanId, type PackId } from "@lyrashield/pricing"

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
        return { handled: true, action: "payment_link.paid.received", workspaceId: null }

      case "payment.captured": {
        const payment = event.payload.payment?.entity
        if (!payment) {
          return { handled: false, action: "payment.captured.no_data", workspaceId: null }
        }

        const notes = payment.notes ?? {}
        const workspaceId = notes.workspaceId ?? null
        const packId = notes.packId as PackId | undefined

        if (!workspaceId) {
          logger.warn("Razorpay payment.captured without workspaceId", { paymentId: payment.id })
          return { handled: false, action: "payment.captured.no_workspace", workspaceId: null }
        }

        if (!packId || !MINUTE_PACK_MAP[packId]) {
          logger.warn("Razorpay payment.captured with unknown packId", { packId })
          return { handled: false, action: "payment.captured.unknown_pack", workspaceId }
        }

        const pack = MINUTE_PACK_MAP[packId]
        await creditTopUp(
          workspaceId,
          "razorpay",
          pack.minutes,
          new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000),
          payment.id
        )

        return { handled: true, action: "payment.captured.credited", workspaceId }
      }

      case "subscription.activated":
      case "subscription.charged":
      case "subscription.cancelled":
      case "subscription.paused":
      case "subscription.pending": {
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

        const planId = (notes.plan ?? "STARTER") as CloudPlanId
        const status = mapRazorpaySubscriptionStatus(event.event, subscription.status)
        const interval = (notes.interval ?? "monthly") as BillingInterval

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
          plan: planId,
          status,
          interval,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          canceledAt,
        })

        return { handled: true, action: `subscription.${status}`, workspaceId }
      }

      case "refund.created": {
        const payment = event.payload.payment?.entity
        const refund = event.payload.refund?.entity
        if (!payment || !refund) {
          return { handled: false, action: "refund.created.no_data", workspaceId: null }
        }

        const notes = payment.notes ?? {}
        const workspaceId = notes.workspaceId ?? null
        if (!workspaceId) {
          return { handled: false, action: "refund.created.no_workspace", workspaceId: null }
        }

        await reverseRefund(workspaceId, refund.payment_id)

        return { handled: true, action: "refund.created.reversed", workspaceId }
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
      return "active"
    case "subscription.cancelled":
      return "canceled"
    case "subscription.paused":
      return "paused"
    case "subscription.pending":
      return "past_due"
    default:
      if (rawStatus === "active" || rawStatus === "created" || rawStatus === "authenticated") {
        return "active"
      }
      return "past_due"
  }
}
