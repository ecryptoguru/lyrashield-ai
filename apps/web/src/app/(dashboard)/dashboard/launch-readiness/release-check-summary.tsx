import Link from "next/link"
import { Card } from "@lyrashield/ui"
import { gateReasonSentence, type ReleaseCheckResult } from "@/lib/launch-readiness"

const HISTORICAL_STATE_LABEL: Record<string, string> = {
  READY: "Ready to launch",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
}

function identityText(identity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null) {
  if (!identity) return null
  return identity.kind === "COMMIT" ? `commit ${identity.value}` : `artifact ${identity.value}`
}

export function ReleaseCheckSummary({ releaseCheck }: { releaseCheck: ReleaseCheckResult | null }) {
  if (!releaseCheck?.requested) return null
  return (
    <Card
      className={`p-5 ${
        releaseCheck.match === "match"
          ? "border-emerald-500/20 bg-emerald-500/5"
          : releaseCheck.match === "mismatch"
            ? "border-destructive/20 bg-destructive/5"
            : "border-border bg-muted/30"
      }`}
    >
      <div role="status" aria-live="polite">
        <h3 className="font-semibold">
          {releaseCheck.match === "match"
            ? "Release reference matches this assessment."
            : releaseCheck.match === "mismatch"
              ? "This assessment covers a different release."
              : "Cannot confirm this release from the retained assessment."}
        </h3>
        <dl className="text-muted-foreground mt-3 space-y-1 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium">Target:</dt>
            <dd>{releaseCheck.targetName ?? "Unknown target"}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium">Requested:</dt>
            <dd>
              <code className="break-all">{identityText(releaseCheck.requested)}</code>
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium">Assessed:</dt>
            <dd>
              {releaseCheck.assessed ? (
                <code className="break-all">{identityText(releaseCheck.assessed)}</code>
              ) : (
                "No release identity is retained in this assessment."
              )}
            </dd>
          </div>
          {releaseCheck.historicalState && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-medium">Historical verdict:</dt>
              <dd>
                {HISTORICAL_STATE_LABEL[releaseCheck.historicalState] ??
                  releaseCheck.historicalState}
                {" · effective now: "}
                {HISTORICAL_STATE_LABEL[releaseCheck.state] ?? releaseCheck.state}
              </dd>
            </div>
          )}
        </dl>
        {releaseCheck.reasons.length > 0 && (
          <ul className="mt-3 space-y-1">
            {releaseCheck.reasons.map((reason) => (
              <li key={reason.code} className="text-foreground/80 text-sm">
                {gateReasonSentence(reason)}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {releaseCheck.blockingFindings > 0 && (
            <Link
              href={`/dashboard/findings?target=${encodeURIComponent(releaseCheck.targetId)}`}
              className="text-accent font-medium underline underline-offset-4"
            >
              Inspect blocking findings
            </Link>
          )}
          {releaseCheck.reasons.some((r) => r.code === "NEWER_ASSESSMENT_ATTEMPT") && (
            <Link
              href={`/dashboard/scans?target=${encodeURIComponent(releaseCheck.targetId)}`}
              className="text-accent font-medium underline underline-offset-4"
            >
              Review the newer assessment
            </Link>
          )}
          {(releaseCheck.match !== "match" || !releaseCheck.applicable) && (
            <Link
              href={`/dashboard/scans?new=1&target=${encodeURIComponent(releaseCheck.targetId)}`}
              className="text-accent font-medium underline underline-offset-4"
            >
              Open scan creation
            </Link>
          )}
        </div>
      </div>
    </Card>
  )
}
