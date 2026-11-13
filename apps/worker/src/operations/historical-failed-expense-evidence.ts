import { createHash } from "node:crypto"
import { z } from "zod"
import type { getSystemPrisma } from "@lyrashield/db"
import {
  HISTORICAL_FAILED_EXPENSE,
  type HistoricalExpenseEvidence,
} from "./historical-failed-expense-contract"

const durableFields = [
  "eventId",
  "eventCreatedAt",
  "engineReportedCostUsd",
  "requestCount",
  "usageMetadataSha256",
  "productRevision",
  "manifestVersion",
  "manifestChecksumState",
  "usageEventCount",
  "customerUsageRecordCount",
] as const

export function assertHistoricalExpenseEvidence(
  actual: Record<string, unknown> | null,
  expected: HistoricalExpenseEvidence
): void {
  if (!actual || durableFields.some((field) => actual[field] !== expected[field])) {
    throw new Error("historical usage evidence is unavailable or changed")
  }
}

const usageSchema = z.object({
  engineReportedCostUsd: z.number().finite().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  costSource: z.literal("engine_reported_unreconciled"),
  pricingMethod: z.literal("unavailable"),
  reconciliationStatus: z.literal("unavailable"),
})

type HistoricalEvidenceRow = {
  eventId: string
  eventCreatedAt: Date
  usageMetadataJson: string | null
  productRevision: string | null
  manifestVersion: number | null
  hasStoredChecksumInput: boolean
  usageEventCount: number
  customerUsageRecordCount: number
}

export async function readHistoricalExpenseEvidence(
  prisma: Pick<ReturnType<typeof getSystemPrisma>, "$queryRaw">,
  scanId: string,
  workspaceId: string
): Promise<Record<string, unknown> | null> {
  const rows = await prisma.$queryRaw<HistoricalEvidenceRow[]>`
    SELECT u.id AS "eventId", u."createdAt" AS "eventCreatedAt",
      u.metadata::text AS "usageMetadataJson", m.version AS "manifestVersion",
      m.manifest #>> '{workerExecution,productRevision}' AS "productRevision",
      m."checksumInput" IS NOT NULL AS "hasStoredChecksumInput",
      (SELECT count(*)::int FROM "ScanEvent" e WHERE e."scanId"=s.id
        AND e.stage='llm_usage' AND e."deletedAt" IS NULL) AS "usageEventCount",
      (SELECT count(*)::int FROM "UsageRecord" r
        WHERE (r."accountId"=COALESCE(s."sponsorAccountId",s."createdById")
          OR (r."accountId" IS NULL AND r."workspaceId"=s."workspaceId"))
        AND (r.metadata->>'scanId'=s.id OR r."idempotencyKey" LIKE s."workspaceId" || ':' || s.id || ':%'))
        AS "customerUsageRecordCount"
    FROM "Scan" s JOIN "ScanEvent" u ON u."scanId"=s.id
      AND u.id=${HISTORICAL_FAILED_EXPENSE.eventId} AND u.stage='llm_usage' AND u."deletedAt" IS NULL
    LEFT JOIN "ScanResultManifest" m ON m."scanId"=s.id
    WHERE s.id=${scanId} AND s."workspaceId"=${workspaceId} AND s."deletedAt" IS NULL
  `
  const row = rows[0]
  if (rows.length !== 1 || !row?.usageMetadataJson || row.usageMetadataJson.length > 256_000) {
    return null
  }
  let rawUsage: unknown
  try {
    rawUsage = JSON.parse(row.usageMetadataJson) as unknown
  } catch {
    return null
  }
  const usage = usageSchema.safeParse(rawUsage)
  if (!usage.success) return null
  return {
    eventId: row.eventId,
    eventCreatedAt: row.eventCreatedAt.toISOString(),
    engineReportedCostUsd: usage.data.engineReportedCostUsd.toFixed(10),
    requestCount: usage.data.requestCount,
    // Hash the original PostgreSQL JSONB text; retain its raw numeric amount.
    usageMetadataSha256: createHash("sha256").update(row.usageMetadataJson).digest("hex"),
    productRevision: row.productRevision,
    manifestVersion: row.manifestVersion,
    manifestChecksumState: row.hasStoredChecksumInput ? "available" : "legacy_unavailable",
    usageEventCount: row.usageEventCount,
    customerUsageRecordCount: row.customerUsageRecordCount,
  }
}
