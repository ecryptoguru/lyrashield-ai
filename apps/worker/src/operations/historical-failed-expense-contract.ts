import { z } from "zod"

// One reviewed historical case, not a tolerance policy for current scans.
export const HISTORICAL_FAILED_EXPENSE = {
  scanId: "cmue3iw3s000201hs9zkd26on",
  workspaceId: "cmrtq1zdx00000124rxffgrlg",
  eventId: "cmue3yfph000g0nnt64xf0qrn",
  eventCreatedAt: "2026-09-23T12:57:32.165Z",
  productRevision: "c548418dd673e45145dbd02f6b1a14e33b51767f",
  usageWriterSha256: "14168782281ec28bd6cfa64e14723758434e59f19a078a3381a11f787f59a705",
  scanSchemaSha256: "b41d6073c416af443945c0fac19e8aa1b400ce091b2b4f9b5703a9f2190409b7",
  rawExpenseUsd: "0.5676124550",
  storedExpenseUsd: "0.5676120000",
  roundingDifferenceUsd: "0.0000004550",
} as const

export const HISTORICAL_FAILED_EXPENSE_STAGE = "terminal_cost_legacy_expense_reviewed"
export const HISTORICAL_FAILED_EXPENSE_RECEIPT_TYPE = "terminal_failed_legacy_expense_review_v3"
export const HISTORICAL_FAILED_EXPENSE_AUDIT_ACTION = "terminal_cost.legacy_expense_review_recorded"

const historicalExpenseEvidenceSchema = z
  .object({
    kind: z.literal("scan_bound_historical_engine_usage"),
    eventId: z.literal(HISTORICAL_FAILED_EXPENSE.eventId),
    eventCreatedAt: z.literal(HISTORICAL_FAILED_EXPENSE.eventCreatedAt),
    engineReportedCostUsd: z.literal(HISTORICAL_FAILED_EXPENSE.rawExpenseUsd),
    requestCount: z.literal(428),
    usageMetadataSha256: z.string().regex(/^[0-9a-f]{64}$/),
    productRevision: z.literal(HISTORICAL_FAILED_EXPENSE.productRevision),
    usageWriterSha256: z.literal(HISTORICAL_FAILED_EXPENSE.usageWriterSha256),
    scanSchemaSha256: z.literal(HISTORICAL_FAILED_EXPENSE.scanSchemaSha256),
    storageDecimalPlaces: z.literal(6),
    rounding: z.literal("javascript_toFixed_6"),
    manifestVersion: z.literal(7),
    manifestChecksumState: z.literal("legacy_unavailable"),
    usageEventCount: z.literal(1),
    customerUsageRecordCount: z.literal(0),
    queryTimestamp: z.iso.datetime(),
  })
  .strict()

export const historicalExpenseEvidenceFileSchema = historicalExpenseEvidenceSchema.extend({
  version: z.literal(3),
  scanId: z.literal(HISTORICAL_FAILED_EXPENSE.scanId),
  workspaceId: z.literal(HISTORICAL_FAILED_EXPENSE.workspaceId),
})

export const historicalExpenseReceiptSchema = z
  .object({
    version: z.literal(3),
    environment: z.literal("production"),
    operator: z.object({
      userId: z.string().min(1).max(128),
      email: z.email().max(320).optional(),
    }),
    scans: z
      .array(
        z
          .object({
            scanId: z.literal(HISTORICAL_FAILED_EXPENSE.scanId),
            expectedState: z
              .object({
                workspaceId: z.literal(HISTORICAL_FAILED_EXPENSE.workspaceId),
                targetType: z.literal("REPO"),
                status: z.literal("FAILED"),
                startedAt: z.literal("2026-09-23T12:45:28.404Z"),
                endedAt: z.literal("2026-09-23T12:57:32.463Z"),
                updatedAt: z.literal("2026-09-23T12:57:32.464Z"),
                deletedAt: z.null(),
                providerCostUsd: z.literal(HISTORICAL_FAILED_EXPENSE.storedExpenseUsd),
                billedCostUsd: z.null(),
                actualCostCents: z.null(),
                llmRequestCount: z.literal(428),
                llmUsageUnavailableEventCount: z.literal(0),
              })
              .strict(),
            historicalEvidence: historicalExpenseEvidenceSchema.extend({
              evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
            }),
            conclusion: z
              .object({
                providerCostUsd: z.literal(HISTORICAL_FAILED_EXPENSE.storedExpenseUsd),
                originalEngineReportedCostUsd: z.literal(HISTORICAL_FAILED_EXPENSE.rawExpenseUsd),
                roundingDifferenceUsd: z.literal(HISTORICAL_FAILED_EXPENSE.roundingDifferenceUsd),
                customerBilling: z.literal("non_billable_failed_scan"),
                providerReconciliation: z.literal("unavailable"),
                disposition: z.literal("reviewed_legacy_engine_expense"),
                basis: z.string().min(1).max(2_000),
              })
              .strict(),
          })
          .strict()
      )
      .length(1),
  })
  .strict()
  .superRefine((receipt, context) => {
    const scan = receipt.scans[0]
    if (!scan) return
    // Reproduce the pinned historical writer's Number.toFixed(6), without
    // rewriting either value or introducing tolerance into v2/current records.
    const stored = `${Number(scan.historicalEvidence.engineReportedCostUsd).toFixed(6)}0000`
    const difference =
      BigInt(scan.conclusion.originalEngineReportedCostUsd.replace(".", "")) -
      BigInt(scan.conclusion.providerCostUsd.replace(".", ""))
    if (
      stored !== scan.expectedState.providerCostUsd ||
      difference !== BigInt(scan.conclusion.roundingDifferenceUsd.replace(".", "")) ||
      Date.parse(scan.historicalEvidence.queryTimestamp) < Date.parse(scan.expectedState.endedAt)
    ) {
      context.addIssue({ code: "custom", message: "historical precision contract does not match" })
    }
  })

export type HistoricalExpenseEvidence = z.infer<typeof historicalExpenseEvidenceSchema>
