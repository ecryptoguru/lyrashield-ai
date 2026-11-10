import { Card } from "@lyrashield/ui"
import type { CustomerScanUsageProjection } from "@lyrashield/db"
import type { ResourceResult } from "@/lib/target-assessment"

export function TargetSpendSummary({
  projection,
  hasScan = true,
}: {
  projection: ResourceResult<CustomerScanUsageProjection | null>
  /** False only when the target has never been reviewed. */
  hasScan?: boolean
}) {
  let content: string
  if (projection.status === "unavailable") {
    content = "Usage is unavailable."
  } else if (!projection.value) {
    content = hasScan
      ? "Usage details are available to the scan sponsor."
      : "No review has started, so there is no usage yet."
  } else {
    const usage = projection.value
    switch (usage.state) {
      case "reconciled":
        content = `Charged: ${usage.chargedMinutes} agent minutes.`
        break
      case "pending":
        content = "Usage is still being reconciled."
        break
      case "not_applicable":
        content = "This review did not use billable agent minutes."
        break
      default:
        content = "Usage is unavailable."
    }
  }

  return (
    <Card className="p-5" aria-labelledby="target-spend-heading">
      <h2 id="target-spend-heading" className="font-semibold">
        Agent minutes
      </h2>
      <p
        className="text-muted-foreground mt-2 text-sm"
        role={content === "Usage is unavailable." ? "alert" : undefined}
      >
        {content}
      </p>
    </Card>
  )
}
