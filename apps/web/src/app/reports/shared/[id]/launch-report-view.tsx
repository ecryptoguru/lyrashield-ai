import { CheckCircle2, AlertTriangle, HelpCircle, ShieldCheck, Calendar, Hash } from "lucide-react"
import { Badge, Card } from "@lyrashield/ui"
import type { LaunchReportShareablePayload } from "@lyrashield/db"

/**
 * Public renderer for a shared Launch Readiness Report (WP4). Receives ONLY the
 * allowlisted payload built by buildLaunchReportPayload — no finding detail,
 * no target internals, no raw evidence. Copy-constraint compliant: it states
 * the verdict against a named standard and discloses non-coverage; it never
 * claims the app "is secure".
 */

const VERDICT_TONE: Record<
  string,
  { variant: "success" | "warning" | "muted"; Icon: typeof CheckCircle2 }
> = {
  "Ready to launch": { variant: "success", Icon: CheckCircle2 },
  "Not ready": { variant: "warning", Icon: AlertTriangle },
  "Not enough evidence": { variant: "muted", Icon: HelpCircle },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

export function SharedLaunchReportView({ payload }: { payload: LaunchReportShareablePayload }) {
  const tone = VERDICT_TONE[payload.verdictLabel] ?? VERDICT_TONE["Not enough evidence"]!
  const Icon = tone.Icon
  const verifyUrl = `/reports/verify`

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">LyraShield AI</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Launch Readiness Report</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {payload.appDisplayName} — evaluated against {payload.standardVersion}
          </p>
        </div>
        <ShieldCheck className="h-8 w-8 text-primary" aria-hidden />
      </div>

      {/* Staleness banner — a stale verdict is never presented as current. */}
      {payload.stale && (
        <div
          role="status"
          className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          This report reflects an earlier evaluation. The code has changed since — treat this as
          superseded and ask the team to re-run the gate.
        </div>
      )}

      {/* Verdict */}
      <Card className="mb-6 p-6">
        <div className="flex items-center gap-3">
          <Icon className="h-6 w-6" aria-hidden />
          <div>
            <Badge variant={tone.variant}>{payload.verdictLabel}</Badge>
            <p className="mt-1 text-xs text-muted-foreground">
              Verdict against the {payload.standardVersion} readiness standard
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Unresolved critical</p>
            <p className="text-lg font-semibold">{payload.counts.unresolvedCritical}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Unresolved high</p>
            <p className="text-lg font-semibold">{payload.counts.unresolvedHigh}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Fixed &amp; retest-confirmed</p>
            <p className="text-lg font-semibold">{payload.counts.fixedAndRetestConfirmed}</p>
          </div>
        </div>
      </Card>

      {/* Coverage honesty */}
      <Card className="mb-6 p-6">
        <h2 className="text-sm font-semibold">What was examined</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {payload.coverageStatement.length > 0
            ? `Evaluated: ${payload.coverageStatement.join(", ")}.`
            : "No scanner completed an evaluation."}
        </p>
        {payload.nonCoverage.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold">What was not covered</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Not examined: {payload.nonCoverage.join(", ")}.
            </p>
          </>
        )}
      </Card>

      {/* Integrity */}
      <Card className="p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Hash className="h-4 w-4" aria-hidden /> Verify this document
        </h2>
        <dl className="mt-3 space-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5" aria-hidden />
            <span>
              Evaluated {formatDate(payload.evaluatedAt)} · Issued {formatDate(payload.issuedAt)}
            </span>
          </div>
          <div className="break-all">
            <dt className="sr-only">Checksum</dt>
            <dd>
              <span className="font-medium text-foreground">SHA-256:</span>{" "}
              <code>{payload.reportChecksum}</code>
            </dd>
          </div>
          {payload.signature && (
            <div className="break-all">
              <dt className="sr-only">Signature</dt>
              <dd>
                <span className="font-medium text-foreground">Signature (ed25519):</span>{" "}
                <code>{payload.signature}</code>
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          {payload.signature ? (
            <>
              Verify this document was issued by LyraShield and not edited since issue at{" "}
              <a href={verifyUrl} className="text-primary underline">
                {verifyUrl}
              </a>
              .
            </>
          ) : (
            "This report was issued without a signature on this deployment."
          )}
        </p>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        A launch-readiness verdict reflects the named standard and the evidence examined — it is not
        a guarantee that an application is free of vulnerabilities.
      </p>
    </div>
  )
}
