import { z } from "zod"
import { historicalExpenseReceiptSchema } from "./historical-failed-expense-contract"

const HISTORICAL_SCAN_IDS = ["cmsxsrbmb000001m00cc7e6dx", "cmsxuqxpb000001fhcrr6emat"] as const
const SHA256 = /^[0-9a-f]{64}$/
export const AZURE_RESOURCE_ID =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.(?:OperationalInsights\/workspaces|App\/containerApps|CognitiveServices\/accounts)\/[^/]+$/i
const MAX_EVIDENCE_BUFFER_MS = 5 * 60_000
const terminalStatusSchema = z.enum([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])

const expectedStateSchema = z.object({
  workspaceId: z.string().min(1),
  targetType: z.literal("REPO"),
  status: terminalStatusSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  deletedAt: z.null(),
  providerCostUsd: z.null(),
  billedCostUsd: z.null(),
  llmUsageUnavailableEventCount: z.number().int().nonnegative(),
})

const reviewedScanBaseSchema = z.object({
  scanId: z.enum(HISTORICAL_SCAN_IDS),
  expectedState: expectedStateSchema,
  conclusion: z.object({
    providerCostUsd: z.literal("0.000000"),
    basis: z.string().min(1).max(2_000),
  }),
  azureEvidence: z.object({
    resourceId: z.string().regex(AZURE_RESOURCE_ID),
    timeWindowStart: z.iso.datetime(),
    timeWindowEnd: z.iso.datetime(),
    queryTimestamp: z.iso.datetime(),
    metricTotals: z
      .object({
        providerRequestCount: z.literal(0),
        providerCostUsd: z.literal(0),
      })
      .strict(),
    evidenceSha256: z.string().regex(SHA256),
  }),
})

export const evidenceFileSchema = z
  .object({
    version: z.literal(1),
    scanId: z.enum(HISTORICAL_SCAN_IDS),
    resourceId: z.string().regex(AZURE_RESOURCE_ID),
    timeWindowStart: z.iso.datetime(),
    timeWindowEnd: z.iso.datetime(),
    queryTimestamp: z.iso.datetime(),
    metricTotals: z
      .object({
        providerRequestCount: z.literal(0),
        providerCostUsd: z.literal(0),
      })
      .strict(),
  })
  .strict()

const reviewedScanSchema = reviewedScanBaseSchema.superRefine((scan, context) => {
  const startedAt = Date.parse(scan.expectedState.startedAt)
  const endedAt = Date.parse(scan.expectedState.endedAt)
  const windowStart = Date.parse(scan.azureEvidence.timeWindowStart)
  const windowEnd = Date.parse(scan.azureEvidence.timeWindowEnd)
  if (scan.expectedState.llmUsageUnavailableEventCount === 0) {
    context.addIssue({
      code: "custom",
      path: ["expectedState", "llmUsageUnavailableEventCount"],
      message: "USD 0 disposition requires an llm_usage_unavailable event",
    })
  }
  if (startedAt > endedAt) {
    context.addIssue({ code: "custom", path: ["expectedState"], message: "scan times invalid" })
  }
  if (windowStart > startedAt || windowEnd < endedAt) {
    context.addIssue({
      code: "custom",
      path: ["azureEvidence"],
      message: "Azure evidence window must cover the exact scan execution window",
    })
  }
  if (
    startedAt - windowStart > MAX_EVIDENCE_BUFFER_MS ||
    windowEnd - endedAt > MAX_EVIDENCE_BUFFER_MS
  ) {
    context.addIssue({
      code: "custom",
      path: ["azureEvidence"],
      message: "Azure evidence window buffer must not exceed five minutes per side",
    })
  }
  if (Date.parse(scan.azureEvidence.queryTimestamp) < windowEnd) {
    context.addIssue({
      code: "custom",
      path: ["azureEvidence", "queryTimestamp"],
      message: "query timestamp must be at or after the evidence window",
    })
  }
})

const historicalReceiptSchema = z.object({
  version: z.literal(1),
  environment: z.literal("production"),
  operator: z.object({
    userId: z.string().min(1).max(128),
    email: z.email().max(320).optional(),
  }),
  scans: z.array(reviewedScanSchema).length(HISTORICAL_SCAN_IDS.length),
})

const providerExpenseSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,5})\.\d{10}$/)
  .refine((amount) => amount !== "0.0000000000", "provider expense must be positive")
const failedExpenseScanSchema = reviewedScanBaseSchema
  .extend({
    scanId: z.string().regex(/^c[a-z0-9]{24}$/),
    expectedState: expectedStateSchema.extend({
      status: z.literal("FAILED"),
      providerCostUsd: providerExpenseSchema,
      updatedAt: z.iso.datetime(),
    }),
    conclusion: z
      .object({
        providerCostUsd: providerExpenseSchema,
        customerBilling: z.literal("non_billable_failed_scan"),
        basis: z.string().min(1).max(2_000),
      })
      .strict(),
    azureEvidence: reviewedScanBaseSchema.shape.azureEvidence.extend({
      metricTotals: z
        .object({
          providerRequestCount: z.number().int().positive().max(2_147_483_647),
          providerCostUsd: providerExpenseSchema,
        })
        .strict(),
    }),
  })
  .superRefine((scan, context) => {
    const startedAt = Date.parse(scan.expectedState.startedAt)
    const endedAt = Date.parse(scan.expectedState.endedAt)
    const start = Date.parse(scan.azureEvidence.timeWindowStart)
    const end = Date.parse(scan.azureEvidence.timeWindowEnd)
    if (
      startedAt > endedAt ||
      start > startedAt ||
      end < endedAt ||
      startedAt - start > MAX_EVIDENCE_BUFFER_MS ||
      end - endedAt > MAX_EVIDENCE_BUFFER_MS ||
      Date.parse(scan.azureEvidence.queryTimestamp) < end
    ) {
      context.addIssue({
        code: "custom",
        path: ["azureEvidence"],
        message:
          "provider evidence must cover the exact execution window with at most five minutes buffer",
      })
    }
    if (
      scan.conclusion.providerCostUsd !== scan.expectedState.providerCostUsd ||
      scan.conclusion.providerCostUsd !== scan.azureEvidence.metricTotals.providerCostUsd
    ) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "reviewed expense must match preserved provider cost and provider evidence",
      })
    }
  })

const failedExpenseReceiptSchema = z
  .object({
    version: z.literal(2),
    environment: z.literal("production"),
    operator: historicalReceiptSchema.shape.operator,
    scans: z.array(failedExpenseScanSchema).length(1),
  })
  .strict()
export const receiptSchema = z
  .union([historicalReceiptSchema, failedExpenseReceiptSchema, historicalExpenseReceiptSchema])
  .superRefine((receipt, context) => {
    if (receipt.version !== 1) return
    const scanIds = receipt.scans.map((scan) => scan.scanId)
    if (new Set(scanIds).size !== HISTORICAL_SCAN_IDS.length) {
      context.addIssue({ code: "custom", path: ["scans"], message: "scan IDs must be unique" })
    }
    for (const scanId of HISTORICAL_SCAN_IDS) {
      if (!scanIds.includes(scanId)) {
        context.addIssue({
          code: "custom",
          path: ["scans"],
          message: `missing exact historical scan ${scanId}`,
        })
      }
    }
  })

export type TerminalCostDispositionReceipt = z.infer<typeof receiptSchema>

export const failedExpenseEvidenceFileSchema = evidenceFileSchema.extend({
  version: z.literal(2),
  scanId: z.string().regex(/^c[a-z0-9]{24}$/),
  metricTotals: failedExpenseScanSchema.shape.azureEvidence.shape.metricTotals,
})
