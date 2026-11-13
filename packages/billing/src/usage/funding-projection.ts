import type { ScopedTransaction } from "@lyrashield/db"

/**
 * Legacy agent-minute quantities use sequential pool spillover. Version 2
 * records actual funding because another run may still hold unused pool.
 * Subtract only the v2 non-pool component; never rewrite a historical receipt.
 * Invalid/missing attribution gets no credit back to the available pool.
 */
export async function readReservedFundingProjection(
  tx: ScopedTransaction,
  accountId: string,
  cycleStart: Date | null
): Promise<{ nonPoolMinutes: number; packMinutes: number }> {
  if (!cycleStart) return { nonPoolMinutes: 0, packMinutes: 0 }
  const [row] = await tx.$queryRaw<Array<{ nonPoolMinutes: bigint; packMinutes: bigint }>>`
    SELECT
      COALESCE(SUM(CASE WHEN jsonb_typeof(metadata->'poolMinutes') = 'number'
        AND (metadata->>'poolMinutes')::numeric BETWEEN 0 AND quantity
        THEN quantity - (metadata->>'poolMinutes')::numeric ELSE 0 END), 0)::bigint AS "nonPoolMinutes",
      COALESCE(SUM(CASE WHEN jsonb_typeof(metadata->'packMinutes') = 'number'
        AND (metadata->>'packMinutes')::numeric BETWEEN 0 AND quantity
        THEN (metadata->>'packMinutes')::numeric ELSE 0 END), 0)::bigint AS "packMinutes"
    FROM "UsageRecord"
    WHERE "accountId" = ${accountId} AND "deletedAt" IS NULL
      AND "cycleStart" >= ${cycleStart} AND kind = 'agent_minutes'
      AND metadata->'accountingVersion' = '2'::jsonb`
  return {
    nonPoolMinutes: Number(row?.nonPoolMinutes ?? 0),
    packMinutes: Number(row?.packMinutes ?? 0),
  }
}
