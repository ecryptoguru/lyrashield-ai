/**
 * Launch Readiness Report — the ONLY constructor of the public (shareable)
 * report payload.
 *
 * This is the disclosure allowlist for WP4 (the report a stranger will accept).
 * Adding a field here MUST be a deliberate, reviewed decision; the regression
 * test asserts the exact key set. This mirrors the load-bearing discipline of
 * buildScorecardPayload — nothing about a customer's app leaks beyond this list.
 *
 * Founder-ruled (2026-09-02):
 * - App display name DEFAULTS to the neutral label; a customer-chosen name only
 *   appears when the customer explicitly opts in at share time.
 * - Counts and aggregates only — never a finding title, file path, CWE detail,
 *   repo/URL, scan ID, or raw evidence on the shared page.
 */

import { createHash } from "node:crypto"

export const LAUNCH_REPORT_PAYLOAD_VERSION = "lyrashield-launch-report/1.0.0"

/** The neutral default shown for the app when the customer has not opted in to naming it. */
export const NEUTRAL_APP_LABEL = "a protected application"

/** Customer-facing verdict phrasing (approved WP2 phrasing over the enum). */
export type LaunchReportVerdictLabel = "Ready to launch" | "Not ready" | "Not enough evidence"

export interface LaunchReportShareablePayload {
  /** Payload format version (this constructor's contract). */
  payloadVersion: string
  /** Customer-facing verdict label. */
  verdictLabel: LaunchReportVerdictLabel
  /** The named, versioned standard the verdict was judged against. */
  standardVersion: string
  /** App identity — neutral label by default, or the customer-opted-in name. */
  appDisplayName: string
  /** ISO date the verdict was evaluated. */
  evaluatedAt: string
  /** ISO date this report was issued. */
  issuedAt: string
  /** Positive coverage claim: scanner classes that were evaluated. */
  coverageStatement: string[]
  /** What was NOT examined — always present, never hidden. */
  nonCoverage: string[]
  /** Aggregate outcome counts (no detail). */
  counts: {
    unresolvedCritical: number
    unresolvedHigh: number
    unresolvedMedium: number
    unresolvedLow: number
    fixedAndRetestConfirmed: number
    independentlyVerified: number
  }
  /** Whether the verdict was stale at issue (new code/findings since evaluation). */
  stale: boolean
  /** SHA-256 over the canonical payload (verification). */
  reportChecksum: string
  /** ed25519 signature over reportChecksum, base64 (set by the signing step). */
  signature?: string
  /** Which signing key produced the signature (for verification / revocation). */
  signingKeyId?: string
}

export interface LaunchReportSource {
  standardVersion: string
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  coverageStatement: string[]
  nonCoverage: Array<{ controlId: string; scanner: string; reason: string | null }>
  blockingReasons: Array<{ severity: string }>
  evidenceSummary: {
    verified: number
    retestConfirmed: number
    /**
     * Unresolved blocking-severity counts from the gate's evidence summary.
     * These are the numbers the public counts block maps from — NOT
     * blockingReasons, which structurally only ever carries CRITICAL/HIGH and
     * would silently read 0 for anything the gate does not block on.
     */
    unresolvedCritical: number
    unresolvedHigh: number
  }
  staleness: { current: boolean }
  verdictChecksum: string
  evaluatedAt: Date
}

const VERDICT_LABELS: Record<LaunchReportSource["state"], LaunchReportVerdictLabel> = {
  READY: "Ready to launch",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Canonical SHA-256 over the shareable payload (minus the signature fields). */
export function computeLaunchReportChecksum(
  payload: Omit<LaunchReportShareablePayload, "reportChecksum" | "signature" | "signingKeyId">
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex")
}

/**
 * Build the public report payload from a stored GateVerdict. This is the ONLY
 * constructor; the shareable renderer never reads the GateVerdict directly.
 *
 * @param source         The persisted GateVerdict (packages/db GateVerdict row).
 * @param opts.appDisplayName  Customer-opted-in app name, or omit for the neutral label.
 * @param opts.issuedAt   When the report is issued (defaults to now).
 */
export function buildLaunchReportPayload(
  source: LaunchReportSource,
  opts: { appDisplayName?: string; issuedAt?: Date } = {}
): LaunchReportShareablePayload {
  const issuedAt = opts.issuedAt ?? new Date()

  const nonCoverage = source.nonCoverage.map((n) => {
    // Disclose WHAT was not covered, not the operational why (which can leak internals).
    return n.scanner
  })

  const base = {
    payloadVersion: LAUNCH_REPORT_PAYLOAD_VERSION,
    verdictLabel: VERDICT_LABELS[source.state],
    standardVersion: source.standardVersion,
    appDisplayName: opts.appDisplayName?.trim() ? opts.appDisplayName.trim() : NEUTRAL_APP_LABEL,
    evaluatedAt: source.evaluatedAt.toISOString(),
    issuedAt: issuedAt.toISOString(),
    coverageStatement: source.coverageStatement,
    nonCoverage,
    counts: {
      unresolvedCritical: source.evidenceSummary.unresolvedCritical,
      unresolvedHigh: source.evidenceSummary.unresolvedHigh,
      // v1.0.0 of the standard does not gate on MEDIUM/LOW (they feed the
      // score/report layers, not the verdict). Publishing counts for them
      // would imply they were evaluated for launch when they were not, so
      // the fields carry 0 AND the report body explains the scope. The
      // allowlist test pins this contract.
      unresolvedMedium: 0,
      unresolvedLow: 0,
      fixedAndRetestConfirmed: source.evidenceSummary.retestConfirmed,
      independentlyVerified: source.evidenceSummary.verified,
    },
    stale: !source.staleness.current,
  }

  return {
    ...base,
    reportChecksum: computeLaunchReportChecksum(base),
  }
}
