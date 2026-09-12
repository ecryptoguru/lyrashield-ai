import type { LaunchReportShareablePayload } from "./launch-report-payload"

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function list(items: string[], empty: string) {
  return items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(empty)}</p>`
}

/** Render only the frozen, allowlisted launch-report payload. */
export function generateLaunchReportHTML(raw: unknown): string {
  const data = raw as LaunchReportShareablePayload
  const medium = data.counts.unresolvedMedium ?? "Not evaluated"
  const low = data.counts.unresolvedLow ?? "Not evaluated"
  const historical = data.stale
    ? '<div class="notice">Historical report: this assessment is stale or expired.</div>'
    : ""

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LyraShield Launch Readiness Report</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{font:15px/1.55 system-ui,sans-serif;margin:0;background:#f4f8fb;color:#102033}.page{max-width:820px;margin:auto;padding:40px 24px}.card{background:#fff;border:1px solid #dce5ed;border-radius:14px;padding:22px;margin:18px 0}.meta{color:#617083}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{border:1px solid #dce5ed;border-radius:10px;padding:12px}.metric strong{display:block;font-size:24px}.notice{border:1px solid #d97706;background:#fffbeb;color:#78350f;border-radius:10px;padding:12px}code{overflow-wrap:anywhere}@media(max-width:620px){.grid{grid-template-columns:1fr 1fr}.page{padding:24px 14px}}@media print{body{background:#fff}.page{max-width:none;padding:0}.card{break-inside:avoid}}
</style></head><body><main class="page">
<p class="meta">LyraShield AI · ${escapeHtml(data.standardVersion)}</p><h1>Launch Readiness Report</h1>
<p>${escapeHtml(data.appDisplayName)} · Assessed ${escapeHtml(data.assessmentDate ?? data.evaluatedAt)} · Issued ${escapeHtml(data.issuedAt)}</p>
${historical}<section class="card"><h2>${escapeHtml(data.verdictLabel)}</h2><div class="grid">
<div class="metric">Unresolved critical<strong>${data.counts.unresolvedCritical}</strong></div>
<div class="metric">Unresolved high<strong>${data.counts.unresolvedHigh}</strong></div>
<div class="metric">Unresolved medium<strong>${medium}</strong></div>
<div class="metric">Unresolved low<strong>${low}</strong></div>
<div class="metric">Retest-confirmed<strong>${data.counts.fixedAndRetestConfirmed}</strong></div>
<div class="metric">Independently verified<strong>${data.counts.independentlyVerified}</strong></div>
</div></section><section class="card"><h2>What was examined</h2>${list(data.coverageStatement, "No scanner completed an evaluation.")}
<h2>What was not covered</h2>${list(data.nonCoverage, "No exclusions were recorded.")}</section>
<section class="card"><h2>Integrity</h2><p>Report checksum</p><code>${escapeHtml(data.reportChecksum)}</code>
<p class="meta">${data.signature ? "Signed report" : "Signature unavailable"}</p></section>
<p class="meta">This verdict reflects the named standard and retained evidence. It is not a guarantee that the application is free of vulnerabilities.</p>
</main></body></html>`
}
