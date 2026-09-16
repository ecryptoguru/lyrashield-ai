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
