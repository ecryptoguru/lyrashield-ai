import { ShieldCheck, ShieldAlert, FileText, Calendar, Target } from "lucide-react"
import { Card } from "@lyrashield/ui"
import type { ShareableReport } from "@lyrashield/db"

function SeverityBadge({ severity, count }: { severity: string; count: number }) {
  const colors: Record<string, string> = {
    CRITICAL: "bg-destructive/10 text-destructive",
    HIGH: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    MEDIUM: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    LOW: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    INFO: "bg-muted text-muted-foreground",
  }
  if (count === 0) return null
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${colors[severity] ?? colors.INFO}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {severity}: {count}
    </span>
  )
}

function SecurityBadge({
  findingsCount,
  hasCritical,
}: {
  findingsCount: number
  hasCritical: boolean
}) {
  const verdict = hasCritical ? "FAIL" : findingsCount > 0 ? "PASS_WITH_WARNINGS" : "PASS"
  const config = {
    PASS: {
      icon: ShieldCheck,
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
      label: "Security Verified",
    },
    PASS_WITH_WARNINGS: {
      icon: ShieldAlert,
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
      label: "Passed with Warnings",
    },
    FAIL: {
      icon: ShieldAlert,
      color: "text-destructive",
      bg: "bg-destructive/10",
      border: "border-destructive/20",
      label: "Security Issues Found",
    },
  }
  const c = config[verdict as keyof typeof config]
  const Icon = c.icon

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-lg border ${c.border} ${c.bg} px-4 py-2`}
    >
      <Icon className={`h-5 w-5 ${c.color}`} aria-hidden="true" />
      <div className="flex flex-col">
        <span className={`text-sm font-semibold ${c.color}`}>{c.label}</span>
        <span className="text-muted-foreground text-xs">LyraShield Security Report</span>
      </div>
    </div>
  )
}

export function SharedReportView({ report }: { report: ShareableReport }) {
  const findingsCount = report.scanSummary?.findingsCount ?? 0
  const bySeverity = report.scanSummary?.findingsBySeverity ?? {}
  const hasCritical = (bySeverity.CRITICAL ?? 0) > 0

  return (
    <div className="bg-muted/30 min-h-screen px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header */}
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-lg">
              <FileText className="text-primary h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">{report.title}</h1>
              <p className="text-muted-foreground text-sm">
                {report.type.charAt(0).toUpperCase() + report.type.slice(1)} Report
              </p>
            </div>
          </div>
          <SecurityBadge findingsCount={findingsCount} hasCritical={hasCritical} />
        </div>

        {/* Report Card */}
        <Card className="space-y-6 p-6">
          {/* Meta */}
          <div className="text-muted-foreground flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4" aria-hidden="true" />
              <span>Generated {new Date(report.createdAt).toLocaleDateString()}</span>
            </div>
            {report.scanSummary && (
              <div className="flex items-center gap-1.5">
                <Target className="h-4 w-4" aria-hidden="true" />
                <span>Scan: {report.scanSummary.targetName}</span>
              </div>
            )}
          </div>

          {/* Scan Summary */}
          {report.scanSummary ? (
            <div className="space-y-4">
              <div>
                <h2 className="mb-2 text-lg font-semibold">Scan Summary</h2>
                <p className="text-muted-foreground text-sm">
                  Status:{" "}
                  <span className="text-foreground font-medium">{report.scanSummary.status}</span>
                  {" — "}
                  {findingsCount} finding{findingsCount !== 1 ? "s" : ""} detected
                </p>
                {report.scanSummary.summary && (
                  <p className="text-muted-foreground mt-1 text-sm">{report.scanSummary.summary}</p>
                )}
              </div>

              {/* Findings by Severity */}
              {findingsCount > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Findings by Severity</h3>
                  <div className="flex flex-wrap gap-2">
                    {["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((sev) => (
                      <SeverityBadge key={sev} severity={sev} count={bySeverity[sev] ?? 0} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              This report does not have an associated scan summary.
            </p>
          )}

          {/* Footer */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground/70 text-xs">Report ID: {report.id}</p>
              <div className="text-muted-foreground/70 flex items-center gap-1.5 text-xs">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Powered by LyraShield AI</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Expiry notice */}
        {report.shareExpiresAt && (
          <p className="text-muted-foreground/70 text-center text-xs">
            This share link expires on {new Date(report.shareExpiresAt).toLocaleDateString()}.
          </p>
        )}
      </div>
    </div>
  )
}
