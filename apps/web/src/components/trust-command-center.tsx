import Link from "next/link"
import { ListChecks, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@lyrashield/ui"
import { modeLabel } from "@/lib/labels"

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

interface PostureVerdict {
  variant: "success" | "warning" | "danger" | "muted"
  text: string
  scope: string
}

/**
 * Derive the posture verdict from the last EVALUATED assessment only. A score
 * is always presented with the target and date it describes — never as a
 * workspace-wide clean bill of health.
 */
export function postureVerdict(
  latestScore: {
    score: number
    grade: string
    targetName: string
    completedAtLabel: string
  } | null
): PostureVerdict {
  if (!latestScore) {
    return {
      variant: "muted",
      text: "Not scored",
      scope: "Run a review to capture your first evidence.",
    }
  }
  const variant =
    latestScore.score >= 80 ? "success" : latestScore.score >= 50 ? "warning" : "danger"
  const text =
    latestScore.score >= 80
      ? "Ready within completed scope"
      : latestScore.score >= 50
        ? "Needs attention"
        : "Needs action"
  return {
    variant,
    text,
    scope: `Grade ${latestScore.grade.replace("_PLUS", "+")} · ${latestScore.targetName} · ${latestScore.completedAtLabel}`,
  }
}

/**
 * Current posture header for Home. Server-rendered and static: no count-up,
 * no delayed reveal, no duration estimate (duration belongs to a selected
 * target/review combination in the run composer).
 */
export function TrustCommandCenter({
  productName,
  mode,
  trustPlanData,
  latestScore,
}: {
  productName: string
  /** Depth of the most recent run, or null when none has run yet. */
  mode: string | null
  trustPlanData: unknown
  latestScore: { score: number; grade: string; targetName: string; completedAtLabel: string } | null
}) {
  const verdict = postureVerdict(latestScore)

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
                ? "Depth of the most recent run in this workspace."
                : "Depth appears after your first run."}
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
