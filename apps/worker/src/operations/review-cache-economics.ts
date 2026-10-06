import { withWorkspaceRLS } from "@lyrashield/db"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import {
  calculateGpt6CostBreakdownFromModelBuckets,
  usdCostsMatch,
  type Gpt6ModelUsageBuckets,
} from "../engine/gpt6-pricing"

const MAX_REPORT_SCANS = 500
const MAX_MYRA_TRACES = 5_000
const MODEL_BUCKET_FIELDS = [
  "standardInputTokens",
  "standardCachedInputTokens",
  "standardCacheWriteInputTokens",
  "standardOutputTokens",
  "longInputTokens",
  "longCachedInputTokens",
  "longCacheWriteInputTokens",
  "longOutputTokens",
] as const satisfies readonly (keyof Omit<Gpt6ModelUsageBuckets, "model">)[]

type ScanCostRow = {
  id: string
  mode: string
  status: string
  events: Array<{ stage: string; metadata: unknown }>
}

type MyraReservationRow = {
  status: string
  actualUsd: unknown
  reservedUsd: unknown
}

type CostGroup = {
  scans: number
  completedScans: number
  incompleteScans: number
  fullyAccountedScans: number
  incompleteAccountingScans: number
  invalidCounterScans: number
  missingUsageScans: number
  missingCostScans: number
  reconciliationMismatchScans: number
  requests: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  modelRateCardCostUsd: number
  cachedInputReadCostUsd: number
  cacheWriteInputCostUsd: number
  uncachedInputCostUsd: number
  outputCostUsd: number
  webSearchCostUsd: number
  cacheMetricsScans: number
  cacheMetricsIncompleteScans: number
  cacheReadCommands: number
  cacheWriteCommands: number
  cacheBytesRead: number
  cacheBytesWritten: number
}

function newGroup(): CostGroup {
  return {
    scans: 0,
    completedScans: 0,
    incompleteScans: 0,
    fullyAccountedScans: 0,
    incompleteAccountingScans: 0,
    invalidCounterScans: 0,
    missingUsageScans: 0,
    missingCostScans: 0,
    reconciliationMismatchScans: 0,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    modelRateCardCostUsd: 0,
    cachedInputReadCostUsd: 0,
    cacheWriteInputCostUsd: 0,
    uncachedInputCostUsd: 0,
    outputCostUsd: 0,
    webSearchCostUsd: 0,
    cacheMetricsScans: 0,
    cacheMetricsIncompleteScans: 0,
    cacheReadCommands: 0,
    cacheWriteCommands: 0,
    cacheBytesRead: 0,
    cacheBytesWritten: 0,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function safeDecimalCost(value: unknown): number | null {
  if (typeof value === "number" || typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const toNumber = value.toNumber
    if (typeof toNumber === "function") {
      try {
        const parsed = toNumber.call(value)
        return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
      } catch {
        return null
      }
    }
  }
  return null
}

function summarizeMyraReservations(
  tracesIncluded: number,
  truncated: boolean,
  rows: MyraReservationRow[]
) {
  let settledCostUsd = 0
  let openReservedUsd = 0
  let settledAccountingIncomplete = 0
  let openAccountingIncomplete = 0
  let settledReservations = 0
  let openReservations = 0
  let releasedReservations = 0
  let unknownStatusReservations = 0

  for (const row of rows) {
    if (row.status === "SETTLED") {
      settledReservations += 1
      const cost = safeDecimalCost(row.actualUsd)
      if (cost === null) settledAccountingIncomplete += 1
      else settledCostUsd += cost
    } else if (row.status === "RESERVED") {
      openReservations += 1
      const cost = safeDecimalCost(row.reservedUsd)
      if (cost === null) openAccountingIncomplete += 1
      else openReservedUsd += cost
    } else if (row.status === "RELEASED") {
      releasedReservations += 1
    } else {
      unknownStatusReservations += 1
    }
  }

  return {
    tracesIncluded,
    reservations: rows.length,
    settledReservations,
    openReservations,
    releasedReservations,
    unknownStatusReservations,
    settledAccountingIncomplete,
    openAccountingIncomplete,
    settledCostUsd:
      truncated || settledAccountingIncomplete > 0 ? null : Number(settledCostUsd.toFixed(8)),
    openReservedUsd:
      truncated || openAccountingIncomplete > 0 ? null : Number(openReservedUsd.toFixed(8)),
    truncated,
  }
}

function modelBuckets(value: unknown): Gpt6ModelUsageBuckets[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null
  const output: Gpt6ModelUsageBuckets[] = []
  for (const item of value) {
    const row = asRecord(item)
    if (typeof row?.model !== "string" || !row.model.trim()) return null
    const bucket: Gpt6ModelUsageBuckets = {
      model: row.model.trim(),
      standardInputTokens: 0,
      standardCachedInputTokens: 0,
      standardCacheWriteInputTokens: 0,
      standardOutputTokens: 0,
      longInputTokens: 0,
      longCachedInputTokens: 0,
      longCacheWriteInputTokens: 0,
      longOutputTokens: 0,
    }
    for (const field of MODEL_BUCKET_FIELDS) {
      const counter = safeCounter(row[field])
      if (counter === null) return null
      bucket[field] = counter
    }
    output.push(bucket)
  }
  return output
}

function addCostGroup(group: CostGroup, row: ScanCostRow): void {
  group.scans += 1
  if (row.status === "COMPLETED") group.completedScans += 1
  else group.incompleteScans += 1

  const triageEvent = row.events.find((event) => event.stage === "ai_security_triage")
  const cacheOperations = asRecord(asRecord(triageEvent?.metadata)?.cacheOperations)
  if (cacheOperations) {
    const metrics = [
      safeCounter(cacheOperations.readCommands),
      safeCounter(cacheOperations.writeCommands),
      safeCounter(cacheOperations.bytesRead),
      safeCounter(cacheOperations.bytesWritten),
    ]
    if (metrics.every((value) => value !== null)) {
      group.cacheMetricsScans += 1
      group.cacheReadCommands += metrics[0]!
      group.cacheWriteCommands += metrics[1]!
      group.cacheBytesRead += metrics[2]!
      group.cacheBytesWritten += metrics[3]!
    } else {
      group.cacheMetricsIncompleteScans += 1
    }
  }

  const usage = asRecord(row.events.find((event) => event.stage === "llm_usage")?.metadata)
  if (!usage) {
    group.missingUsageScans += 1
    group.incompleteAccountingScans += 1
    group.missingCostScans += 1
    return
  }

  const counters = [
    safeCounter(usage.requestCount),
    safeCounter(usage.inputTokens),
    safeCounter(usage.cachedInputTokens),
    safeCounter(usage.cacheWriteInputTokens),
    safeCounter(usage.outputTokens),
  ]
  const countersComplete = counters.every((value) => value !== null)
  if (!countersComplete) {
    group.invalidCounterScans += 1
  } else {
    group.requests += counters[0]!
    group.inputTokens += counters[1]!
    group.cachedInputTokens += counters[2]!
    group.cacheWriteInputTokens += counters[3]!
    group.outputTokens += counters[4]!
  }

  const buckets = modelBuckets(usage.modelPricingBuckets)
  const breakdown = buckets ? calculateGpt6CostBreakdownFromModelBuckets(buckets) : null
  const modelCost = safeCost(usage.modelTokenCostUsd)
  const webSearchCost = safeCost(usage.webSearchCostUsd)
  const modelCostMatches =
    breakdown !== null &&
    modelCost !== null &&
    usdCostsMatch(breakdown.actualRateCardCostUsd, modelCost)
  const accounted =
    usage.accountingComplete === true &&
    countersComplete &&
    modelCostMatches &&
    webSearchCost !== null
  if (accounted && breakdown) {
    group.fullyAccountedScans += 1
    group.modelRateCardCostUsd += breakdown.actualRateCardCostUsd
    group.cachedInputReadCostUsd += breakdown.cachedInputReadUsd
    group.cacheWriteInputCostUsd += breakdown.cacheWriteInputUsd
    group.uncachedInputCostUsd += breakdown.standardInputUsd
    group.outputCostUsd += breakdown.outputUsd
    group.webSearchCostUsd += webSearchCost
  } else {
    group.incompleteAccountingScans += 1
    group.missingCostScans += 1
    if (breakdown && modelCost !== null && !modelCostMatches) {
      group.reconciliationMismatchScans += 1
    }
    if (webSearchCost !== null) group.webSearchCostUsd += webSearchCost
  }
}

function serializeGroup(group: CostGroup): Record<string, number | null> {
  const allCompletedScansAccounted =
    group.completedScans > 0 && group.fullyAccountedScans >= group.completedScans
  const knownTotal = group.modelRateCardCostUsd + group.webSearchCostUsd
  return {
    scans: group.scans,
    completedScans: group.completedScans,
    incompleteScans: group.incompleteScans,
    fullyAccountedScans: group.fullyAccountedScans,
    incompleteAccountingScans: group.incompleteAccountingScans,
    invalidCounterScans: group.invalidCounterScans,
    missingUsageScans: group.missingUsageScans,
    missingCostScans: group.missingCostScans,
    reconciliationMismatchScans: group.reconciliationMismatchScans,
    requests: group.requests,
    inputTokens: group.inputTokens,
    cachedInputTokens: group.cachedInputTokens,
    cacheWriteInputTokens: group.cacheWriteInputTokens,
    outputTokens: group.outputTokens,
    modelRateCardCostUsd: group.modelRateCardCostUsd,
    cachedInputReadCostUsd: group.cachedInputReadCostUsd,
    cacheWriteInputCostUsd: group.cacheWriteInputCostUsd,
    uncachedInputCostUsd: group.uncachedInputCostUsd,
    outputCostUsd: group.outputCostUsd,
    webSearchCostUsd: group.webSearchCostUsd,
    cacheMetricsScans: group.cacheMetricsScans,
    cacheMetricsIncompleteScans: group.cacheMetricsIncompleteScans,
    cacheReadCommands: group.cacheReadCommands,
    cacheWriteCommands: group.cacheWriteCommands,
    cacheBytesRead: group.cacheBytesRead,
    cacheBytesWritten: group.cacheBytesWritten,
    knownTotalVariableCostUsd: knownTotal,
    totalVariableCostUsd: group.missingCostScans === 0 ? knownTotal : null,
    costPerCompletedScanUsd:
      allCompletedScansAccounted && group.incompleteAccountingScans === 0
        ? knownTotal / group.completedScans
        : null,
  }
}

function buildReport(
  workspaceId: string,
  from: Date,
  to: Date,
  rows: ScanCostRow[],
  truncated: boolean,
  limit: number,
  myraGenerationCosts: ReturnType<typeof summarizeMyraReservations>
) {
  const byMode = new Map<string, CostGroup>()
  const total = newGroup()
  for (const row of rows) {
    addCostGroup(total, row)
    const mode = row.mode || "UNKNOWN"
    const group = byMode.get(mode) ?? newGroup()
    addCostGroup(group, row)
    byMode.set(mode, group)
  }
  const totals = serializeGroup(total)
  if (truncated) totals.costPerCompletedScanUsd = null
  return {
    schema: "lyrashield-cache-economics-operator/1.0",
    workspaceId,
    window: { from: from.toISOString(), to: to.toISOString() },
    sample: { scansIncluded: rows.length, maxScans: limit, truncated },
    totals,
    myraGenerationCosts,
    byMode: Object.fromEntries(
      [...byMode.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mode, group]) => {
          const serialized = serializeGroup(group)
          if (truncated) serialized.costPerCompletedScanUsd = null
          return [mode, serialized]
        })
    ),
    cacheOperationCostUsd: null,
    cacheOperationCostStatus: "not_metered",
    limits: [
      "Uses the latest cumulative llm_usage event per scan to avoid double-counting checkpoints.",
      "Costs are GPT-6 published-rate estimates, not provider invoice reconciliation.",
      "Myra reservation costs are private workspace-linked database totals, not provider invoice reconciliation.",
      "Redis operation costs and model phase/agent attribution are not included in these totals.",
      "A truncated sample cannot produce cost-per-completed-scan.",
    ],
  }
}

export async function reviewWorkspaceCacheEconomics(input: {
  workspaceId: string
  from: Date
  to: Date
  maxScans?: number
}) {
  const { workspaceId, from, to, maxScans = MAX_REPORT_SCANS } = input
  if (!workspaceId.trim()) throw new TypeError("workspaceId is required")
  if (!(from instanceof Date) || !Number.isFinite(from.getTime())) {
    throw new TypeError("from must be a valid date")
  }
  if (!(to instanceof Date) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new TypeError("to must be a valid date after from")
  }
  if (!Number.isInteger(maxScans) || maxScans < 1 || maxScans > MAX_REPORT_SCANS) {
    throw new RangeError(`maxScans must be an integer from 1 to ${MAX_REPORT_SCANS}`)
  }

  const sample = await withWorkspaceRLS(workspaceId, async (tx) => {
    const scans = await tx.scan.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        createdAt: { gte: from, lt: to },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: maxScans + 1,
      select: { id: true, mode: true, status: true },
    })
    const rows = scans.slice(0, maxScans)
    const scanIds = rows.map((row) => row.id)
    const events =
      scanIds.length === 0
        ? []
        : await tx.scanEvent.findMany({
            where: {
              scanId: { in: scanIds },
              stage: { in: ["llm_usage", "ai_security_triage"] },
              deletedAt: null,
            },
            orderBy: [{ scanId: "asc" }, { stage: "asc" }, { createdAt: "desc" }, { id: "desc" }],
            distinct: ["scanId", "stage"],
            select: { scanId: true, stage: true, metadata: true },
          })
    const myraMessages = await tx.myraMessage.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        traceId: { not: null },
        conversation: { is: { workspaceId } },
      },
      orderBy: [{ traceId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      distinct: ["traceId"],
      take: MAX_MYRA_TRACES + 1,
      select: { traceId: true },
    })
    const myraTraceIds = myraMessages
      .slice(0, MAX_MYRA_TRACES)
      .map((message) => message.traceId)
      .filter((traceId): traceId is string => typeof traceId === "string" && traceId.length > 0)
    const myraReservations =
      myraTraceIds.length === 0
        ? []
        : await tx.myraGenerationReservation.findMany({
            where: {
              traceId: { in: myraTraceIds },
              createdAt: { gte: from, lt: to },
            },
            select: { status: true, actualUsd: true, reservedUsd: true },
          })
    const myraGenerationCosts = summarizeMyraReservations(
      myraTraceIds.length,
      myraMessages.length > MAX_MYRA_TRACES,
      myraReservations
    )
    const eventsByScan = new Map<string, Array<{ stage: string; metadata: unknown }>>()
    for (const event of events) {
      const existing = eventsByScan.get(event.scanId) ?? []
      existing.push({ stage: event.stage, metadata: event.metadata })
      eventsByScan.set(event.scanId, existing)
    }
    return {
      rows: rows.map((row) => ({ ...row, events: eventsByScan.get(row.id) ?? [] })),
      truncated: scans.length > maxScans,
      myraGenerationCosts,
    }
  })
  return buildReport(
    workspaceId,
    from,
    to,
    sample.rows,
    sample.truncated,
    maxScans,
    sample.myraGenerationCosts
  )
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "workspace-id": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "max-scans": { type: "string" },
    },
    strict: true,
  })
  if (!values["workspace-id"] || !values.from || !values.to) {
    throw new TypeError("usage: --workspace-id ID --from ISO_DATE --to ISO_DATE [--max-scans N]")
  }
  const report = await reviewWorkspaceCacheEconomics({
    workspaceId: values["workspace-id"],
    from: new Date(values.from),
    to: new Date(values.to),
    ...(values["max-scans"] !== undefined ? { maxScans: Number(values["max-scans"]) } : {}),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => {
    process.exitCode = code
  })
}
