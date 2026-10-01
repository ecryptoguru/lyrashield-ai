export { SEVERITY_ICON, SEVERITY_COLOR, SEVERITY_ORDER } from "@/lib/severity-presentation"
export { INTERNAL_ACCOUNTING_EVENT_STAGES } from "@/lib/scan-event-visibility"

import { SEVERITY_ORDER } from "@/lib/severity-presentation"
import { INTERNAL_ACCOUNTING_EVENT_STAGES } from "@/lib/scan-event-visibility"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import type { getScanPresentation } from "@/lib/scan-presentation"
import { presentOperationFailure } from "@/lib/operation-failure"
import { findingsHref, reportsHref } from "@/lib/finding-list-params"
import { scanRecoveryHref } from "../scans-client.utils"
import type { FindingItem, ScanData } from "./scan-detail-types"

type ScanPresentationResult = ReturnType<typeof getScanPresentation>

export type ScanNextAction =
  | { kind: "refresh"; label: string; description: string }
  | { kind: "link"; label: string; href: string; description: string }

export interface ScanDetailView {
  currentFindings: FindingItem[]
  sortedFindings: FindingItem[]
  displayEvents: ScanData["events"]
  coverageWarnings: ReturnType<typeof getScannerCoverageWarnings>
  hasLimitedCoverage: boolean
  familyCoverage: ScanData["integrity"]["coverage"]
  controlCoverage: ScanData["integrity"]["coverage"]
  incompleteCoverage: ScanData["integrity"]["coverage"]
  controlOutcomeCounts: Record<string, number>
  runCoverageState: "None" | "Partial" | "Complete"
  scanRecovery: ReturnType<typeof presentOperationFailure> | null
  nextAction: ScanNextAction
  coverageSummary: string
  displayedCoverageState: string
}

/**
 * All pure derivations for the scan detail view: ordering, coverage buckets,
 * the single next action, and the coverage summary copy. Kept out of the
 * client component so the render stays a projection of this view model.
 */
export function deriveScanDetailView({
  scan,
  currentFindings,
  presentation,
  isActive,
}: {
  scan: ScanData
  currentFindings: FindingItem[]
  presentation: ScanPresentationResult
  isActive: boolean
}): ScanDetailView {
  const sortedFindings = [...currentFindings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  )

  const displayEvents = scan.events.filter(
    (event) => !INTERNAL_ACCOUNTING_EVENT_STAGES.has(event.stage)
  )
  const coverageWarnings = getScannerCoverageWarnings(scan.events)
  const hasLimitedCoverage = coverageWarnings.length > 0
  // run.json 1.1 scoped coverage (engine-scope:*/engine-gap:*) is a model
  // self-report carried for evidence — it never joins the deterministic
  // scanner-family rows or the vibe control rows.
  const isEngineDeclaredReceipt = (controlId: string) =>
    controlId.startsWith("engine-scope:") || controlId.startsWith("engine-gap:")
  const familyCoverage = scan.integrity.coverage.filter(
    (receipt) =>
      !receipt.controlId.startsWith("vibe-") && !isEngineDeclaredReceipt(receipt.controlId)
  )
  const controlCoverage = scan.integrity.coverage.filter((receipt) =>
    receipt.controlId.startsWith("vibe-")
  )
  const incompleteCoverage = familyCoverage.filter(
    (receipt) => !["COMPLETED", "NOT_APPLICABLE"].includes(receipt.status)
  )
  const controlOutcomeCounts = controlCoverage.reduce(
    (counts, receipt) => {
      const outcome =
        typeof receipt.metadata?.outcome === "string" ? receipt.metadata.outcome : receipt.status
      counts[outcome] = (counts[outcome] ?? 0) + 1
      return counts
    },
    {} as Record<string, number>
  )
  // Run-scoped coverage state: what applicable scanners were able to inspect.
  // NOT_APPLICABLE receipts say nothing about coverage; any applicable receipt
  // that did not complete makes coverage partial.
  const applicableReceipts = familyCoverage.filter((receipt) => receipt.status !== "NOT_APPLICABLE")
  const runCoverageState =
    applicableReceipts.length === 0
      ? ("None" as const)
      : applicableReceipts.every((receipt) => receipt.status === "COMPLETED")
        ? ("Complete" as const)
        : ("Partial" as const)
  const topFinding = sortedFindings[0]
  const scanRecovery = presentation.showFailureDetails
    ? presentOperationFailure(scan.errorCategory ?? scan.status, {
        targetName: scan.target?.name,
      })
    : null
  const nextAction: ScanNextAction = isActive
    ? {
        kind: "refresh" as const,
        label: "Refresh scan status",
        description: "Read the latest accepted scan status. This does not start another scan.",
      }
    : scan.status === "PARTIAL" && scan.target
      ? {
          kind: "link" as const,
          label: "Complete coverage",
          href: scanRecoveryHref({
            targetId: scan.target.id,
            goal: scan.goal,
            mode: scan.mode,
          }),
          description:
            "Review the recorded limitations, then use the existing scan flow to request another scan for this target.",
        }
      : currentFindings.length > 0
        ? {
            kind: "link" as const,
            label: "Review highest-priority finding",
            href: findingsHref({
              tab: "issues",
              finding: topFinding!.id,
              scanId: scan.id,
              ...(scan.target ? { target: scan.target.id } : {}),
            }),
            description:
              "Review the retained evidence first. Detection is not verification; propose a fix only after reviewing its scope.",
          }
        : scanRecovery
          ? {
              kind: "link" as const,
              label:
                presentation.recoveryAction === "usage"
                  ? "Review account usage"
                  : "Review scan recovery",
              href:
                presentation.recoveryAction === "usage"
                  ? "/dashboard/billing"
                  : (scanRecovery.recoveryHref ??
                    (scan.target
                      ? scanRecoveryHref({
                          targetId: scan.target.id,
                          goal: scan.goal,
                          mode: scan.mode,
                        })
                      : "/dashboard/scans")),
              description: scanRecovery.recovery,
            }
          : scan.status === "COMPLETED" && runCoverageState === "Complete" && !hasLimitedCoverage
            ? {
                kind: "link" as const,
                label: "Create an assurance report",
                href: reportsHref({
                  scanId: scan.id,
                  ...(scan.target ? { targetId: scan.target.id } : {}),
                }),
                description:
                  "Package this scan and its recorded scope into an immutable report for your team.",
              }
            : {
                kind: "link" as const,
                label: scan.target ? "Review target setup" : "Review scans",
                href: scan.target
                  ? `/dashboard/targets/${encodeURIComponent(scan.target.id)}`
                  : "/dashboard/scans",
                description:
                  "This scan does not have complete usable coverage. Review the visible limitations before deciding what to do next.",
              }
  const coverageSummary = isActive
    ? "Coverage is still being recorded; this is not a completed result."
    : scan.status === "COMPLETED" && runCoverageState === "Complete" && !hasLimitedCoverage
      ? "Applicable scanner receipts completed within the recorded scope."
      : runCoverageState === "Partial" || scan.status === "PARTIAL" || hasLimitedCoverage
        ? "Coverage is partial or has a recorded limitation. Findings are available, but a clean result cannot be treated as complete."
        : "No complete applicable coverage was recorded. This scan does not support an assurance conclusion."
  const displayedCoverageState =
    (scan.status === "PARTIAL" || hasLimitedCoverage) && runCoverageState === "Complete"
      ? "Complete with limitations"
      : runCoverageState

  return {
    currentFindings,
    sortedFindings,
    displayEvents,
    coverageWarnings,
    hasLimitedCoverage,
    familyCoverage,
    controlCoverage,
    incompleteCoverage,
    controlOutcomeCounts,
    runCoverageState,
    scanRecovery,
    nextAction,
    coverageSummary,
    displayedCoverageState,
  }
}

export const EVENT_LEVEL_COLOR: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

export const SCANNER_LABELS: Record<string, string> = {
  engine: "Engine review",
  agent_config: "Agent configuration",
  sca: "Dependency scan",
  secrets: "Secret scan",
  url: "URL scan",
  ai_app_security: "AI app security",
  ml_supply_chain: "ML supply chain",
  sast: "Static analysis",
  iac: "Infrastructure config scan",
  external_import: "Imported scan (third-party)",
}
