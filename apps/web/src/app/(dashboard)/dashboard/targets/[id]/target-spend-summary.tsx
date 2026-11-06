import { CircleDollarSign } from "lucide-react"
import { Card } from "@lyrashield/ui"
import type { SpendValue } from "@lyrashield/db"
import type { ResourceResult } from "@/lib/target-assessment"
import type { ScanSpendProjection } from "@lyrashield/db"

function money(value: SpendValue): string {
  if (value.state === "known") {
    const amount = Number(value.amountUsd)
    return Number.isFinite(amount)
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        }).format(amount)
      : `$${value.amountUsd}`
  }
  if (value.state === "not_applicable") return value.reason
  const reasons: Record<typeof value.reason, string> = {
    LEGACY_SCAN: "Unknown — legacy scan has no cost receipt",
    SETTLEMENT_PENDING: "Unknown — settlement still pending",
    PROVIDER_USAGE_UNRECONCILED: "Unknown — provider usage not reconciled",
    NOT_AUTHORIZED: "Restricted",
    NO_PROVIDER_DOLLAR_RESERVATION: "Not persisted",
  }
  return reasons[value.reason]
}

export function TargetSpendSummary({
  projection,
  hasScan = true,
}: {
  projection: ResourceResult<ScanSpendProjection | null>
  /** False only when the target has never been reviewed. */
  hasScan?: boolean
}) {
  if (projection.status === "unavailable") {
    return (
      <Card className="p-5" aria-labelledby="target-spend-heading">
        <h2 id="target-spend-heading" className="font-semibold">
          Spend
        </h2>
        <p role="alert" className="text-muted-foreground mt-2 text-sm">
          Spend details are unavailable. Unknown is not zero.
        </p>
      </Card>
    )
  }
  if (!projection.value) {
    return (
      <Card className="p-5" aria-labelledby="target-spend-heading">
        <div className="flex items-center gap-2">
          <CircleDollarSign className="text-primary size-4" aria-hidden="true" />
          <h2 id="target-spend-heading" className="font-semibold">
            Spend
          </h2>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          {hasScan
            ? "Spend details are available to the scan sponsor or billing manager."
            : "No review has started, so there is no spend yet."}
        </p>
      </Card>
    )
  }
  const value = projection.value
  return (
    <Card className="p-5" aria-labelledby="target-spend-heading">
      <h2 id="target-spend-heading" className="font-semibold">
        Spend
      </h2>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <SpendDatum label="Consumed" value={money(value.consumed)} />
        <SpendDatum label="Reserved" value={money(value.reserved)} />
        <SpendDatum label="Maximum" value={money(value.maximum)} />
      </dl>
      <p className="text-muted-foreground mt-3 text-xs">
        Consumed and maximum are separate receipts. A missing provider receipt is shown as unknown,
        never as zero.
      </p>
      {value.agentMinutes && (
        <p className="text-muted-foreground mt-2 text-xs">
          Agent minutes: Funded {value.agentMinutes.funded} · Charged {value.agentMinutes.charged} ·
          Absorbed {value.agentMinutes.absorbed}. Minutes are separate from provider dollars.
        </p>
      )}
    </Card>
  )
}

function SpendDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-semibold">{value}</dd>
    </div>
  )
}
