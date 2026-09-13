/**
 * Renders the standards registry against a scan's coverage receipts and
 * findings. Output is evidence of coverage — states are computed, never
 * asserted. Three states per category:
 *   evaluated            — a mapped scanner family produced a COMPLETED receipt,
 *                          or a mapped CWE/OWASP finding exists this scan
 *   requires-attestation — attestable control with no scanner evidence
 *   not-evaluated        — nothing ran that covers this category this scan
 */
import type { Standard, StandardCategory } from "./registry"

export type StandardCellState = "evaluated" | "requires-attestation" | "not-evaluated"

export interface ScanReceiptInput {
  controlId: string
  scanner: string
  status: string
}

export interface ScanFindingInput {
  cwe?: string | null
  owaspCategory?: string | null
  scannerSource?: string | null
}

export interface RenderedCategory {
  id: string
  title: string
  state: StandardCellState
  /** Findings this scan whose CWE/OWASP tags map to the category. */
  violationSignals: number
  /** True when org attestation is required regardless of scan evidence. */
  attestable: boolean
}

export interface StandardView {
  standardId: string
  name: string
  version: string
  badge?: string
  evaluated: number
  requiresAttestation: number
  notEvaluated: number
  violationSignals: number
  categories: RenderedCategory[]
}

const FAMILY_COMPLETE = new Set(["COMPLETED"])
const FAMILY_ATTEMPTED = new Set(["BLOCKED"])

function familyReceipts(receipts: ScanReceiptInput[]): Map<string, ScanReceiptInput[]> {
  const byScanner = new Map<string, ScanReceiptInput[]>()
  for (const receipt of receipts) {
    // Control receipts carry vibe-NN controlIds; family receipts carry the
    // family name as both scanner and controlId. We only want family rows.
    if (receipt.controlId !== receipt.scanner) continue
    const list = byScanner.get(receipt.scanner) ?? []
    list.push(receipt)
    byScanner.set(receipt.scanner, list)
  }
  return byScanner
}

function cweMatches(category: StandardCategory, findings: ScanFindingInput[]): number {
  const hints = category.cweHints ?? []
  if (hints.length === 0) return 0
  return findings.filter((finding) => {
    if (!finding.cwe) return false
    const normalized = finding.cwe.replace(/^CWE-/i, "CWE-")
    return hints.some((hint) => normalized === hint || normalized.endsWith(`-${hint}`))
  }).length
}

function owaspMatches(category: StandardCategory, findings: ScanFindingInput[]): number {
  // Engine findings carry owaspCategory like "A01:2025" or "LLM01".
  return findings.filter((finding) => {
    const tag = finding.owaspCategory
    if (!tag) return false
    return tag.toUpperCase().startsWith(category.id.toUpperCase())
  }).length
}

export function renderStandard(
  standard: Standard,
  receipts: ScanReceiptInput[],
  findings: ScanFindingInput[]
): StandardView {
  const byScanner = familyReceipts(receipts)

  const categories: RenderedCategory[] = standard.categories.map((category) => {
    const violations = cweMatches(category, findings) + owaspMatches(category, findings)

    const evaluatorReceipts = (category.evaluators ?? []).flatMap(
      (family) => byScanner.get(family) ?? []
    )
    const completed = evaluatorReceipts.some((r) => FAMILY_COMPLETE.has(r.status))
    const attempted = evaluatorReceipts.some((r) => FAMILY_ATTEMPTED.has(r.status))

    let state: StandardCellState
    if (violations > 0 || completed) {
      // Evidence exists this scan — a violation signal or a completed family.
      state = "evaluated"
    } else if (attempted && !completed) {
      // The family ran but was bounded/blocked — coverage is not established.
      state = "not-evaluated"
    } else if (category.attestable) {
      state = "requires-attestation"
    } else {
      state = "not-evaluated"
    }

    return {
      id: category.id,
      title: category.title,
      state,
      violationSignals: violations,
      attestable: category.attestable === true,
    }
  })

  return {
    standardId: standard.id,
    name: standard.name,
    version: standard.version,
    badge: standard.badge,
    evaluated: categories.filter((c) => c.state === "evaluated").length,
    requiresAttestation: categories.filter((c) => c.state === "requires-attestation").length,
    notEvaluated: categories.filter((c) => c.state === "not-evaluated").length,
    violationSignals: categories.reduce((sum, c) => sum + c.violationSignals, 0),
    categories,
  }
}

export function renderStandards(
  standards: readonly Standard[],
  receipts: ScanReceiptInput[],
  findings: ScanFindingInput[]
): StandardView[] {
  return standards.map((standard) => renderStandard(standard, receipts, findings))
}
