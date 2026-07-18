export type FindingNextStep = "REPORT" | "RETEST_IN_PROGRESS" | "FIX_PROPOSAL" | "RETEST"

export function getFindingNextStep({
  latestRetestStatus,
  hasFixProposal,
}: {
  latestRetestStatus?: string | null
  hasFixProposal: boolean
}): FindingNextStep {
  if (latestRetestStatus === "passed") return "REPORT"
  if (latestRetestStatus && ["pending", "running"].includes(latestRetestStatus)) {
    return "RETEST_IN_PROGRESS"
  }
  return hasFixProposal ? "RETEST" : "FIX_PROPOSAL"
}
