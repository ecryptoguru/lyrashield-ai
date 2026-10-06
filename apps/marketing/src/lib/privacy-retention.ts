import { MYRA_LIMITS } from "../../../../packages/myra/src/contracts"

function days(value: number): string {
  return `${value} day${value === 1 ? "" : "s"}`
}

export function myraRetentionSummary(): string {
  return `Myra conversation records are retained for ${days(MYRA_LIMITS.conversationRetentionDays)}. Support cases and their related replies are retained for ${days(MYRA_LIMITS.caseRetentionDays)} after case creation. Demo-booking records are retained for ${days(MYRA_LIMITS.bookingRetentionDays)} after creation. Canceled bookings with an outstanding calendar-event cancellation remain until provider cleanup succeeds. Myra audit events are retained for ${days(MYRA_LIMITS.auditRetentionDays)} after creation, then removed by the scheduled retention job.`
}
