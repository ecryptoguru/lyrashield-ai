import { z } from "zod"
import { paginatedResponseSchema } from "@/lib/api-schemas"

export interface ReportItem {
  id: string
  title: string
  type: string
  status: string
  format: string
  shareExpiresAt: string | null
  revokedAt: string | null
  createdAt: string
  scanId: string | null
  provenance?: LaunchReportProvenance | null
}

export interface LaunchReportProvenance {
  gateVerdictId: string
  verdictChecksum: string
  assessmentVersion: number | null
  assessedIdentity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
  assessedAt: string
  issuedAt: string
  applicabilityCheckedAt: string
  applicability: "applicable" | "not_applicable" | "unknown"
  reasonCodes: string[]
  historicalState: string
  effectiveState: string | null
}

export const reportItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    status: z.string(),
    format: z.string(),
    shareExpiresAt: z.string().datetime().or(z.string()).nullable(),
    revokedAt: z.string().datetime().or(z.string()).nullable(),
    createdAt: z.string().datetime().or(z.string()),
    scanId: z.string().nullable(),
  })
  .passthrough()

export const reportsPaginatedSchema = paginatedResponseSchema(reportItemSchema)

/** Bounded launch-gate provenance carried on a launch-readiness report. */
export const launchReportProvenanceSchema = z
  .object({
    gateVerdictId: z.string(),
    verdictChecksum: z.string(),
    assessmentVersion: z.number().nullable(),
    assessedIdentity: z
      .object({ kind: z.enum(["COMMIT", "ARTIFACT_DIGEST"]), value: z.string() })
      .nullable(),
    assessedAt: z.string(),
    issuedAt: z.string(),
    applicabilityCheckedAt: z.string(),
    applicability: z.enum(["applicable", "not_applicable", "unknown"]),
    reasonCodes: z.array(z.string()),
    historicalState: z.string(),
    effectiveState: z.string().nullable(),
  })
  .passthrough()

/**
 * The authenticated `GET /api/reports/:id` projection (getShareableReport).
 * Bounded by construction on the server — no storageUri, no signed URLs.
 * `shareUrl` is parsed only so the read can compute `shared` state; it is
 * never forwarded to tool output.
 */
export const shareableReportSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    status: z.string(),
    format: z.string(),
    shareUrl: z.string().nullable(),
    shareExpiresAt: z.string().datetime().or(z.string()).nullable(),
    revokedAt: z.string().datetime().or(z.string()).nullable(),
    createdAt: z.string().datetime().or(z.string()),
    scanSummary: z
      .object({
        scanId: z.string(),
        status: z.string(),
        summary: z.string().nullable(),
        targetName: z.string(),
        findingsCount: z.number(),
        findingsBySeverity: z.record(z.string(), z.number()),
      })
      .passthrough()
      .nullable()
      .optional(),
    assurance: z
      .object({
        verdict: z.string(),
        score: z.number().nullable(),
        grade: z.string().nullable(),
        verifiedCount: z.number(),
        fixedCount: z.number(),
        retestSummary: z
          .object({ passed: z.number(), failed: z.number(), pending: z.number() })
          .passthrough(),
        findingsByStatus: z.record(z.string(), z.number()),
      })
      .passthrough()
      .nullable()
      .optional(),
    launchReport: z
      .object({
        verdictLabel: z.string().nullable(),
        stale: z.boolean(),
        provenance: launchReportProvenanceSchema.nullable(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export type ShareableReport = z.infer<typeof shareableReportSchema>

export const reportScanSchema = z
  .object({
    id: z.string(),
    target: z
      .object({
        name: z.string(),
      })
      .passthrough(),
    status: z.string(),
  })
  .passthrough()

export const reportScansPaginatedSchema = paginatedResponseSchema(reportScanSchema)

export const reportShareSchema = z
  .object({
    token: z.string(),
    expiresAt: z.string().datetime().or(z.string()),
    shareUrl: z.string(),
  })
  .passthrough()

export const reportRevokeSchema = z
  .object({
    revoked: z.boolean(),
    revokedAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

export const REPORT_TYPE_LABEL: Record<string, string> = {
  executive: "Executive",
  developer: "Developer",
  compliance: "Assurance",
  launch_readiness: "Launch Readiness",
}

export const LAUNCH_HISTORICAL_VERDICT_LABEL: Record<string, string> = {
  READY: "Ready to launch",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
}

export const LAUNCH_APPLICABILITY_LABEL: Record<LaunchReportProvenance["applicability"], string> = {
  applicable: "Applicable",
  not_applicable: "Not applicable",
  unknown: "Could not be established",
}
