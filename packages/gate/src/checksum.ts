/**
 * Checksum helpers for the Launch Gate.
 *
 * Two checksums make a verdict reproducible and tamper-evident:
 * - inputChecksum: SHA-256 over the canonical serialization of the evidence
 *   inputs. Recomputing the gate over the same stored evidence must reproduce
 *   it — that is the "reproducible from stored evidence" guarantee.
 * - verdictChecksum: SHA-256 over the rendered verdict payload, so a third
 *   party (or a signed report) can detect edits after issue.
 *
 * Canonicalization = stable key ordering + sorted arrays, so the hash does not
 * depend on object key or array order from the database.
 */

import { createHash } from "node:crypto"

import type { GateEvidenceInput, GateVerdictResult } from "./index"

/** Stable stringify: sorts object keys recursively so the hash is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")
}

/** Canonical evidence fingerprint. Arrays are sorted by stable identity first. */
export function computeInputChecksum(input: GateEvidenceInput): string {
  const findings = [...input.findings].sort((a, b) => a.id.localeCompare(b.id))
  const receipts = [...input.coverageReceipts].sort((a, b) =>
    `${a.scanner}:${a.controlId}`.localeCompare(`${b.scanner}:${b.controlId}`)
  )
  return sha256({
    targetId: input.targetId,
    standardVersion: "lyrashield-gate/1.0.0",
    latestCompletedScan: input.latestCompletedScan,
    requiredScanners: [...input.requiredScanners].sort(),
    findings,
    coverageReceipts: receipts,
  })
}

/** Canonical verdict fingerprint over the rendered result payload. */
export function computeVerdictChecksum(result: GateVerdictResult): string {
  return sha256({
    standardVersion: result.standardVersion,
    state: result.state,
    nonCoverage: result.nonCoverage,
    coverageStatement: result.coverageStatement,
    blockingReasons: result.blockingReasons,
    evidenceSummary: result.evidenceSummary,
    staleness: result.staleness,
  })
}
