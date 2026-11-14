import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import type { ReleasePacketPayload } from "@lyrashield/types"
import type { ReleasePacketReadResult } from "@lyrashield/db"
import { Badge, Card, buttonVariants } from "@lyrashield/ui"
import { PrintButton } from "./print-button"

const VERDICT_LABEL: Record<ReleasePacketPayload["assessment"]["state"], string> = {
  READY: "Ready to launch",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
}

const PACKET_SIGNATURE_LABEL: Record<
  ReleasePacketReadResult["authenticity"]["signatureState"],
  string
> = {
  VERIFIED: "Packet signature verified",
  UNSIGNED: "Unsigned packet",
  UNAVAILABLE: "Packet signature unavailable",
  INVALID: "Packet signature invalid",
  REVOKED: "Packet signing key revoked",
  HISTORICAL_UNSIGNED: "Historical unsigned packet",
}
const ASSESSMENT_SIGNATURE_LABEL: Record<
  ReleasePacketReadResult["assessmentValidity"]["signatureState"],
  string
> = {
  VERIFIED: "Assessment signature verified",
  UNSIGNED: "Unsigned assessment",
  UNAVAILABLE: "Assessment signature unavailable",
  INVALID: "Assessment signature invalid",
  REVOKED: "Assessment signing key revoked",
}

export function ReleasePacketView({
  result,
  workspaceId,
  reportId,
  workspaceView = false,
}: {
  result: ReleasePacketReadResult
  workspaceId: string
  reportId: string
  workspaceView?: boolean
}) {
  const { payload } = result
  const Container = workspaceView ? "div" : "main"
  return (
    <Container className="mx-auto max-w-6xl space-y-5 px-4 py-8 print:max-w-none print:px-0 print:py-0">
      <style>{`@media print { .print-hide { display:none!important } body { background:white!important } a { color:inherit!important; text-decoration:none!important } }`}</style>
      <PacketHeader result={result} workspaceId={workspaceId} reportId={reportId} />
      <AssessmentSummarySection result={result} />
      <RemediationHistoryCard payload={payload} />
      <FindingsCard payload={payload} />
      <footer className="text-muted-foreground border-t pt-4 text-xs">
        {workspaceView
          ? "Private workspace artifact. Access requires workspace report permission. Private links also require an authorized workspace session and can be revoked."
          : "Private workspace artifact. Access requires the share token and an authorized workspace session. The link can be revoked and does not make this packet a public report."}
      </footer>
    </Container>
  )
}

function PacketHeader({
  result,
  workspaceId,
  reportId,
}: {
  result: ReleasePacketReadResult
  workspaceId: string
  reportId: string
}) {
  const { payload, authenticity, assessmentValidity, currentApplicability } = result
  const historical =
    payload.signedAssessment.state !== "SIGNED" ||
    authenticity.signatureState !== "VERIFIED" ||
    authenticity.expired !== false ||
    assessmentValidity.signatureState !== "VERIFIED" ||
    assessmentValidity.expired !== false ||
    currentApplicability.state !== "CURRENT"
  const exportable =
    authenticity.signatureState === "VERIFIED" ||
    authenticity.signatureState === "HISTORICAL_UNSIGNED"
  const csvHref = `/api/reports/release-packet/${encodeURIComponent(reportId)}/download?${new URLSearchParams({ workspaceId })}`
  return (
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
        {exportable && (
          <div className="flex flex-wrap gap-2 print:hidden">
            <a href={csvHref} className={buttonVariants({ variant: "outline" })}>
              Download CSV
            </a>
            <PrintButton />
          </div>
        )}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Badge
          variant={
            payload.assessment.state === "READY" && !historical
              ? "success"
              : payload.assessment.state === "NOT_READY"
                ? "danger"
                : "warning"
          }
        >
          Recorded: {VERDICT_LABEL[payload.assessment.state]}
        </Badge>
        <Badge
          variant={
            authenticity.signatureState === "VERIFIED"
              ? "success"
              : authenticity.signatureState === "INVALID" ||
                  authenticity.signatureState === "REVOKED"
                ? "danger"
                : "muted"
          }
        >
          {PACKET_SIGNATURE_LABEL[authenticity.signatureState]}
        </Badge>
        <Badge variant={assessmentValidity.signatureState === "VERIFIED" ? "success" : "muted"}>
          {ASSESSMENT_SIGNATURE_LABEL[assessmentValidity.signatureState]}
        </Badge>
        {authenticity.expired && <Badge variant="warning">Packet expired</Badge>}
        {assessmentValidity.expired && <Badge variant="warning">Assessment expired</Badge>}
        <Badge
          variant={currentApplicability.state === "CURRENT" && !historical ? "success" : "warning"}
        >
          {currentApplicability.state === "CURRENT"
            ? "Recorded evidence current"
            : currentApplicability.state === "NOT_CURRENT"
              ? "Evidence changed or expired"
              : "Current applicability unavailable"}
        </Badge>
        {historical && <Badge variant="warning">Historical — not current evidence</Badge>}
      </div>
      {historical && (
        <div
          role="status"
          className="border-warning/40 bg-warning/10 mt-4 rounded-lg border p-3 text-sm"
        >
          This packet is historical or could not be fully verified. It does not establish the
          current revision.
        </div>
      )}
      {payload.signedAssessment.reason && (
        <p className="text-muted-foreground mt-3 text-sm">{payload.signedAssessment.reason}</p>
      )}
    </header>
  )
}

function AssessmentSummarySection({ result }: { result: ReleasePacketReadResult }) {
  const { payload, assessmentValidity, currentApplicability } = result
  return (
    <>
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
              label="Applicable at issuance"
              value={payload.assessment.applicable ? "Yes" : "No"}
            />
            <Datum
              label="Current applicability"
              value={
                currentApplicability.state === "CURRENT"
                  ? "Current according to recorded evidence"
                  : currentApplicability.state === "NOT_CURRENT"
                    ? "Not current"
                    : "Unavailable"
              }
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
            {payload.version === "release_packet/1.1.0" && (
              <>
                <Datum
                  label="Packet signing key"
                  value={payload.signingKeyId ?? "Unavailable"}
                  mono
                />
                <Datum
                  label="Packet signature"
                  value={payload.packetSignature ?? "Unavailable"}
                  mono
                />
                <Datum
                  label="Packet expires"
                  value={payload.expiresAt ? formatDate(payload.expiresAt) : "Unavailable"}
                />
              </>
            )}
            <Datum
              label="Assessment signature"
              value={ASSESSMENT_SIGNATURE_LABEL[assessmentValidity.signatureState]}
            />
            <Datum
              label="Result manifest"
              value={payload.coverage.manifestChecksum ?? "Unavailable"}
              mono
            />
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            {payload.version === "release_packet/1.0.0"
              ? "This historical packet has a checksum but no packet signature. The assessment signature is checked separately."
              : "The packet signature authenticates the checksum of the complete frozen packet. The assessment signature is checked separately."}
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
    </>
  )
}

function RemediationHistoryCard({ payload }: { payload: ReleasePacketPayload }) {
  return (
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
  )
}

function FindingsCard({ payload }: { payload: ReleasePacketPayload }) {
  return (
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
