import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import type { ReleasePacketPayload } from "@lyrashield/types"
import { Badge, Card, buttonVariants } from "@lyrashield/ui"
import { PrintButton } from "./print-button"

const VERDICT_LABEL: Record<ReleasePacketPayload["assessment"]["state"], string> = {
  READY: "Ready to launch",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
}

const SIGNATURE_LABEL: Record<ReleasePacketPayload["signedAssessment"]["state"], string> = {
  SIGNED: "Signature verified",
  UNSIGNED: "Unsigned assessment",
  UNAVAILABLE: "Signature unavailable",
  INVALID: "Signature invalid",
  HISTORICAL: "Historical signature",
}

export function ReleasePacketView({
  payload,
  workspaceId,
  reportId,
}: {
  payload: ReleasePacketPayload
  workspaceId: string
  reportId: string
}) {
  const historical =
    payload.signedAssessment.state === "HISTORICAL" || !payload.assessment.applicable
  const csvHref = `/api/reports/release-packet/${encodeURIComponent(reportId)}/download?${new URLSearchParams({ workspaceId })}`
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8 print:max-w-none print:px-0 print:py-0">
      <style>{`@media print { .print-hide { display:none!important } body { background:white!important } a { color:inherit!important; text-decoration:none!important } }`}</style>
      <header className="border-border bg-card rounded-xl border p-5 sm:p-7 print:break-after-avoid">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-primary flex items-center gap-2 text-xs font-semibold tracking-[0.16em] uppercase">
              <ShieldCheck className="size-4" aria-hidden="true" />
              LyraShield private release packet
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
              {payload.target.name}
            </h1>
            <p className="text-muted-foreground mt-2 text-sm">
              {payload.target.type} · {payload.target.environment ?? "environment unavailable"} ·
              generated {formatDate(payload.generatedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <a href={csvHref} className={buttonVariants({ variant: "outline" })}>
              Download CSV
            </a>
            <PrintButton />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Badge
            variant={
              payload.assessment.state === "READY"
                ? "success"
                : payload.assessment.state === "NOT_READY"
                  ? "danger"
                  : "warning"
            }
          >
            {VERDICT_LABEL[payload.assessment.state]}
          </Badge>
          <Badge
            variant={
              payload.signedAssessment.state === "SIGNED"
                ? "success"
                : payload.signedAssessment.state === "INVALID"
                  ? "danger"
                  : "muted"
            }
          >
            {SIGNATURE_LABEL[payload.signedAssessment.state]}
          </Badge>
          {historical && <Badge variant="warning">Historical — not current evidence</Badge>}
        </div>
        {historical && (
          <div
            role="status"
            className="border-warning/40 bg-warning/10 mt-4 rounded-lg border p-3 text-sm"
          >
            This packet records what the stored assessment established. It does not certify the
            current revision.
          </div>
        )}
        {payload.signedAssessment.reason && (
          <p className="text-muted-foreground mt-3 text-sm">{payload.signedAssessment.reason}</p>
        )}
      </header>

      <section className="grid gap-4 md:grid-cols-2" aria-label="Assessment scope and integrity">
        <Card className="p-5">
          <h2 className="font-semibold">Assessment scope</h2>
          <dl className="mt-3 space-y-3 text-sm">
            <Datum label="Standard" value={payload.assessment.standardVersion} />
            <Datum
              label="Assessed release"
              value={
                payload.assessment.assessedIdentity
                  ? `${payload.assessment.assessedIdentity.kind === "COMMIT" ? "Commit" : "Artifact"} ${payload.assessment.assessedIdentity.value}`
                  : "Release identity unavailable"
              }
              mono
            />
            <Datum label="Evaluated" value={formatDate(payload.assessment.evaluatedAt)} />
            <Datum
              label="Assessment applicable now"
              value={payload.assessment.applicable ? "Yes" : "No"}
            />
          </dl>
          {payload.assessment.reasons.length > 0 && (
            <ul className="text-muted-foreground mt-3 list-disc space-y-1 pl-5 text-sm">
              {payload.assessment.reasons.map((reason) => (
                <li key={reason.code}>{reason.message}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="font-semibold">Evidence integrity</h2>
          <dl className="mt-3 space-y-3 text-sm">
            <Datum label="Packet SHA-256" value={payload.packetChecksum} mono />
            <Datum
              label="Assessment signature"
              value={SIGNATURE_LABEL[payload.signedAssessment.state]}
            />
            <Datum
              label="Result manifest"
              value={payload.coverage.manifestChecksum ?? "Unavailable"}
              mono
            />
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            The packet checksum detects changes to the frozen packet. It is not a separate
            signature; signature status refers only to the bound launch assessment.
          </p>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2" aria-label="Coverage">
        <CoverageCard title="Completed coverage" values={payload.coverage.completed} />
        <CoverageCard
          title="Incomplete or not applicable"
          values={[
            ...payload.coverage.incomplete.map((item) => `Incomplete: ${item}`),
            ...payload.coverage.notApplicable.map((item) => `Not applicable: ${item}`),
            ...payload.assessment.nonCoverage.map(
              (item) => `${item.scanner}: ${item.reason ?? "not covered"}`
            ),
          ]}
        />
      </section>

      <Card className="p-5">
        <h2 className="font-semibold">Fix and retest history</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="New" value={payload.remediation.counts.newFindings} />
          <Metric label="Recurring" value={payload.remediation.counts.recurringFindings} />
          <Metric label="Resolved" value={payload.remediation.counts.resolvedFindings} />
          <Metric label="Uncertain" value={payload.remediation.counts.uncertainMatches} />
        </dl>
        <p className="text-muted-foreground mt-3 text-xs">
          Resolved means a trusted deterministic retest established the resolution. Missing findings
          are not promoted to resolved.
        </p>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b p-5">
          <h2 className="font-semibold">Findings and remediation</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {payload.remediation.truncated
              ? "Detail rows are bounded; the counts above retain the full snapshot totals."
              : "All snapshot finding rows are included below."}
          </p>
        </div>
        {payload.remediation.findings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm print:min-w-0">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className="px-4 py-3">Finding</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3">Retest</th>
                  <th className="px-4 py-3">Proposal</th>
                  <th className="px-4 py-3">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {payload.remediation.findings.map((finding) => (
                  <tr key={finding.findingId} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium">{finding.title}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {finding.severity} · {finding.category} · {finding.verificationStatus}
                      </p>
                    </td>
                    <td className="px-4 py-3">{humanize(finding.status)}</td>
                    <td className="px-4 py-3">{humanize(finding.retestState)}</td>
                    <td className="px-4 py-3">{humanize(finding.proposalState)}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={finding.evidenceHref}
                        className="text-primary min-h-11 inline-flex items-center font-medium hover:underline"
                      >
                        Open finding
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground p-5 text-sm">
            No bounded detail rows were recorded for this packet.
          </p>
        )}
      </Card>

      <footer className="text-muted-foreground border-t pt-4 text-xs">
        Private workspace artifact. Access requires the share token and an authorized workspace
        session. The link can be revoked and does not make this packet a public report.
      </footer>
    </main>
  )
}

function Datum({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`mt-1 ${mono ? "break-all font-mono" : "break-words font-medium"}`}>
        {value}
      </dd>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function CoverageCard({ title, values }: { title: string; values: string[] }) {
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{title}</h2>
      {values.length ? (
        <ul className="text-muted-foreground mt-3 list-disc space-y-1 pl-5 text-sm">
          {values.map((value, index) => (
            <li key={`${index}-${value}`}>{value}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">None recorded.</p>
      )}
    </Card>
  )
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase())
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
}
