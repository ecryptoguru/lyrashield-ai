"use client"

import Link from "next/link"
import { AlertTriangle, CheckCircle2, TrendingUp } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Badge, Card } from "@lyrashield/ui"
import { ScoreGauge } from "@/components/security-visuals"
import type { LaunchReadinessReport } from "./launch-readiness-client"

export function LaunchVerdictCard({
  report,
  config,
  summary,
  scope,
  releaseNeedsAttention,
  action,
}: {
  report: LaunchReadinessReport
  config: {
    icon: LucideIcon
    label: string
    color: string
    bg: string
    border: string
    badgeVariant: "warning" | "muted" | "success" | "danger"
  }
  summary: string
  scope: string
  releaseNeedsAttention: boolean
  action: { href: string; label: string }
}) {
  const Icon = config.icon
  return (
    <Card className={`p-6 ${config.bg} ${config.border}`}>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <Icon className={`h-7 w-7 ${config.color}`} aria-hidden="true" />
            <h2 className={`text-2xl font-bold ${config.color}`}>{config.label}</h2>
          </div>
          <p className="text-muted-foreground mb-2 text-xs">Assessment scope: {scope}</p>
          <p className="text-muted-foreground mb-4 text-sm">{summary}</p>
          <Link
            href={action.href}
            className="bg-primary text-primary-foreground mb-4 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium hover:bg-primary/90"
          >
            {action.label}
          </Link>
          <p className="text-muted-foreground mb-4 text-xs">
            Triage counts open findings; it is not the launch verdict.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant={config.badgeVariant}>
              Triage only — not a readiness score ·{" "}
              {report.triageScore === null
                ? "Triage score pending"
                : `Triage score: ${report.triageScore}/100`}
            </Badge>
            <Badge variant="muted">{report.totalFindings} total findings</Badge>
            <Badge variant="muted">{report.blockingFindings} blocking</Badge>
            <Badge variant="muted">{report.verifiedFindings} independently verified</Badge>
          </div>
        </div>
        <div className="hidden shrink-0 sm:block">
          <ScoreGauge
            score={report.triageScore}
            grade="Triage"
            neutral={
              releaseNeedsAttention ||
              report.verdict === "INCONCLUSIVE" ||
              report.verdict === "NOT_EVALUATED"
            }
          />
        </div>
      </div>
    </Card>
  )
}

export function LaunchReadinessDetails({
  report,
  children,
}: {
  report: LaunchReadinessReport
  children: ReactNode
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {report.conditions.length > 0 && (
          <SummaryList
            title="Conditions"
            icon={AlertTriangle}
            values={report.conditions}
            tone="amber"
          />
        )}
        {report.recommendations.length > 0 && (
          <SummaryList
            title="Recommendations"
            icon={TrendingUp}
            values={report.recommendations}
            tone="sky"
          />
        )}
      </div>
      {report.totalFindings > 0 && children}
      {report.verdict === "GO" && report.totalFindings === 0 && (
        <Card className="p-6 text-center">
          <CheckCircle2 className="text-success mx-auto mb-3 h-12 w-12" aria-hidden="true" />
          <h3 className="mb-1 text-lg font-semibold">No blocking findings in completed scope</h3>
          <p className="text-muted-foreground text-sm">
            No findings were reported within completed scan coverage. Review the retained coverage
            and limitations before making your launch decision.
          </p>
        </Card>
      )}
    </>
  )
}

function SummaryList({
  title,
  icon: Icon,
  values,
  tone,
}: {
  title: string
  icon: LucideIcon
  values: string[]
  tone: "amber" | "sky"
}) {
  const color = tone === "amber" ? "text-warning" : "text-sky-500"
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className={`h-5 w-5 ${color}`} aria-hidden="true" />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <ul className="space-y-2">
        {values.map((value, index) => (
          <li
            key={`${index}-${value}`}
            className="text-foreground/80 flex items-start gap-2 text-sm"
          >
            <span className={`${color} mt-0.5`} aria-hidden="true">
              •
            </span>
            {value}
          </li>
        ))}
      </ul>
    </Card>
  )
}
