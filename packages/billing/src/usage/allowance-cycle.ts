/**
 * Allowance cycle resolution (launch-review remediation F1 / WP-B).
 *
 * A paid subscription owns a *monthly* minute pool per allowance cycle. For
 * monthly plans the provider period IS the cycle: `currentPeriodStart` moves
 * on every renewal webhook. For annual plans the provider period stays fixed
 * for the whole term, so cycles are the monthly anniversaries of the term
 * anchor — `currentPeriodStart` doubles as the anchor and each cycle is
 * computed directly from it (`anchor + k months`), never chained, so a
 * month-end anchor cannot drift (Jan 31 → Feb 28 → Mar 31, not Mar 28).
 *
 * Everything is UTC. A cycle is `[cycleStart, cycleEnd)`; `cycleEnd` is the
 * next anniversary, clamped to `currentPeriodEnd` when the term ends
 * mid-cycle (a canceled annual subscription stops accruing at term end).
 */

export type AllowanceInterval = "monthly" | "annual" | (string & {})

export interface AllowanceCycle {
  /** Inclusive start of the allowance cycle containing `at`. */
  cycleStart: Date
  /** Exclusive end of that cycle (next monthly anniversary, or term end). */
  cycleEnd: Date
  /** The term anchor the cycles are derived from (`currentPeriodStart`). */
  anchor: Date
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * `anchor + months`, clamped to the target month's last day when the anchor
 * day does not exist there (UTC). Computed from the anchor — never chained —
 * so repeated application cannot drift.
 */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear()
  const m = anchor.getUTCMonth()
  const total = m + months
  const targetYear = y + Math.floor(total / 12)
  const targetMonth = ((total % 12) + 12) % 12
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(targetYear, targetMonth))
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds()
    )
  )
}

export interface ResolveAllowanceCycleInput {
  interval: AllowanceInterval | null | undefined
  /** Term anchor: the subscription's `currentPeriodStart`. */
  periodStart: Date
  /** Term end (`currentPeriodEnd`); clamps the final cycle. */
  periodEnd?: Date | null
  /** Evaluation instant (defaults to now). */
  at?: Date
}

/**
 * Resolve the allowance cycle containing `at`.
 *
 * - monthly: the provider period itself (the webhook already moved the anchor).
 * - annual/other intervals with a period longer than a month: monthly
 *   anniversaries of the anchor, bounded by `periodEnd` when known.
 */
export function resolveAllowanceCycle(input: ResolveAllowanceCycleInput): AllowanceCycle {
  const anchor = input.periodStart
  const at = input.at ?? new Date()
  const periodEnd = input.periodEnd ?? null

  if (input.interval !== "annual" && periodEnd !== null) {
    return { cycleStart: anchor, cycleEnd: periodEnd ?? addMonthsClamped(anchor, 1), anchor }
  }

  // Monthly anniversaries inside the annual term.
  const elapsedMs = at.getTime() - anchor.getTime()
  if (elapsedMs < 0) {
    return { cycleStart: anchor, cycleEnd: addMonthsClamped(anchor, 1), anchor }
  }
  const elapsedMonths = Math.floor(elapsedMs / (30.436875 * 24 * 60 * 60 * 1000)) + 2
  // Search a small window around the estimate for the cycle containing `at`.
  let k = Math.max(0, elapsedMonths)
  while (addMonthsClamped(anchor, k).getTime() > at.getTime()) k -= 1
  while (addMonthsClamped(anchor, k + 1).getTime() <= at.getTime()) k += 1

  const cycleStart = addMonthsClamped(anchor, k)
  let cycleEnd = addMonthsClamped(anchor, k + 1)
  if (periodEnd && cycleEnd.getTime() > periodEnd.getTime()) cycleEnd = periodEnd
  return { cycleStart, cycleEnd, anchor }
}

/**
 * Is a further allowance cycle due for this account? Used by the
 * replenishment job and by balance computation to avoid counting grants
 * beyond the paid term.
 */
export function isWithinPaidTerm(input: ResolveAllowanceCycleInput): boolean {
  const at = input.at ?? new Date()
  if (input.periodEnd && at.getTime() >= input.periodEnd.getTime()) return false
  return at.getTime() >= input.periodStart.getTime()
}
