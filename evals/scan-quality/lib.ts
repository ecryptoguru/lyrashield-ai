/**
 * Shared logic for the scan-quality eval harness — imported by `run.ts` (the
 * CLI) and `cases.test.ts` (the corpus test) so both can never drift on what
 * a valid case is or how assertions resolve.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildScanQualitySurface,
  SCAN_QUALITY_METRICS,
  SCAN_QUALITY_SURFACE_VERSION,
  SCAN_RESULT_SURFACES,
  type ScanQualityInput,
  type ScanQualitySurface,
} from "../../packages/types/src/scan-quality"

const HERE = dirname(fileURLToPath(import.meta.url))
export const CASE_DIR = join(HERE, "cases")
export const CORPUS_VERSION = "scan-quality-cases/1.0.0"

export interface QualityCase {
  id: string
  title: string
  note?: string
  evidence: ScanQualityInput
  expect: Record<string, unknown>
}

export interface CaseResult {
  id: string
  title: string
  status: "pass" | "fail" | "invalid"
  reasons: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function validateCase(
  raw: unknown,
  file: string
): { ok: true; value: QualityCase } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (!isRecord(raw)) return { ok: false, problems: ["case file is not an object"] }
  if (typeof raw.id !== "string" || !raw.id) problems.push("id must be a non-empty string")
  if (typeof raw.title !== "string" || !raw.title)
    problems.push("title must be a non-empty string")
  if (!isRecord(raw.evidence)) problems.push("evidence must be an object")
  else {
    const evidence = raw.evidence
    if (!isRecord(evidence.scan)) problems.push("evidence.scan must be an object")
    else {
      if (typeof evidence.scan.status !== "string")
        problems.push("evidence.scan.status must be a string")
      if (typeof evidence.scan.mode !== "string")
        problems.push("evidence.scan.mode must be a string")
    }
    if (!Array.isArray(evidence.receipts)) problems.push("evidence.receipts must be an array")
    if (!Array.isArray(evidence.findings)) problems.push("evidence.findings must be an array")
  }
  if (!isRecord(raw.expect) || Object.keys(raw.expect).length === 0) {
    problems.push("expect must be a non-empty object of surface-path → expected value")
  }
  if (problems.length) return { ok: false, problems: problems.map((p) => `${file}: ${p}`) }
  return { ok: true, value: raw as unknown as QualityCase }
}

/** Resolve a dotted path ("facts.findings.total") against the surface. */
export function resolvePath(surface: unknown, path: string): unknown {
  let current: unknown = surface
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false
    return aKeys.every((k) => deepEqual(a[k], b[k]))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  return false
}

export async function runCase(qualityCase: QualityCase): Promise<CaseResult> {
  const reasons: string[] = []

  const surface: ScanQualitySurface = await buildScanQualitySurface(qualityCase.evidence)
  const rerun = await buildScanQualitySurface(qualityCase.evidence)
  if (surface.surfaceChecksum !== rerun.surfaceChecksum) {
    reasons.push("non-deterministic surface: two builds produced different checksums")
  }

  if (surface.version !== SCAN_QUALITY_SURFACE_VERSION) {
    reasons.push(`surface version mismatch: ${surface.version}`)
  }
  // The parity table must publish every metric × surface cell.
  for (const metric of SCAN_QUALITY_METRICS) {
    const row = surface.parity[metric]
    if (!row) {
      reasons.push(`parity table is missing metric ${metric}`)
      continue
    }
    for (const resultSurface of SCAN_RESULT_SURFACES) {
      const cell = row[resultSurface]
      if (cell !== "measured" && cell !== "derived" && cell !== "not_reported") {
        reasons.push(`parity cell ${metric}/${resultSurface} is not a valid ParityCell`)
      }
    }
  }

  for (const [path, expected] of Object.entries(qualityCase.expect)) {
    const actual = resolvePath(surface, path)
    if (!deepEqual(actual, expected)) {
      reasons.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }

  return {
    id: qualityCase.id,
    title: qualityCase.title,
    status: reasons.length ? "fail" : "pass",
    reasons,
  }
}
