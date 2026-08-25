import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { APPROVED_PLATFORM_ADMIN_EMAILS } from "@lyrashield/config"
import { getSystemPrisma, type ScanStatus } from "@lyrashield/db"
import { z } from "zod"
import {
  TERMINAL_COST_DISPOSITION_RECEIPT_TYPE,
  TERMINAL_COST_DISPOSITION_STAGE,
} from "../operational-health"

const HISTORICAL_SCAN_IDS = ["cmsxsrbmb000001m00cc7e6dx", "cmsxuqxpb000001fhcrr6emat"] as const
const CONFIRMATION_PHRASE = "I AUTHORIZE LYRASHIELD TERMINAL COST DISPOSITION"
const SHA256 = /^[0-9a-f]{64}$/
const AZURE_RESOURCE_ID =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.(?:OperationalInsights\/workspaces|App\/containerApps)\/[^/]+$/i
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

const evidenceFileSchema = z
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

const receiptSchema = z
  .object({
    version: z.literal(1),
    environment: z.literal("production"),
    operator: z.object({
      userId: z.string().min(1).max(128),
      email: z.email().max(320).optional(),
    }),
    scans: z.array(reviewedScanSchema).length(HISTORICAL_SCAN_IDS.length),
  })
  .superRefine((receipt, context) => {
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

export interface TerminalCostScanState {
  workspaceId: string
  targetType: string | null
  status: ScanStatus
  startedAt: string | null
  endedAt: string | null
  deletedAt: string | null
  providerCostUsd: string | null
  billedCostUsd: string | null
  llmUsageUnavailableEventCount: number
}

export interface TerminalCostOperatorState {
  id: string
  email: string
  emailVerified: boolean
  twoFactorEnabled: boolean
  platformRole: string | null
}

export interface TerminalCostDispositionDeps {
  inspectOperator(userId: string): Promise<TerminalCostOperatorState | null>
  inspect(scanId: string): Promise<TerminalCostScanState | null>
  append(
    scans: TerminalCostDispositionReceipt["scans"],
    receipt: {
      receiptHash: string
      reviewed: TerminalCostDispositionReceipt
    }
  ): Promise<Array<{ scanId: string; result: "created" | "existing" }>>
}

export function parseTerminalCostDispositionReceipt(
  value: unknown
): TerminalCostDispositionReceipt {
  return receiptSchema.parse(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function terminalCostDispositionReceiptHash(
  receipt: TerminalCostDispositionReceipt
): string {
  return createHash("sha256").update(canonicalJson(receipt)).digest("hex")
}

function assertUnchanged(
  scanId: string,
  actual: TerminalCostScanState | null,
  expected: TerminalCostDispositionReceipt["scans"][number]["expectedState"]
): void {
  if (!actual) throw new Error(`scan not found: ${scanId}`)
  const fields = Object.keys(expected) as Array<keyof typeof expected>
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `${scanId} changed at ${field}: expected ${String(expected[field])}, got ${String(actual[field])}`
      )
    }
  }
}

function assertOperator(
  actual: TerminalCostOperatorState | null,
  expected: TerminalCostDispositionReceipt["operator"]
): void {
  if (
    !actual ||
    actual.id !== expected.userId ||
    !actual.emailVerified ||
    !actual.twoFactorEnabled ||
    actual.platformRole !== "PLATFORM_OPERATOR" ||
    !APPROVED_PLATFORM_ADMIN_EMAILS.includes(
      actual.email.toLowerCase() as (typeof APPROVED_PLATFORM_ADMIN_EMAILS)[number]
    )
  ) {
    throw new Error("operator must be an approved verified MFA-enabled platform operator")
  }
  if (expected.email && actual.email.toLowerCase() !== expected.email.toLowerCase()) {
    throw new Error("operator email display metadata does not match durable user ID")
  }
}

export async function reviewTerminalCostDisposition(
  input: unknown,
  apply: boolean,
  deps: TerminalCostDispositionDeps
): Promise<{
  overall: "preflight_passed" | "applied"
  receiptHash: string
  scans: Array<{ scanId: string; result: "verified" | "created" | "existing" }>
}> {
  const receipt = parseTerminalCostDispositionReceipt(input)
  const receiptHash = terminalCostDispositionReceiptHash(receipt)
  const results: Array<{
    scanId: string
    result: "verified" | "created" | "existing"
  }> = []

  assertOperator(await deps.inspectOperator(receipt.operator.userId), receipt.operator)

  for (const scan of receipt.scans) {
    assertUnchanged(scan.scanId, await deps.inspect(scan.scanId), scan.expectedState)
    results.push({ scanId: scan.scanId, result: "verified" })
  }

  if (apply) {
    return {
      overall: "applied",
      receiptHash,
      scans: await deps.append(receipt.scans, { receiptHash, reviewed: receipt }),
    }
  }
  return { overall: "preflight_passed", receiptHash, scans: results }
}

export function terminalCostDispositionRecordIds(
  scanId: string,
  receiptHash: string
): {
  eventId: string
  auditId: string
} {
  const id = (kind: "event" | "audit") =>
    createHash("sha256").update(`${kind}:${scanId}:${receiptHash}`).digest("hex")
  return { eventId: id("event"), auditId: id("audit") }
}

function normalizeScanState(scan: {
  workspaceId: string
  target: { type: string } | null
  status: ScanStatus
  startedAt: Date | null
  endedAt: Date | null
  deletedAt: Date | null
  providerCostUsd: { toFixed(digits: number): string } | null
  billedCostUsd: { toFixed(digits: number): string } | null
  _count: { events: number }
}): TerminalCostScanState {
  return {
    workspaceId: scan.workspaceId,
    targetType: scan.target?.type ?? null,
    status: scan.status,
    startedAt: scan.startedAt?.toISOString() ?? null,
    endedAt: scan.endedAt?.toISOString() ?? null,
    deletedAt: scan.deletedAt?.toISOString() ?? null,
    providerCostUsd: scan.providerCostUsd?.toFixed(6) ?? null,
    billedCostUsd: scan.billedCostUsd?.toFixed(6) ?? null,
    llmUsageUnavailableEventCount: scan._count.events,
  }
}

const scanStateSelect = {
  workspaceId: true,
  target: { select: { type: true } },
  status: true,
  startedAt: true,
  endedAt: true,
  deletedAt: true,
  providerCostUsd: true,
  billedCostUsd: true,
  _count: {
    select: {
      events: { where: { stage: "llm_usage_unavailable", deletedAt: null } },
    },
  },
} as const

export function createTerminalCostDispositionDbDeps(
  prisma: ReturnType<typeof getSystemPrisma> = getSystemPrisma()
): TerminalCostDispositionDeps {
  return {
    async inspectOperator(userId) {
      return prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          emailVerified: true,
          twoFactorEnabled: true,
          platformRole: true,
        },
      })
    },
    async inspect(scanId) {
      const scan = await prisma.scan.findUnique({ where: { id: scanId }, select: scanStateSelect })
      return scan ? normalizeScanState(scan) : null
    },
    async append(scanReceipts, receipt) {
      return prisma.$transaction(async (tx) => {
        for (const scanId of [...scanReceipts.map((scan) => scan.scanId)].sort()) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`terminal-cost:${scanId}`}, 0))`
        }
        for (const scanReceipt of scanReceipts) {
          const current = await tx.scan.findUnique({
            where: { id: scanReceipt.scanId },
            select: scanStateSelect,
          })
          assertUnchanged(
            scanReceipt.scanId,
            current ? normalizeScanState(current) : null,
            scanReceipt.expectedState
          )
        }
        const operator = await tx.user.findUnique({
          where: { id: receipt.reviewed.operator.userId },
          select: {
            id: true,
            email: true,
            emailVerified: true,
            twoFactorEnabled: true,
            platformRole: true,
          },
        })
        assertOperator(operator, receipt.reviewed.operator)

        const results: Array<{ scanId: string; result: "created" | "existing" }> = []
        for (const scanReceipt of scanReceipts) {
          const { eventId, auditId } = terminalCostDispositionRecordIds(
            scanReceipt.scanId,
            receipt.receiptHash
          )
          const existing = await tx.scanEvent.findUnique({
            where: { id: eventId },
            select: { metadata: true },
          })
          if (existing) {
            const metadata = existing.metadata as { receiptHash?: string } | null
            if (metadata?.receiptHash !== receipt.receiptHash) {
              throw new Error(`conflicting disposition event for ${scanReceipt.scanId}`)
            }
            const audit = await tx.platformAdminAudit.findUnique({
              where: { id: auditId },
              select: {
                actorUserId: true,
                sessionId: true,
                action: true,
                resourceType: true,
                resourceId: true,
                metadata: true,
              },
            })
            const auditMetadata = audit?.metadata as { receiptHash?: string } | null
            if (
              !audit ||
              audit.actorUserId !== receipt.reviewed.operator.userId ||
              audit.sessionId !== "offline-terminal-cost-review" ||
              audit.action !== "terminal_cost.operator_disposition_recorded" ||
              audit.resourceType !== "scan" ||
              audit.resourceId !== scanReceipt.scanId ||
              auditMetadata?.receiptHash !== receipt.receiptHash
            ) {
              throw new Error(
                `disposition event has mismatched atomic audit for ${scanReceipt.scanId}`
              )
            }
            results.push({ scanId: scanReceipt.scanId, result: "existing" })
            continue
          }

          const metadata = {
            receiptType: TERMINAL_COST_DISPOSITION_RECEIPT_TYPE,
            receiptHash: receipt.receiptHash,
            operator: receipt.reviewed.operator,
            azureEvidence: scanReceipt.azureEvidence,
            expectedState: scanReceipt.expectedState,
            conclusion: scanReceipt.conclusion,
          }
          await tx.platformAdminAudit.create({
            data: {
              id: auditId,
              actorUserId: receipt.reviewed.operator.userId,
              sessionId: "offline-terminal-cost-review",
              action: "terminal_cost.operator_disposition_recorded",
              resourceType: "scan",
              resourceId: scanReceipt.scanId,
              metadata,
            },
          })
          await tx.scanEvent.create({
            data: {
              id: eventId,
              scanId: scanReceipt.scanId,
              stage: TERMINAL_COST_DISPOSITION_STAGE,
              level: "info",
              message: "Operator reviewed terminal provider cost as USD 0",
              metadata,
            },
          })
          results.push({ scanId: scanReceipt.scanId, result: "created" })
        }
        return results
      })
    },
  }
}

export async function verifyTerminalCostEvidenceFiles(
  receipt: TerminalCostDispositionReceipt,
  entries: string[],
  readEvidence: (path: string) => Promise<Uint8Array>
): Promise<void> {
  const paths = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    const scanId = entry.slice(0, separator)
    const path = entry.slice(separator + 1)
    if (
      separator < 1 ||
      !path ||
      !HISTORICAL_SCAN_IDS.includes(scanId as (typeof HISTORICAL_SCAN_IDS)[number])
    ) {
      throw new Error("--evidence-file must use exact <scan-id>=<path> mapping")
    }
    if (paths.has(scanId)) throw new Error(`duplicate evidence file mapping for ${scanId}`)
    paths.set(scanId, path)
  }
  if (paths.size !== HISTORICAL_SCAN_IDS.length) {
    throw new Error("one evidence file mapping is required for each historical scan")
  }
  for (const scan of receipt.scans) {
    const path = paths.get(scan.scanId)
    if (!path) throw new Error(`missing evidence file mapping for ${scan.scanId}`)
    const evidenceBytes = await readEvidence(path)
    const digest = createHash("sha256").update(evidenceBytes).digest("hex")
    if (digest !== scan.azureEvidence.evidenceSha256) {
      throw new Error(`evidence file SHA-256 does not match receipt for ${scan.scanId}`)
    }
    let rawEvidence: unknown
    try {
      rawEvidence = JSON.parse(new TextDecoder().decode(evidenceBytes)) as unknown
    } catch {
      throw new Error(`evidence file is not valid JSON for ${scan.scanId}`)
    }
    const evidence = evidenceFileSchema.parse(rawEvidence)
    const expected = {
      version: 1,
      scanId: scan.scanId,
      resourceId: scan.azureEvidence.resourceId,
      timeWindowStart: scan.azureEvidence.timeWindowStart,
      timeWindowEnd: scan.azureEvidence.timeWindowEnd,
      queryTimestamp: scan.azureEvidence.queryTimestamp,
      metricTotals: scan.azureEvidence.metricTotals,
    }
    if (canonicalJson(evidence) !== canonicalJson(expected)) {
      throw new Error(`evidence file contents do not match receipt for ${scan.scanId}`)
    }
  }
}

export function assertExpectedAzureResourceId(
  receipt: TerminalCostDispositionReceipt,
  expectedResourceId: string
): void {
  if (!AZURE_RESOURCE_ID.test(expectedResourceId)) {
    throw new Error("LOG_ANALYTICS_WORKSPACE_ID must be an exact supported Azure resource ID")
  }
  for (const scan of receipt.scans) {
    if (scan.azureEvidence.resourceId.toLowerCase() !== expectedResourceId.toLowerCase()) {
      throw new Error(`unexpected Azure resource ID for ${scan.scanId}`)
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "receipt-file": { type: "string" },
      "evidence-file": { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      environment: { type: "string" },
      "confirm-production": { type: "string" },
    },
  })
  if (!values["receipt-file"]) throw new Error("--receipt-file is required")
  if (!values["evidence-file"]) throw new Error("--evidence-file is required")
  if (values.apply) {
    if (values.environment !== "production") {
      throw new Error("--apply requires --environment production")
    }
    if (values["confirm-production"] !== CONFIRMATION_PHRASE) {
      throw new Error("--apply requires the exact --confirm-production phrase")
    }
  } else if (values.environment || values["confirm-production"]) {
    throw new Error("production confirmation inputs require --apply")
  }

  // Operator supplies this local receipt path explicitly; schema validation follows before use.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const receipt = JSON.parse(await readFile(values["receipt-file"], "utf8")) as unknown
  const parsedReceipt = parseTerminalCostDispositionReceipt(receipt)
  const expectedAzureResourceId = process.env.LOG_ANALYTICS_WORKSPACE_ID
  if (!expectedAzureResourceId) throw new Error("LOG_ANALYTICS_WORKSPACE_ID is required")
  assertExpectedAzureResourceId(parsedReceipt, expectedAzureResourceId)
  await verifyTerminalCostEvidenceFiles(parsedReceipt, values["evidence-file"], async (path) => {
    // Operator supplies each local evidence path explicitly; only its digest is retained.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFile(path)
  })
  console.log(
    JSON.stringify(
      await reviewTerminalCostDisposition(
        parsedReceipt,
        values.apply,
        createTerminalCostDispositionDbDeps()
      )
    )
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
