import type { Prisma, ScopedTransaction } from "@lyrashield/db"

interface RetainedScanAccounting {
  createdById: string
  sponsorAccountId: string | null
  events: Array<{ metadata: Prisma.JsonValue }>
}

/** Private accounting retains the stored payer after a user hides a terminal scan.
 * Call only inside workspace RLS; public reads keep the ordinary soft-delete guard.
 */
export async function readRetainedScanAccounting(
  tx: ScopedTransaction,
  workspaceId: string,
  scanId: string
): Promise<RetainedScanAccounting | null> {
  const rows = await tx.$queryRaw<RetainedScanAccounting[]>`
    SELECT s."createdById", s."sponsorAccountId",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('metadata', e."metadata"))
        FROM "ScanEvent" e
        WHERE e."scanId" = s."id" AND e."stage" = 'billing_settlement_intent'
          AND e."deletedAt" IS NULL
      ), '[]'::jsonb) AS events
    FROM "Scan" s
    WHERE s."id" = ${scanId} AND s."workspaceId" = ${workspaceId}
      AND s."deletedAt" IS NOT NULL
    LIMIT 1`
  return rows[0] ?? null
}
