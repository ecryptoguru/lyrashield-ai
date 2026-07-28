"use client"

import { ShieldCheck, Clock, ListChecks } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from "@lyrashield/ui"
import { RUN_SINGULAR } from "@/lib/terminology"
import { estimateRunMinutes, formatEstimate } from "@/lib/estimator"

export function TrustCommandCenter({
  productName,
  mode,
  assetCount,
  riskScore,
  trustPlanData,
}: {
  productName: string
  mode: string
  assetCount: number
  riskScore: number
  trustPlanData: unknown
}) {
  const estimate = estimateRunMinutes(mode, assetCount)

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
          <Badge variant={riskScore >= 80 ? "success" : riskScore >= 50 ? "warning" : "danger"}>
            {riskScore}/100
          </Badge>
          <Button variant="secondary" size="sm">
            <ShieldCheck className="size-4" />
            Start {RUN_SINGULAR}
          </Button>
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
            <p className="text-muted-foreground text-xs">For {assetCount} asset(s) in {mode.toLowerCase()} mode</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Trust plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <ListChecks className="text-primary size-5" aria-hidden="true" />
              <span className="text-lg font-semibold">{typeof trustPlanData === "object" && trustPlanData !== null ? "Configured" : "Default"}</span>
            </div>
            <p className="text-muted-foreground text-xs">Review and customise controls.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Latest verdict</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="muted">No completed review yet</Badge>
            <p className="text-muted-foreground text-xs">Run your first review to see evidence.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
