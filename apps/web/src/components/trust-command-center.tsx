import Link from "next/link"
import { ListChecks, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@lyrashield/ui"
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

export interface GatePosture {
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
export function postureVerdict(
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
          scope: "Run a review to capture your first evidence.",
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
  latestScore,
}: {
  productName: string
  /** Depth of the most recent scan, or null when none has run yet. */
  mode: string | null
  trustPlanData: unknown
  gate: GatePosture | null
  latestScore: { score: number; grade: string; targetName: string; completedAtLabel: string } | null
}) {
  const verdict = postureVerdict(gate, latestScore)

  return (
    <section aria-label="Current posture" className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{productName}</h2>
          <p className="text-muted-foreground text-sm">Assurance status and active review plan</p>
        </div>
        <div className="sm:text-right">
          <Badge variant={verdict.variant}>{verdict.text}</Badge>
          <p className="text-muted-foreground mt-1 text-xs">{verdict.scope}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Trust plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <ListChecks className="text-primary size-5" aria-hidden="true" />
              <span className="text-lg font-semibold">{trustPlanLabel(trustPlanData)}</span>
            </div>
            <p className="text-muted-foreground text-xs">
              The checks this workspace runs before release. Default covers the standard pre-release
              checks.
            </p>
            <Link
              href="/dashboard/scans?tab=monitoring"
              className="text-muted-foreground decoration-border hover:text-foreground text-xs underline underline-offset-4"
            >
              Manage recurring checks.
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Latest review depth</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <ShieldCheck className="text-primary size-5" aria-hidden="true" />
              <span className="text-lg font-semibold">
                {mode ? modeLabel(mode) : "No review yet"}
              </span>
            </div>
            <p className="text-muted-foreground text-xs">
              {mode
                ? "Depth of the most recent scan in this workspace."
                : "Depth appears after your first scan."}
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
