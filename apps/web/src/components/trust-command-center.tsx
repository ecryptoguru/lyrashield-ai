import { ShieldCheck, Clock, ListChecks } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Badge, buttonVariants } from "@lyrashield/ui"
import { RUN_SINGULAR } from "@/lib/terminology"
import { estimateRunMinutes, formatEstimate } from "@/lib/estimator"
import Link from "next/link"

function trustPlanLabel(data: unknown): string {
  if (!data || typeof data !== "object") return "Default"
  const plan = data as Record<string, unknown>
  const preset =
    plan.preRelease && Array.isArray(plan.preRelease) && plan.preRelease.length > 0
      ? String(plan.preRelease[0])
      : null
  if (preset)
    return preset
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
  if (plan.recurring && Array.isArray(plan.recurring) && plan.recurring.length > 0) {
    const first = plan.recurring[0] as Record<string, unknown>
    if (typeof first.preset === "string")
      return String(first.preset)
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return "Configured"
}

export function TrustCommandCenter({
  productName,
  mode,
  assetCount,
  riskScore,
  trustPlanData,
  completedScanCount = 0,
  latestScore = null,
}: {
  productName: string
  mode: string
  assetCount: number
  riskScore: number
  trustPlanData: unknown
  completedScanCount?: number
  latestScore?: { score: number; grade: string } | null
}) {
  const estimate = estimateRunMinutes(mode, assetCount)

  const hasCompletedReview = completedScanCount > 0 && latestScore !== null
  const score = latestScore?.score ?? riskScore
  const verdictVariant = !hasCompletedReview
    ? "muted"
    : score >= 80
      ? "success"
      : score >= 50
        ? "warning"
        : "danger"
  const verdictText = !hasCompletedReview
    ? "Not evaluated"
    : score >= 80
      ? "Ready to ship within completed scope"
      : score >= 50
        ? "Needs attention"
        : "Needs action"

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{productName}</h2>
          <p className="text-muted-foreground text-sm">
            Product trust score and active review plan
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={verdictVariant as "success" | "warning" | "danger" | "muted"}>
            {score}/100
          </Badge>
          <Link
            href="/dashboard/scans?new=1"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            Start {RUN_SINGULAR}
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Estimated time</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Clock className="text-primary size-5" aria-hidden="true" />
              <span className="text-2xl font-bold">{formatEstimate(estimate)}</span>
            </div>
            <p className="text-muted-foreground text-xs">
              For {assetCount} asset(s) in {mode.toLowerCase()} mode
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Trust plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <ListChecks className="text-primary size-5" aria-hidden="true" />
              <span className="text-lg font-semibold">{trustPlanLabel(trustPlanData)}</span>
            </div>
            <Link
              href="/dashboard/settings"
              className="text-muted-foreground decoration-border hover:text-foreground text-xs underline underline-offset-4"
            >
              Review and customise controls.
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Latest verdict</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={verdictVariant as "success" | "warning" | "danger" | "muted"}>
              {verdictText}
            </Badge>
            <p className="text-muted-foreground text-xs">
              {hasCompletedReview
                ? `Based on the latest completed review (${completedScanCount} total).`
                : "Run your first review to see evidence."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
