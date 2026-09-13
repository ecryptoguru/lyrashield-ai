import {
  computeLaunchReportChecksum,
  LAUNCH_REPORT_PAYLOAD_VERSION,
  type LaunchReportShareablePayload,
} from "./launch-report-payload"

const VERDICT_LABELS = new Set(["Ready to launch", "Not ready", "Not enough evidence"])
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const isNullableCount = (value: unknown): value is number | null => value === null || isCount(value)
const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string"

export function isLaunchReportShareablePayload(
  value: unknown
): value is LaunchReportShareablePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const payload = value as Partial<LaunchReportShareablePayload>
  const shapeValid =
    payload.payloadVersion === LAUNCH_REPORT_PAYLOAD_VERSION &&
    typeof payload.verdictLabel === "string" &&
    VERDICT_LABELS.has(payload.verdictLabel) &&
    typeof payload.standardVersion === "string" &&
    typeof payload.appDisplayName === "string" &&
    typeof payload.evaluatedAt === "string" &&
    typeof payload.issuedAt === "string" &&
    Array.isArray(payload.coverageStatement) &&
    payload.coverageStatement.every((item) => typeof item === "string") &&
    Array.isArray(payload.nonCoverage) &&
    payload.nonCoverage.every((item) => typeof item === "string") &&
    !!payload.counts &&
    isCount(payload.counts.unresolvedCritical) &&
    isCount(payload.counts.unresolvedHigh) &&
    isNullableCount(payload.counts.unresolvedMedium) &&
    isNullableCount(payload.counts.unresolvedLow) &&
    isCount(payload.counts.fixedAndRetestConfirmed) &&
    isCount(payload.counts.independentlyVerified) &&
    Array.isArray(payload.notEvaluatedSeverities) &&
    payload.notEvaluatedSeverities.every((item) => typeof item === "string") &&
    typeof payload.stale === "boolean" &&
    typeof payload.reportChecksum === "string" &&
    isOptionalString(payload.assessmentDate) &&
    isOptionalString(payload.expiresAt) &&
    isOptionalString(payload.scopeCommitment) &&
    isOptionalString(payload.signature) &&
    isOptionalString(payload.signingKeyId) &&
    (payload.dispositionCounts === undefined ||
      (!!payload.dispositionCounts &&
        typeof payload.dispositionCounts === "object" &&
        !Array.isArray(payload.dispositionCounts) &&
        isCount(payload.dispositionCounts.acceptedRisk) &&
        isCount(payload.dispositionCounts.falsePositive)))
  if (!shapeValid) return false

  try {
    const { reportChecksum, signature, signingKeyId, ...unsigned } =
      payload as LaunchReportShareablePayload
    void signature
    void signingKeyId
    return computeLaunchReportChecksum(unsigned) === reportChecksum
  } catch {
    return false
  }
}

export function generateLaunchReportHTML(payload: LaunchReportShareablePayload): string {
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt).getTime() : Number.NaN
  const historical = payload.stale || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
  const count = (value: number | null) => (value === null ? "Not evaluated" : String(value))
  const coverage =
    payload.coverageStatement.length > 0
      ? `Evaluated: ${payload.coverageStatement.map(escapeHtml).join(", ")}.`
      : "No scanner completed an evaluation."
  const nonCoverage =
    payload.nonCoverage.length > 0
      ? `<h3>What was not covered</h3><p>Not examined: ${payload.nonCoverage.map(escapeHtml).join(", ")}.</p>`
      : ""
  const dispositions = payload.dispositionCounts ?? { acceptedRisk: 0, falsePositive: 0 }
  const dispositionSection =
    dispositions.acceptedRisk > 0 || dispositions.falsePositive > 0
      ? `<p class="muted">Recorded human dispositions: ${dispositions.acceptedRisk} accepted risk, ${dispositions.falsePositive} false positive. These are policy decisions, not technical verification.</p>`
      : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LyraShield Launch Readiness Report</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f8fb;color:#102033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}.container{max-width:800px;margin:0 auto;padding:40px 24px}.header,.section{background:#fff;border:1px solid #dce5ed;border-radius:14px;padding:24px;margin-bottom:20px}.header{background:#102b43;color:#f5fbff}.header p{color:#c8dce8}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.verdict{font-size:28px;font-weight:750;margin:8px 0}.historical{border:1px solid #f4c15d;background:#fff8e6;color:#713f12;border-radius:10px;padding:14px;margin-bottom:20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{border:1px solid #dce5ed;border-radius:10px;padding:14px}.metric span{display:block;color:#617083;font-size:12px}.metric strong{font-size:22px}.section h2{font-size:18px;margin:0 0 12px}.section h3{font-size:14px;margin:18px 0 6px}.section p{margin:6px 0}.muted{color:#617083;font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}.footer{text-align:center;color:#617083;font-size:12px}@media(max-width:650px){.container{padding:20px 12px}.grid{grid-template-columns:1fr 1fr}}@media print{body{background:#fff}.container{max-width:none;padding:0}}
  </style>
</head>
<body>
  <main class="container">
    ${historical ? '<div class="historical" role="status">This historical report is superseded, expired, or predates current applicability rules. Ask the team to run a current gate assessment.</div>' : ""}
    <header class="header">
      <div class="eyebrow">LyraShield AI</div>
      <h1>Launch Readiness Report</h1>
      <div class="verdict">${historical ? "Historical: " : ""}${escapeHtml(payload.verdictLabel)}</div>
      <p>${escapeHtml(payload.appDisplayName)} — evaluated against ${escapeHtml(payload.standardVersion)}</p>
    </header>
    <section class="section">
      <h2>Assessment outcome</h2>
      <div class="grid">
        ${metric("Unresolved critical", String(payload.counts.unresolvedCritical))}
        ${metric("Unresolved high", String(payload.counts.unresolvedHigh))}
        ${metric("Unresolved medium", count(payload.counts.unresolvedMedium))}
        ${metric("Unresolved low", count(payload.counts.unresolvedLow))}
        ${metric("Fixed & retest-confirmed", String(payload.counts.fixedAndRetestConfirmed))}
        ${metric("Independently verified", String(payload.counts.independentlyVerified))}
      </div>
    </section>
    <section class="section">
      <h2>What was examined</h2>
      <p>${coverage}</p>
      <p class="muted">Scope: ${escapeHtml(payload.scopeCommitment ?? "The original report did not record an explicit scope commitment.")}</p>
      ${nonCoverage}
      ${dispositionSection}
    </section>
    <section class="section">
      <h2>Document integrity</h2>
      <p>Assessed ${formatDate(payload.assessmentDate ?? payload.evaluatedAt)}${payload.expiresAt ? ` · Expires ${formatDate(payload.expiresAt)}` : ""} · Issued ${formatDate(payload.issuedAt)}</p>
      <p class="mono"><strong>SHA-256:</strong> ${escapeHtml(payload.reportChecksum)}</p>
      ${payload.signature ? `<p class="mono"><strong>Signature (ed25519):</strong> ${escapeHtml(payload.signature)}</p>` : '<p class="muted">This report was issued without a signature on this deployment.</p>'}
      ${payload.signingKeyId ? `<p class="mono"><strong>Signing key:</strong> ${escapeHtml(payload.signingKeyId)}</p>` : ""}
    </section>
    <p class="footer">A launch-readiness verdict reflects the named standard and evidence examined — it is not a guarantee that an application is free of vulnerabilities.</p>
  </main>
</body>
</html>`
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unknown" : escapeHtml(date.toISOString().split("T")[0]!)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
