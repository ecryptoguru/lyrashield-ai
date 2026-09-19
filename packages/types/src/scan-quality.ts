/**
 * Truthful scan-quality surface — a bounded, deterministic projection of what
 * a scan actually did, derived only from stored scan evidence (coverage
 * receipts, finding verification tiers, the result manifest). Nothing here is
 * a model claim, an upstream benchmark, or an accuracy guarantee: every
 * `facts` value is a direct count/read of persisted rows, and every
 * `estimates` value is labeled heuristic with its basis stated.
 *
 * The `parity` table publishes what each client surface reports for the same
 * scan, so a CLI user and a dashboard user can prove they see the same
 * evidence — and a surface that does not report a field says so instead of
 * implying coverage.
 */
import { z } from "zod"

export const SCAN_QUALITY_SURFACE_VERSION = "lyrashield-scan-quality/1.0.0" as const

// ── Input: stored evidence only ─────────────────────────────────────────────

export interface ScanQualityReceiptInput {
  scanner: string
  controlId: string
  status: string
  reason?: string | null
  metadata?: Record<string, unknown> | null
}

export interface ScanQualityFindingInput {
  /** Authoritative verification tier; absent/unknown counts as unlabeled. */
  verificationStatus?: string | null
  severity?: string | null
}

export interface ScanQualityInput {
  scan: {
    status: string
    mode: string
    determinismMode?: string | null
    durationMs?: number | null
    llmRequestCount?: number | null
  }
  receipts: ScanQualityReceiptInput[]
  findings: ScanQualityFindingInput[]
  manifestChecksum?: string | null
  ingestionWarnings?: string[]
  attachments?: { count: number; totalBytes: number } | null
}

// ── Output: measured facts + labeled heuristics + parity ────────────────────

export interface LabeledEstimate {
  kind: "heuristic"
  value: number | null
  /** What the estimate is computed over — never implied certainty. */
  basis: string
}

export interface ScanQualitySurface {
  version: typeof SCAN_QUALITY_SURFACE_VERSION
  /** Measured facts — direct counts/reads of stored evidence rows. */
  facts: {
    scanStatus: string
    scanMode: string
    deterministicRun: boolean
    durationMs: number | null
    llmRequests: number | null
    findings: {
      total: number
      byVerificationStatus: Record<string, number>
      bySeverity: Record<string, number>
      validatedCount: number
      verifiedCount: number
      nonConclusiveCount: number
    }
    coverage: {
      receiptsTotal: number
      byStatus: Record<string, number>
      byScanner: Record<string, number>
      /** engine-scope:/engine-gap: receipts — model-declared, not measured outcomes. */
      engineDeclaredReceipts: number
      connectorReceipts: number
    }
    evidence: {
      manifestPresent: boolean
      manifestChecksum: string | null
      ingestionWarningCount: number
      attachmentCount: number | null
    }
  }
  /** Derived ratios — heuristic only, each carrying its basis. */
  estimates: {
    assessedReceiptRatio: LabeledEstimate
    verifiedFindingRatio: LabeledEstimate
  }
  parity: ScanSurfaceParity
  /** sha256 of the surface minus this field — proves two runs computed the same. */
  surfaceChecksum: string
}

// ── Parity table ────────────────────────────────────────────────────────────

export const SCAN_RESULT_SURFACES = [
  "dashboard_scan_detail",
  "rest_api_v1",
  "sdk",
  "cli",
  "mcp",
  "desktop_local",
] as const
export type ScanResultSurface = (typeof SCAN_RESULT_SURFACES)[number]

export const SCAN_QUALITY_METRICS = [
  "scan_status",
  "finding_count",
  "verification_mix",
  "coverage_receipts",
  "manifest_checksum",
  "ingestion_warnings",
  "quality_surface",
] as const
export type ScanQualityMetric = (typeof SCAN_QUALITY_METRICS)[number]

/**
 * What the metric's presence means on a surface:
 * - `measured` — rendered from stored scan evidence for that scan
 * - `derived` — computed on the client from measured fields it did receive
 * - `not_reported` — the surface does not carry the metric (honest absence)
 */
export type ParityCell = "measured" | "derived" | "not_reported"

export type ScanSurfaceParity = Record<ScanQualityMetric, Record<ScanResultSurface, ParityCell>>

/**
 * The checked parity contract. Cells are conservative: a surface only earns
 * `measured` where its real projection carries the field (API/SDK/CLI/MCP all
 * consume the same GET /scans/[id] payload, so their cells track it; Desktop
 * is a local engine projection and honestly reports only what it stores).
 * Tests in each surface's package keep this table aligned with the shipped
 * projection — a "measured" claim without the field fails the suite.
 */
export const SCAN_SURFACE_PARITY: ScanSurfaceParity = {
  scan_status: {
    dashboard_scan_detail: "measured",
    rest_api_v1: "measured",
    sdk: "measured",
    cli: "measured",
    mcp: "measured",
    desktop_local: "measured",
  },
  finding_count: {
    // The dashboard detail view fetches the finding list; the bare scan GET
    // carries receipts and checksums but not findings, so REST/SDK/CLI/MCP
    // only expose the count through the quality surface.
    dashboard_scan_detail: "measured",
    rest_api_v1: "derived",
    sdk: "derived",
    cli: "not_reported",
    mcp: "not_reported",
    desktop_local: "measured",
  },
  verification_mix: {
    dashboard_scan_detail: "measured",
    rest_api_v1: "derived",
    sdk: "derived",
    cli: "not_reported",
    mcp: "not_reported",
    // Desktop stores an authoritative per-finding verification_state (always
    // DETECTED for local runs) — that IS the measured local mix.
    desktop_local: "measured",
  },
  coverage_receipts: {
    dashboard_scan_detail: "measured",
    rest_api_v1: "measured",
    sdk: "measured",
    cli: "measured",
    mcp: "measured",
    // Local runs persist findings but not the hosted receipt model.
    desktop_local: "not_reported",
  },
  manifest_checksum: {
    dashboard_scan_detail: "measured",
    rest_api_v1: "measured",
    sdk: "measured",
    cli: "measured",
    mcp: "measured",
    desktop_local: "not_reported",
  },
  ingestion_warnings: {
    // Rendered from the manifest detail on the dashboard and exposed via the
    // quality surface; the bare poll payload does not carry them.
    dashboard_scan_detail: "measured",
    rest_api_v1: "derived",
    sdk: "derived",
    cli: "not_reported",
    mcp: "not_reported",
    desktop_local: "not_reported",
  },
  quality_surface: {
    dashboard_scan_detail: "measured",
    rest_api_v1: "measured",
    sdk: "measured",
    // `lyrashield quality <scanId>` fetches the same server-computed surface.
    cli: "measured",
    // lyrashield_get_scan_quality returns the same payload.
    mcp: "measured",
    desktop_local: "not_reported",
  },
}

// ── Builder ─────────────────────────────────────────────────────────────────

const ENGINE_DECLARED_PREFIXES = ["engine-scope:", "engine-gap:"]
const CONNECTOR_RECEIPT_PREFIX = "connector:"

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

/**
 * Platform-neutral sha256 (Web Crypto works in Node ≥20 and browsers, so this
 * module stays importable from client bundles without node:crypto).
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  )
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const VERIFICATION_TIERS = ["DETECTED", "VALIDATED", "VERIFIED", "BLOCKED", "INCONCLUSIVE"]

/**
 * Compute the quality surface for one scan from its stored evidence. Pure and
 * deterministic: same input → same output, no clock, no randomness. Inputs
 * must come from persisted rows — callers pass records, never live claims.
 */
export async function buildScanQualitySurface(
  input: ScanQualityInput
): Promise<ScanQualitySurface> {
  const byVerificationStatus: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  let validatedCount = 0
  let verifiedCount = 0
  let nonConclusiveCount = 0
  for (const finding of input.findings) {
    const tier =
      typeof finding.verificationStatus === "string" &&
      VERIFICATION_TIERS.includes(finding.verificationStatus)
        ? finding.verificationStatus
        : "UNLABELED"
    increment(byVerificationStatus, tier)
    if (tier === "VALIDATED") validatedCount++
    if (tier === "VERIFIED") verifiedCount++
    if (tier === "BLOCKED" || tier === "INCONCLUSIVE" || tier === "UNLABELED") {
      nonConclusiveCount++
    }
    increment(bySeverity, finding.severity ?? "UNKNOWN")
  }

  const byStatus: Record<string, number> = {}
  const byScanner: Record<string, number> = {}
  let engineDeclaredReceipts = 0
  let connectorReceipts = 0
  let assessedReceipts = 0
  let applicableReceipts = 0
  for (const receipt of input.receipts) {
    increment(byStatus, receipt.status)
    increment(byScanner, receipt.scanner)
    if (ENGINE_DECLARED_PREFIXES.some((prefix) => receipt.controlId.startsWith(prefix))) {
      engineDeclaredReceipts++
    }
    if (receipt.controlId.startsWith(CONNECTOR_RECEIPT_PREFIX)) {
      connectorReceipts++
    }
    if (receipt.status !== "NOT_APPLICABLE") {
      applicableReceipts++
      if (receipt.status === "COMPLETED") assessedReceipts++
    }
  }

  const surface: Omit<ScanQualitySurface, "surfaceChecksum"> = {
    version: SCAN_QUALITY_SURFACE_VERSION,
    facts: {
      scanStatus: input.scan.status,
      scanMode: input.scan.mode,
      deterministicRun: input.scan.determinismMode === "targeted_scanner",
      durationMs: input.scan.durationMs ?? null,
      llmRequests: input.scan.llmRequestCount ?? null,
      findings: {
        total: input.findings.length,
        byVerificationStatus,
        bySeverity,
        validatedCount,
        verifiedCount,
        nonConclusiveCount,
      },
      coverage: {
        receiptsTotal: input.receipts.length,
        byStatus,
        byScanner,
        engineDeclaredReceipts,
        connectorReceipts,
      },
      evidence: {
        manifestPresent: Boolean(input.manifestChecksum),
        manifestChecksum: input.manifestChecksum ?? null,
        ingestionWarningCount: input.ingestionWarnings?.length ?? 0,
        attachmentCount: input.attachments?.count ?? null,
      },
    },
    estimates: {
      assessedReceiptRatio: {
        kind: "heuristic",
        value: applicableReceipts === 0 ? null : assessedReceipts / applicableReceipts,
        basis:
          "COMPLETED receipts ÷ non-NOT_APPLICABLE receipts; includes engine-declared coverage, which is a self-report and not a measured outcome",
      },
      verifiedFindingRatio: {
        kind: "heuristic",
        value:
          input.findings.length === 0 ? null : verifiedCount / input.findings.length,
        basis:
          "VERIFIED findings ÷ total findings; VALIDATED is deterministic checking, not independent verification",
      },
    },
    parity: SCAN_SURFACE_PARITY,
  }

  return { ...surface, surfaceChecksum: await sha256Hex(canonicalJson(surface)) }
}

// ── Response schema (SDK/API boundary) ──────────────────────────────────────

const ParityCellSchema = z.enum(["measured", "derived", "not_reported"])

export const ScanQualitySurfaceSchema = z
  .object({
    version: z.literal(SCAN_QUALITY_SURFACE_VERSION),
    facts: z
      .object({
        scanStatus: z.string(),
        scanMode: z.string(),
        deterministicRun: z.boolean(),
        durationMs: z.number().nullable(),
        llmRequests: z.number().nullable(),
        findings: z.object({
          total: z.number(),
          byVerificationStatus: z.record(z.string(), z.number()),
          bySeverity: z.record(z.string(), z.number()),
          validatedCount: z.number(),
          verifiedCount: z.number(),
          nonConclusiveCount: z.number(),
        }),
        coverage: z.object({
          receiptsTotal: z.number(),
          byStatus: z.record(z.string(), z.number()),
          byScanner: z.record(z.string(), z.number()),
          engineDeclaredReceipts: z.number(),
          connectorReceipts: z.number(),
        }),
        evidence: z.object({
          manifestPresent: z.boolean(),
          manifestChecksum: z.string().nullable(),
          ingestionWarningCount: z.number(),
          attachmentCount: z.number().nullable(),
        }),
      })
      .passthrough(),
    estimates: z.object({
      assessedReceiptRatio: z.object({
        kind: z.literal("heuristic"),
        value: z.number().nullable(),
        basis: z.string(),
      }),
      verifiedFindingRatio: z.object({
        kind: z.literal("heuristic"),
        value: z.number().nullable(),
        basis: z.string(),
      }),
    }),
    parity: z.record(z.string(), z.record(z.string(), ParityCellSchema)),
    surfaceChecksum: z.string(),
  })
  .passthrough()

export type ScanQualitySurfaceResponse = z.infer<typeof ScanQualitySurfaceSchema>
