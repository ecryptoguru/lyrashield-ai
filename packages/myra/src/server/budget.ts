/**
 * Monthly generation budget — server-enforced. Spend is recorded as
 * `myra.generate` audit events with `metadata.costUsd`; the cap comes from
 * MYRA_LIMITS.monthlyBudgetUsd, overridable via MYRA_MONTHLY_BUDGET_USD.
 */
import { prisma } from "@lyrashield/db"
import { MYRA_LIMITS } from "../contracts"
import { auditEvent } from "./audit"
import type { MyraDb } from "./db"

export interface BudgetState {
  allowed: boolean
  spentUsd: number
  capUsd: number
}

export function monthlyBudgetCapUsd(): number {
  const override = Number(process.env.MYRA_MONTHLY_BUDGET_USD)
  return Number.isFinite(override) && override > 0 ? override : MYRA_LIMITS.monthlyBudgetUsd
}

export async function checkBudget(db: MyraDb = prisma): Promise<BudgetState> {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const rows = await db.myraAuditEvent.findMany({
    where: { action: "myra.generate", createdAt: { gte: monthStart } },
    select: { metadata: true },
  })
  let spentUsd = 0
  for (const row of rows) {
    const meta = row.metadata as { costUsd?: unknown } | null
    const cost = typeof meta?.costUsd === "number" ? meta.costUsd : 0
    spentUsd += cost
  }
  const capUsd = monthlyBudgetCapUsd()
  return { allowed: spentUsd < capUsd, spentUsd, capUsd }
}

export async function recordCost(
  traceId: string,
  costUsd: number,
  fields: { accountId?: string | null; publicSessionId?: string | null } = {},
  db: MyraDb = prisma
): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  await auditEvent(
    fields.accountId ? "user" : fields.publicSessionId ? "public_session" : "system",
    {
      accountId: fields.accountId ?? null,
      publicSessionId: fields.publicSessionId ?? null,
      action: "myra.generate",
      resourceType: "trace",
      resourceId: traceId,
      metadata: { costUsd },
    },
    db
  )
}
