import Link from "next/link"
import { AlertTriangle, ArrowRight, CheckCircle2, CircleHelp } from "lucide-react"
import { Badge, Card, buttonVariants } from "@lyrashield/ui"
import type { TargetAssessmentProjection } from "@/lib/target-assessment"

const STATE_LABEL: Record<
  "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE",
  { label: string; variant: "success" | "danger" | "warning"; icon: typeof CheckCircle2 }
> = {
  READY: { label: "Ready to launch", variant: "success", icon: CheckCircle2 },
  NOT_READY: { label: "Not ready", variant: "danger", icon: AlertTriangle },
  INSUFFICIENT_EVIDENCE: {
    label: "Not enough evidence",
    variant: "warning",
    icon: CircleHelp,
  },
}

function identityLabel(
  identity: NonNullable<TargetAssessmentProjection["assessment"]>["assessedIdentity"]
) {
  if (!identity) return "Release identity unavailable"
  return identity.kind === "COMMIT"
    ? `Commit ${identity.value.slice(0, 12)}`
    : `Artifact ${identity.value.slice(0, 19)}`
}

/**
 * Customer-facing explanation of one stored assessment. This component does
 * not compute readiness or infer progress; all state is supplied by the
 * server-owned projection and the stored Gate v2 verdict.
 */
export function TargetAssessmentSummary({
  projection,
}: {
  projection: TargetAssessmentProjection
}) {
  let statusLabel = "Not assessed"
  let statusVariant: "success" | "danger" | "warning" | "muted" = "muted"
  let StatusIcon = CircleHelp
  if (projection.assessment) {
    const config = STATE_LABEL[projection.assessment.state]
    statusLabel = config.label
    statusVariant = config.variant
    StatusIcon = config.icon
  }

  return (
    <Card className="p-5 sm:p-6" aria-labelledby="target-assessment-heading">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusIcon className="size-5" aria-hidden="true" />
            <h2 id="target-assessment-heading" className="text-lg font-semibold">
              Assessment
            </h2>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
            {projection.execution.deliveryState !== "UNKNOWN" && (
              <Badge variant={projection.execution.deliveryState === "TERMINAL" ? "muted" : "info"}>
                Execution: {projection.execution.status}
              </Badge>
            )}
          </div>

          {projection.assessmentState === "unavailable" ? (
            <div
              role="alert"
              className="border-warning/40 bg-warning/10 mt-4 rounded-lg border p-3 text-sm"
            >
              <p className="font-medium">Assessment unavailable</p>
              <p className="text-muted-foreground mt-1">
                The stored assessment could not be read ({projection.assessmentUnavailableCode}).
                This is not a clean result. Refresh before making a release decision.
              </p>
            </div>
          ) : projection.assessment ? (
            <div className="mt-4 space-y-3">
              <p className="text-muted-foreground text-sm">
                {identityLabel(projection.assessment.assessedIdentity)} · evaluated{" "}
                {formatDate(projection.assessment.evaluatedAt)}
              </p>
              {!projection.assessment.applicable && (
                <p className="border-warning/40 bg-warning/10 rounded-md border p-3 text-sm">
                  This stored verdict is historical. Run a current review for the release you intend
                  to ship.
                </p>
              )}
              {projection.coverage.status === "available" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-medium">Evaluated coverage</h3>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {projection.coverage.value.coverageStatement.length
                        ? projection.coverage.value.coverageStatement.join(", ")
                        : "No scanner completed an evaluation."}
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">Not covered</h3>
                    {projection.coverage.value.nonCoverage.length ? (
                      <ul className="text-muted-foreground mt-1 space-y-1 text-sm">
                        {projection.coverage.value.nonCoverage.map((item) => (
                          <li key={`${item.controlId}:${item.scanner}`}>
                            {item.scanner}: {item.reason ?? "coverage incomplete"}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground mt-1 text-sm">No recorded omissions.</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">Coverage unavailable.</p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground mt-3 text-sm">
              No completed launch assessment is stored for this target. Start with a bounded review;
              a clean result cannot be assumed before coverage completes.
            </p>
          )}

          {projection.remediation.status === "available" ? (
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <Datum label="New" value={projection.remediation.value.newFindings} />
              <Datum label="Recurring" value={projection.remediation.value.recurringFindings} />
              <Datum label="Resolved" value={projection.remediation.value.resolvedFindings} />
              <Datum label="Uncertain" value={projection.remediation.value.uncertainMatches} />
              <Datum label="Blocking" value={projection.remediation.value.blockingFindings} />
            </dl>
          ) : (
            <p role="status" className="text-muted-foreground mt-4 text-sm">
              Finding counts are unavailable. This does not mean there are no findings.
            </p>
          )}
        </div>

        <Link
          href={projection.nextAction.href}
          className={buttonVariants({ className: "min-h-11 w-full shrink-0 sm:w-auto" })}
        >
          {projection.nextAction.label}
          <ArrowRight className="ml-2 size-4" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  )
}

function Datum({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "unknown time"
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
}
