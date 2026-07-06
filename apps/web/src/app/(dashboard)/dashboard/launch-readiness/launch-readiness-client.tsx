"use client"

import { useState, useEffect, useCallback } from "react"
import { Rocket, ShieldCheck, ShieldAlert, ShieldX, TrendingUp, AlertTriangle, CheckCircle2, Info } from "lucide-react"
import { Card, Badge, Button, Spinner, EmptyState } from "@lyrashield/ui"
import { apiGet } from "@/lib/api-client"

interface LaunchReadinessReport {
  verdict: "GO" | "GO_WITH_CONDITIONS" | "NO_GO"
  score: number
  summary: string
  blockingFindings: number
  totalFindings: number
  verifiedFindings: number
  bySeverity: Record<string, number>
  conditions: string[]
  recommendations: string[]
}

const VERDICT_CONFIG = {
  GO: {
    icon: ShieldCheck,
    label: "Ready to Launch",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    badgeVariant: "success" as const,
  },
  GO_WITH_CONDITIONS: {
    icon: ShieldAlert,
    label: "Launch with Conditions",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    badgeVariant: "warning" as const,
  },
  NO_GO: {
    icon: ShieldX,
    label: "Do Not Launch",
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
    badgeVariant: "danger" as const,
  },
}

function ScoreGauge({ score }: { score: number }) {
  const circumference = 2 * Math.PI * 45
  const offset = circumference - (score / 100) * circumference
  const color = score >= 80 ? "#10b981" : score >= 40 ? "#f59e0b" : "#ef4444"

  return (
    <div className="relative flex h-32 w-32 items-center justify-center">
      <svg className="h-32 w-32 -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-3xl font-bold" style={{ color }}>{score}</span>
        <span className="text-xs text-muted-foreground">/ 100</span>
      </div>
    </div>
  )
}

function SeverityBreakdown({ bySeverity }: { bySeverity: Record<string, number> }) {
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
  const colors: Record<string, string> = {
    CRITICAL: "bg-destructive",
    HIGH: "bg-orange-500",
    MEDIUM: "bg-amber-500",
    LOW: "bg-sky-500",
    INFO: "bg-muted-foreground",
  }
  const maxCount = Math.max(1, ...severities.map((s) => bySeverity[s] ?? 0))

  return (
    <div className="space-y-2">
      {severities.map((sev) => {
        const count = bySeverity[sev] ?? 0
        if (count === 0) return null
        return (
          <div key={sev} className="flex items-center gap-3">
            <div className={`h-2 w-2 rounded-full ${colors[sev]}`} aria-hidden="true" />
            <span className="text-sm font-medium w-20">{sev}</span>
            <div className="flex-1 h-6 bg-muted rounded-md overflow-hidden">
              <div className={`h-full ${colors[sev]} flex items-center justify-end px-2`} style={{ width: `${Math.min(100, (count / maxCount) * 100)}%` }}>
                <span className="text-xs text-white font-medium">{count}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LaunchReadinessClient({ workspaceId }: { workspaceId: string }) {
  const [report, setReport] = useState<LaunchReadinessReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadReport = useCallback(() => {
    setLoading(true)
    apiGet<LaunchReadinessReport>(`/api/launch-readiness?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((data) => {
        setReport(data)
        setError(null)
      })
      .catch(() => {
        setError("Failed to load launch readiness report. Please try again.")
        setReport(null)
      })
      .finally(() => setLoading(false))
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    apiGet<LaunchReadinessReport>(`/api/launch-readiness?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((data) => {
        if (cancelled) return
        setReport(data)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError("Failed to load launch readiness report. Please try again.")
        setReport(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceId])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20" aria-busy="true">
        <Spinner className="h-8 w-8" />
        <p className="text-sm text-muted-foreground">Loading launch readiness report...</p>
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not load report"
        description={error}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={loadReport}
          >
            Try again
          </Button>
        }
      />
    )
  }

  if (!report) return null

  const config = VERDICT_CONFIG[report.verdict] ?? VERDICT_CONFIG.NO_GO
  const VerdictIcon = config.icon

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Rocket className="h-6 w-6 text-primary" aria-hidden="true" />
        <h1 className="text-2xl font-bold tracking-tight">Launch Readiness</h1>
      </div>

      {/* Verdict Card */}
      <Card className={`p-6 ${config.bg} ${config.border}`}>
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <ScoreGauge score={report.score} />
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2 mb-2">
              <VerdictIcon className={`h-7 w-7 ${config.color}`} aria-hidden="true" />
              <h2 className={`text-2xl font-bold ${config.color}`}>{config.label}</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{report.summary}</p>
            <div className="flex flex-wrap gap-2 justify-center sm:justify-start">
              <Badge variant={config.badgeVariant}>Score: {report.score}/100</Badge>
              <Badge variant="muted">{report.totalFindings} total findings</Badge>
              <Badge variant="muted">{report.blockingFindings} blocking</Badge>
              <Badge variant="muted">{report.verifiedFindings} verified</Badge>
            </div>
          </div>
        </div>
      </Card>

      {/* Conditions & Recommendations */}
      <div className="grid gap-4 md:grid-cols-2">
        {report.conditions.length > 0 && (
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
              <h3 className="font-semibold">Conditions</h3>
            </div>
            <ul className="space-y-2">
              {report.conditions.map((cond, i) => (
                <li key={i} className="text-sm text-foreground/80 flex items-start gap-2">
                  <span className="text-amber-500 mt-0.5" aria-hidden="true">•</span>
                  {cond}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {report.recommendations.length > 0 && (
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-5 w-5 text-sky-500" aria-hidden="true" />
              <h3 className="font-semibold">Recommendations</h3>
            </div>
            <ul className="space-y-2">
              {report.recommendations.map((rec, i) => (
                <li key={i} className="text-sm text-foreground/80 flex items-start gap-2">
                  <span className="text-sky-500 mt-0.5" aria-hidden="true">•</span>
                  {rec}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* Severity Breakdown */}
      {report.totalFindings > 0 && (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Info className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-semibold">Findings by Severity</h3>
          </div>
          <SeverityBreakdown bySeverity={report.bySeverity} />
        </Card>
      )}

      {/* All Clear */}
      {report.totalFindings === 0 && (
        <Card className="p-6 text-center">
          <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto mb-3" aria-hidden="true" />
          <h3 className="font-semibold text-lg mb-1">No Security Issues Found</h3>
          <p className="text-sm text-muted-foreground">
            Your application has no security findings. You&apos;re clear to launch!
          </p>
        </Card>
      )}
    </div>
  )
}
