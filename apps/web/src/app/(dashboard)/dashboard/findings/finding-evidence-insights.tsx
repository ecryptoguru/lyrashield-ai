import { Badge } from "@lyrashield/ui"
import { z } from "zod"

/**
 * Engine-declared claim-context projection — allowlisted server-side, every
 * field labeled as an engine assertion rather than app verification.
 */
export const evidenceInsightsSchema = z
  .object({
    counterevidence: z.string().optional(),
    evidenceWarnings: z.array(z.string()).optional(),
    severityChangeConditions: z.string().optional(),
    assumptions: z.string().optional(),
    confidenceRationale: z.string().optional(),
    contextualCvssReasoning: z.string().optional(),
    advisoryCvss: z
      .object({
        score: z.number(),
        vector: z.string().optional(),
        source: z.string().optional(),
        metric_reasoning: z.string().optional(),
      })
      .optional(),
    engineVerificationState: z.string().optional(),
    engineConfidence: z.string().optional(),
    capturedHttpExchangeIds: z
      .array(z.string().regex(/^[0-9]{1,128}$/))
      .max(10)
      .optional(),
    pendingHttpExchangeIds: z
      .array(z.string().regex(/^[0-9]{1,128}$/))
      .max(10)
      .optional(),
    pendingHttpExchangeState: z.literal("PENDING").optional(),
    evidenceObservationScanId: z.string().max(128).optional(),
    legacyEvidenceContext: z.literal(true).optional(),
  })
  .nullable()

type EvidenceInsights = NonNullable<z.infer<typeof evidenceInsightsSchema>>
function HttpExchangeEvidence({ insights }: { insights: EvidenceInsights }) {
  return (
    <>
      {!!insights.capturedHttpExchangeIds?.length && (
        <div>
          <dt className="text-muted-foreground text-xs">HTTP exchange evidence</dt>
          <dd className="mt-0.5 text-xs">
            <Badge variant="muted">Captured</Badge>
            <p className="mt-1">These exchange IDs are in this scan’s stored export.</p>
            <p className="mt-1 break-all font-mono">
              {insights.capturedHttpExchangeIds.join(", ")}
            </p>
          </dd>
        </div>
      )}
      {!!insights.pendingHttpExchangeIds?.length && (
        <div>
          <dt className="text-muted-foreground text-xs">HTTP exchange evidence</dt>
          <dd className="mt-0.5 text-xs">
            <Badge variant="muted">Pending</Badge>
            <p className="mt-1">
              Exchange claims await bound evidence. They do not verify this finding.
            </p>
            <p className="mt-1 break-all font-mono">{insights.pendingHttpExchangeIds.join(", ")}</p>
          </dd>
        </div>
      )}
    </>
  )
}

export function FindingEvidenceInsights({ insights }: { insights: EvidenceInsights }) {
  return (
    <div className="rounded-lg border p-3">
      <h3 className="text-sm font-medium">Engine-declared evidence</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Assertions the engine recorded for this finding. They are evidence about the engine&apos;s
        own view — not LyraShield verification.
      </p>
      {insights.legacyEvidenceContext && (
        <p className="text-muted-foreground mt-1 text-xs">
          Historical context; its scan association is unavailable.
        </p>
      )}
      {insights.evidenceObservationScanId && (
        <p className="text-muted-foreground mt-1 break-all text-xs">
          Evidence from scan {insights.evidenceObservationScanId}
        </p>
      )}
      <dl className="mt-2 space-y-2 text-sm">
        {insights.advisoryCvss != null && (
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground text-xs">Advisory severity</dt>
            <dd>
              <Badge variant="warning">Advisory CVSS {insights.advisoryCvss.score}</Badge>
            </dd>
          </div>
        )}
        {insights.advisoryCvss?.vector && (
          <div>
            <dt className="text-muted-foreground text-xs">Advisory vector</dt>
            <dd className="text-muted-foreground mt-0.5 break-all font-mono text-xs">
              {insights.advisoryCvss.vector}
            </dd>
          </div>
        )}
        {insights.advisoryCvss?.metric_reasoning && (
          <div>
            <dt className="text-muted-foreground text-xs">Advisory metric reasoning</dt>
            <dd className="text-muted-foreground mt-0.5 text-xs">
              {insights.advisoryCvss.metric_reasoning}
            </dd>
          </div>
        )}
        <HttpExchangeEvidence insights={insights} />
        {insights.engineConfidence && (
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground text-xs">Engine confidence</dt>
            <dd>
              <Badge variant="muted">{insights.engineConfidence} (engine-declared)</Badge>
            </dd>
          </div>
        )}
        {insights.engineVerificationState && (
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground text-xs">Engine claim</dt>
            <dd>
              <Badge variant="muted">{insights.engineVerificationState} (engine-declared)</Badge>
            </dd>
          </div>
        )}
        {insights.contextualCvssReasoning && (
          <div>
            <dt className="text-muted-foreground text-xs">Contextual severity reasoning</dt>
            <dd className="text-muted-foreground mt-0.5 text-xs">
              {insights.contextualCvssReasoning}
            </dd>
          </div>
        )}
        {insights.confidenceRationale && (
          <div>
            <dt className="text-muted-foreground text-xs">Confidence rationale</dt>
            <dd className="text-muted-foreground mt-0.5 text-xs">{insights.confidenceRationale}</dd>
          </div>
        )}
        {insights.counterevidence && (
          <div>
            <dt className="text-muted-foreground text-xs">Counterevidence</dt>
            <dd className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
              {insights.counterevidence}
            </dd>
          </div>
        )}
        {insights.severityChangeConditions && (
          <div>
            <dt className="text-muted-foreground text-xs">Severity change conditions</dt>
            <dd className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
              {insights.severityChangeConditions}
            </dd>
          </div>
        )}
        {insights.assumptions && (
          <div>
            <dt className="text-muted-foreground text-xs">Assumptions</dt>
            <dd className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
              {insights.assumptions}
            </dd>
          </div>
        )}
        {(insights.evidenceWarnings?.length ?? 0) > 0 && (
          <div>
            <dt className="text-muted-foreground text-xs">Evidence warnings</dt>
            <dd>
              <ul className="mt-0.5 list-inside list-disc text-xs text-amber-600">
                {insights.evidenceWarnings!.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}
