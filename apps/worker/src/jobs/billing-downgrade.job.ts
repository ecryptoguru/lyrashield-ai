/**
 * Billing downgrade job.
 *
 * Hourly BullMQ repeatable job that:
 * 1. Queries BillingAccount where status IN ("canceled", "past_due")
 *    AND currentPeriodEnd < now()
 * 2. For each, calls downgradeToFree(workspaceId)
 *
 * This handles the "keep plan until period end, then downgrade to FREE"
 * lifecycle: the webhook sets status to canceled/past_due, but the actual
 * downgrade to FREE happens only after the period ends.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { downgradeToFree } from "@lyrashield/billing"

export const BILLING_DOWNGRADE_QUEUE = "billing-downgrade"

export interface BillingDowngradeJobData {
  scheduledAt: string
}

export interface BillingDowngradeJobResult {
  downgraded: number
  errors: number
}

/**
 * Process the billing downgrade job.
 * Finds all billing accounts that are canceled/past_due and past their
 * period end, and downgrades them to FREE.
 */
export async function processBillingDowngradeJob(
  _data: BillingDowngradeJobData
): Promise<BillingDowngradeJobResult> {
  logger.info("Billing downgrade job started")

  const now = new Date()

  const expiredAccounts = await prisma.billingAccount.findMany({
    where: {
      status: { in: ["canceled", "past_due"] },
      currentPeriodEnd: { lt: now },
    },
    select: { id: true, workspaceId: true, status: true, currentPeriodEnd: true },
  })

  logger.info("Found expired billing accounts to downgrade", {
    count: expiredAccounts.length,
  })

  let downgraded = 0
  let errors = 0

  for (const account of expiredAccounts) {
    try {
      await downgradeToFree(account.workspaceId, `period_ended:${account.status}`)
      downgraded++
      logger.info("Downgraded workspace to FREE", {
        workspaceId: account.workspaceId,
        previousStatus: account.status,
        periodEnd: account.currentPeriodEnd?.toISOString() ?? "null",
      })
    } catch (error) {
      errors++
      logger.error("Failed to downgrade workspace", {
        workspaceId: account.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  logger.info("Billing downgrade job complete", { downgraded, errors })

  return { downgraded, errors }
}
