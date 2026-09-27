import Link from "next/link"
import { ListChecks } from "lucide-react"
import { Badge } from "@lyrashield/ui"
import { modeLabel } from "@/lib/labels"

function trustPlanLabel(data: unknown): string {
  if (!data || typeof data !== "object") return "Default controls"
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
  return "Custom controls"
}

interface PostureVerdict {
  variant: "success" | "warning" | "danger" | "muted"
  text: string
  scope: string
}

interface GatePosture {
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  /** Human summary of assessment freshness/coverage across active targets. */
  coverageLabel: string
}

/**
 * Derive the posture verdict from the canonical gate state first (W1-04): a
 * clean score never overrides insufficient evidence or a blocking gate. The
 * score — always presented with the target and date it describes — is scope
 * context, never the decision.
 */
function postureVerdict(
  gate: GatePosture | null,
  latestScore: {
    score: number
    grade: string
    targetName: string
    completedAtLabel: string
  } | null
): PostureVerdict {
  const scoreScope = latestScore
    ? `Grade ${latestScore.grade.replace("_PLUS", "+")} · ${latestScore.targetName} · ${latestScore.completedAtLabel}`
    : "No evaluated review yet"
  if (!gate) {
    return latestScore
      ? {
          variant:
            latestScore.score >= 80 ? "success" : latestScore.score >= 50 ? "warning" : "danger",
          text:
            latestScore.score >= 80
              ? "Ready within completed scope"
              : latestScore.score >= 50
                ? "Needs attention"
                : "Needs action",
          scope: scoreScope,
        }
      : {
          variant: "muted",
          text: "Not scored",
          scope: "Run a scan to capture your first evidence.",
        }
  }
  switch (gate.state) {
    case "READY":
      return {
        variant: "success",
        text: "Ready to launch",
        scope: `${gate.coverageLabel} · ${scoreScope}`,
      }
    case "NOT_READY":
      return {
        variant: "danger",
        text: "Not ready to launch",
        scope: `${gate.coverageLabel} · resolve blockers before a launch decision`,
      }
    case "INSUFFICIENT_EVIDENCE":
      return {
        variant: "warning",
        text: "Insufficient evidence",
        scope: `${gate.coverageLabel} · a clean score is not evidence`,
      }
  }
}

/**
 * Current posture header for Home. Server-rendered and static: no count-up,
 * no delayed reveal, no duration estimate (duration belongs to a selected
 * target/review combination in the scan composer).
 */
export function TrustCommandCenter({
  productName,
  mode,
  trustPlanData,
  gate,
  targetScope,
  latestAssessment,
  limitations,
  latestScore,
}: {
  productName: string
  /** Depth of the most recent scan, or null when none has run yet. */
  mode: string | null
  trustPlanData: unknown
  gate: GatePosture | null
  targetScope: string
  latestAssessment: { targetName: string; completedAtLabel: string } | null
  limitations: string[]
  latestScore: { score: number; grade: string; targetName: string; completedAtLabel: string } | null
}) {
  const verdict = postureVerdict(gate, latestScore)

  return (
    <section aria-label="Current evidence" className="rounded-xl border p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Current evidence
          </p>
          <h2 className="mt-1 text-xl font-bold tracking-tight">{productName}</h2>
        </div>
        <Badge variant={verdict.variant} className="w-fit">
          {verdict.text}
        </Badge>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Target scope</dt>
          <dd className="mt-1 font-medium">{targetScope}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Evidence coverage</dt>
          <dd className="mt-1 font-medium">{gate?.coverageLabel ?? "No current assessment"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Latest evaluated review</dt>
          <dd className="mt-1 font-medium">
            {latestAssessment
              ? `${latestAssessment.targetName} · ${latestAssessment.completedAtLabel}`
              : "No evaluated review yet"}
          </dd>
        </div>
      </dl>

      {limitations.length > 0 && (
        <div className="border-warning/50 bg-warning/10 mt-4 rounded-lg border p-3" role="status">
          <h3 className="text-sm font-semibold">Evidence still needs attention</h3>
          <ul className="mt-1 list-inside list-disc space-y-1 text-sm">
            {limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}

      {!gate && <p className="text-muted-foreground mt-3 text-xs">{verdict.scope}</p>}

      {latestScore && gate?.state === "READY" && (
        <p className="text-muted-foreground mt-3 text-xs">
          {verdict.scope}. A ready state applies only to the evidence shown here.
        </p>
      )}

      <details className="mt-4 border-t pt-3">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <ListChecks className="text-primary size-4" aria-hidden="true" />
          Review plan details
        </summary>
        <div className="text-muted-foreground grid gap-2 pb-1 text-sm sm:grid-cols-2">
          <p>
            Active plan: <span className="text-foreground">{trustPlanLabel(trustPlanData)}</span>
          </p>
          <p>
            Latest review depth:{" "}
            <span className="text-foreground">{mode ? modeLabel(mode) : "None yet"}</span>
          </p>
          <Link
            href="/dashboard/scans?tab=monitoring"
            className="text-primary min-h-11 w-fit underline underline-offset-4 sm:col-span-2"
          >
            Manage recurring checks
          </Link>
        </div>
      </details>
    </section>
  )
}
