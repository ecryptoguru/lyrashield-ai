import {
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  FileText,
  LockKeyhole,
  ShieldCheck,
  Target,
} from "lucide-react"
import { Badge, Card } from "@lyrashield/ui"
import type { ShareableReport } from "@lyrashield/db"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  RemediationBars,
  ScoreGauge,
  ScoreTrend,
  SeverityDonut,
} from "@/components/security-visuals"
import { formatDate } from "@/lib/date-format"

const verdictLabels: Record<
  string,
  { label: string; variant: "success" | "warning" | "danger" | "muted" }
> = {
  GO: { label: "Ready", variant: "success" },
  GO_WITH_CONDITIONS: { label: "Ready with conditions", variant: "warning" },
  NO_GO: { label: "Action required", variant: "danger" },
  NOT_EVALUATED: { label: "Not evaluated", variant: "muted" },
}

export function SharedReportView({ report }: { report: ShareableReport }) {
  const findingsCount = report.scanSummary?.findingsCount ?? 0
  const bySeverity = report.scanSummary?.findingsBySeverity ?? {}
  const assurance = report.assurance
  const verdict =
    verdictLabels[assurance?.verdict ?? "NOT_EVALUATED"] ?? verdictLabels.NOT_EVALUATED!
  const statusRows = assurance
    ? [
        { label: "Open", value: assurance.findingsByStatus.OPEN ?? 0, tone: "warning" as const },
        {
          label: "In remediation",
          value:
            (assurance.findingsByStatus.FIX_READY ?? 0) +
            (assurance.findingsByStatus.PR_OPENED ?? 0) +
            (assurance.findingsByStatus.FIXED_PENDING_RETEST ?? 0),
          tone: "primary" as const,
        },
        { label: "Fixed", value: assurance.fixedCount, tone: "success" as const },
      ]
    : []

  return (
    <main className="gradient-hero bg-background min-h-screen px-4 py-5 sm:px-6 sm:py-8 lg:py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 sm:gap-6">
        <header className="flex min-h-12 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="gradient-primary shadow-primary-glow flex size-10 items-center justify-center rounded-xl">
              <ShieldCheck className="text-primary-foreground size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-bold tracking-tight">LyraShield AI</p>
              <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
                Assurance report
              </p>
            </div>
          </div>
          <ThemeToggle />
        </header>

        <Card className="security-grid relative overflow-hidden p-5 sm:p-8 lg:p-10">
          <div className="from-card via-card/95 to-primary/5 absolute inset-0 bg-gradient-to-br" />
          <div className="relative grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <Badge variant={verdict.variant}>{verdict.label}</Badge>
                <Badge variant="muted">Immutable snapshot</Badge>
                <Badge variant="muted">Privacy redacted</Badge>
              </div>
              <h1 className="max-w-3xl text-3xl font-bold tracking-[-0.04em] sm:text-5xl">
                {report.title}
              </h1>
              <p className="text-muted-foreground mt-4 max-w-2xl text-sm leading-6 sm:text-base">
                {assurance?.narrative ??
                  report.scanSummary?.summary ??
                  "A frozen security posture snapshot prepared for stakeholder review."}
              </p>
              <div className="text-muted-foreground mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-4" aria-hidden="true" />
                  Generated {formatDate(report.createdAt)}
                </span>
                <span className="flex items-center gap-1.5">
                  <Target className="size-4" aria-hidden="true" />
                  Private target
                </span>
                <span className="flex items-center gap-1.5">
                  <LockKeyhole className="size-4" aria-hidden="true" />
                  Expiring, revocable access
                </span>
              </div>
            </div>
            <ScoreGauge score={assurance?.score ?? null} grade={assurance?.grade ?? null} />
          </div>
        </Card>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Report summary">
          {[
            ["Retained findings", findingsCount],
            ["Verified", assurance?.verifiedCount ?? 0],
            ["Fixed", assurance?.fixedCount ?? 0],
            ["Retests passed", assurance?.retestSummary.passed ?? 0],
          ].map(([label, value]) => (
            <Card key={label} className="p-5">
              <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.12em] uppercase">
                {label}
              </p>
              <p className="metric-number mt-2 text-3xl font-bold">{value}</p>
            </Card>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5 sm:p-6">
            <div className="mb-5">
              <h2 className="font-semibold">Risk composition</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Severity distribution at report creation.
              </p>
            </div>
            <SeverityDonut values={bySeverity} />
          </Card>
          <Card className="p-5 sm:p-6">
            <div className="mb-5">
              <h2 className="font-semibold">Remediation posture</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                How verified findings are moving toward closure.
              </p>
            </div>
            {assurance ? (
              <RemediationBars rows={statusRows} />
            ) : (
              <p className="text-muted-foreground text-sm">
                Legacy report snapshot — remediation analytics unavailable.
              </p>
            )}
          </Card>
        </section>

        {assurance && (
          <section className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
            <Card className="p-5 sm:p-6">
              <div className="mb-4">
                <h2 className="font-semibold">Security score trajectory</h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  Up to ten immutable score snapshots for this report scope.
                </p>
              </div>
              <ScoreTrend
                points={assurance.scoreTrend.map((point) => ({
                  label: formatDate(point.computedAt),
                  score: point.score,
                }))}
              />
            </Card>
            <Card className="p-5 sm:p-6">
              <div className="mb-4 flex items-center gap-2">
                <ArrowUpRight className="text-primary size-5" aria-hidden="true" />
                <h2 className="font-semibold">Priority actions</h2>
              </div>
              <ol className="flex flex-col gap-3">
                {assurance.priorityActions.map((action, index) => (
                  <li
                    key={`${action.label}-${index}`}
                    className="bg-muted/45 rounded-xl border p-4"
                  >
                    <div className="flex items-start gap-3">
                      <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                        {index + 1}
                      </span>
                      <div>
                        <p className="text-sm font-semibold">{action.label}</p>
                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                          {action.detail}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </section>
        )}

        <Card className="p-5 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
            <div>
              <FileText className="text-primary size-5" aria-hidden="true" />
              <h2 className="mt-3 font-semibold">Methodology and limits</h2>
              <p className="text-muted-foreground mt-2 text-xs leading-5">
                This share is intentionally redacted. Technical finding detail and evidence remain
                available only inside the authorized workspace.
              </p>
            </div>
            <ul className="flex flex-col gap-2.5">
              {(
                assurance?.methodology ?? [
                  "This legacy report reflects the data retained when it was generated.",
                ]
              ).map((item) => (
                <li
                  key={item}
                  className="text-muted-foreground flex items-start gap-2 text-xs leading-5"
                >
                  <CheckCircle2
                    className="text-success mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <footer className="text-muted-foreground flex flex-col gap-2 px-1 pb-4 text-[11px] sm:flex-row sm:items-center sm:justify-between">
          <span>Report ID {report.id}</span>
          <span>
            {report.shareExpiresAt
              ? `Access expires ${formatDate(report.shareExpiresAt)}`
              : "Access governed by the report owner"}
          </span>
        </footer>
      </div>
    </main>
  )
}
