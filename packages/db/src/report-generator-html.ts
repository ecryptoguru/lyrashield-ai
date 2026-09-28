import { env } from "@lyrashield/config"
import type { ReportData } from "./report-generator.validation"

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "#dc2626",
  HIGH: "#ea580c",
  MEDIUM: "#ca8a04",
  LOW: "#2563eb",
  INFO: "#6b7280",
}

const STATUS_COLORS: Record<string, string> = {
  OPEN: "#dc2626",
  FIXED: "#16a34a",
  PR_OPENED: "#2563eb",
  ACCEPTED_RISK: "#ca8a04",
  FALSE_POSITIVE: "#6b7280",
}

export function generateReportHTML(data: ReportData): string {
  const findingsRows = data.findings
    .map((f) => {
      const sevColor = SEVERITY_COLORS[f.severity] ?? "#6b7280"
      const statusColor = STATUS_COLORS[f.status] ?? "#6b7280"
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;background:${sevColor};font-size:11px;font-weight:600;">${escapeHtml(f.severity)}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
            <strong>${escapeHtml(f.title)}</strong>
            ${f.cwe ? `<br><span style="font-size:11px;color:#6b7280;">${escapeHtml(f.cwe)}</span>` : ""}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;">
            ${escapeHtml(f.summary).slice(0, 120)}${f.summary.length > 120 ? "…" : ""}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;background:${statusColor};font-size:11px;font-weight:600;">${escapeHtml(f.status)}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;">
            ${f.verified ? "✅ Verified" : `⚠️ ${escapeHtml((f.verificationStatus ?? "DETECTED").replaceAll("_", " "))}`}<br>
            <span style="color:#6b7280;">${escapeHtml(f.confidence)} evidence strength (heuristic; not verification)</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;">
            ${f.fixStatus !== "none" ? `Fix: ${escapeHtml(f.fixStatus)}` : "No fix yet"}
            ${f.retestStatus ? `<br>Retest: ${escapeHtml(f.retestStatus)}` : ""}
          </td>
        </tr>
      `
    })
    .join("")

  const severityMax = Math.max(1, ...Object.values(data.findingsBySeverity))
  const severityBars = Object.entries(data.findingsBySeverity)
    .map(([sev, count]) => {
      const color = SEVERITY_COLORS[sev] ?? "#6b7280"
      return `<div class="bar-row">
        <span class="bar-label" style="color:${color};">${escapeHtml(sev)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (count / severityMax) * 100)}%;background:${color};"></span></span>
        <span class="bar-value">${count}</span>
      </div>`
    })
    .join("")

  const renderMetricBars = (values: Record<string, number> | undefined) => {
    if (!values || Object.keys(values).length === 0)
      return "<p class='muted'>No data available.</p>"
    const max = Math.max(1, ...Object.values(values))
    return Object.entries(values)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([label, count]) => `<div class="bar-row">
          <span class="bar-label">${escapeHtml(label.replaceAll("_", " "))}</span>
          <span class="bar-track"><span class="bar-fill accent" style="width:${Math.max(4, (count / max) * 100)}%;"></span></span>
          <span class="bar-value">${count}</span>
        </div>`
      )
      .join("")
  }

  const assuranceSection = data.assurance
    ? `<div class="assurance-hero">
        <div>
          <div class="eyebrow">Assurance verdict</div>
          <h2>${escapeHtml(data.assurance.verdict.replaceAll("_", " "))}</h2>
          <p>${escapeHtml(data.assurance.narrative)}</p>
        </div>
        <div class="score-ring" style="--score:${data.assurance.score ?? 0};">
          <div><strong>${data.assurance.score ?? "—"}</strong><span>${escapeHtml(data.assurance.grade ?? "Pending")}</span></div>
        </div>
      </div>
      <div class="visual-grid">
        <div class="section"><h2>Remediation Status</h2>${renderMetricBars(data.findingsByStatus)}</div>
        <div class="section"><h2>Risk Categories</h2>${renderMetricBars(data.findingsByCategory)}</div>
      </div>
      <div class="section">
        <h2>Priority Actions</h2>
        <ol class="actions">${data.assurance.priorityActions
          .map(
            (action) =>
              `<li><strong>${escapeHtml(action.label)}</strong><span>${escapeHtml(action.detail)}</span></li>`
          )
          .join("")}</ol>
        ${
          data.scanInfo?.status.toUpperCase() === "PARTIAL" &&
          data.scanInfo.targetId &&
          data.scanInfo.goal &&
          data.scanInfo.mode
            ? `<p><a class="coverage-action" href="${escapeHtml(
                `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/dashboard/scans?new=1&target=${encodeURIComponent(data.scanInfo.targetId)}&goal=${encodeURIComponent(data.scanInfo.goal)}&mode=${encodeURIComponent(data.scanInfo.mode)}`
              )}">Complete coverage</a></p>`
            : ""
        }
      </div>`
    : ""

  const methodologySection = data.assurance
    ? `<div class="section"><h2>Methodology and Limits</h2><ul class="methodology">${data.assurance.methodology
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul></div>`
    : ""

  const aiAppSecuritySection = data.aiAppSecurity
    ? `<div class="section"><h2>AI App Security Score</h2>
        <div class="assurance-hero" style="background:linear-gradient(135deg,#1a2e3b,#1e3a4c);">
          <div>
            <div class="eyebrow">Private score</div>
            <h2 style="color:#f5fbff;">${data.aiAppSecurity.score === null ? "Not scored" : `${data.aiAppSecurity.score} / 100`}</h2>
            <p style="color:#c8dce8;">${data.aiAppSecurity.assessedCount ?? 0} of ${data.aiAppSecurity.totalControls ?? 8} controls assessed</p>
            <p style="color:#a9c5d2;font-size:12px;margin-top:8px;">${escapeHtml(data.aiAppSecurity.reason ?? "Coverage or advisory data was insufficient for a numeric score.")}</p>
          </div>
          <div class="score-ring" style="--score:${data.aiAppSecurity.score ?? 0};"><div><strong>${data.aiAppSecurity.score ?? "—"}</strong><span>AI APP</span></div></div>
        </div>
        <ul class="methodology">${data.aiAppSecurity.methodologyWording.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>`
    : ""

  const aiAssuranceSection = data.aiAssurance
    ? `<div class="section"><h2>AI Assurance Controls</h2><p style="color:#4b5563;font-size:13px;">Customer-declared profile: ${escapeHtml(data.aiAssurance.profileState)} · Threat model: ${escapeHtml(data.aiAssurance.threatModelState)}. This is private evidence context, not a certification or guarantee.</p><ul>${data.aiAssurance.controls
        .map(
          (control) =>
            `<li><strong>${escapeHtml(control.controlTitle)}</strong> <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#f3f4f6;font-size:12px;">${escapeHtml(control.state)}</span>${control.attestation ? `<p style="margin:6px 0 0;font-size:13px;color:#4b5563;">${escapeHtml(control.attestation)}</p>` : ""}${control.artifacts.length > 0 ? `<p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Artifacts: ${control.artifacts.map((a) => escapeHtml(a.filename)).join(", ")}</p>` : ""}</li>`
        )
        .join("")}</ul></div>`
    : ""

  const webMcpAssuranceSection = data.webMcpAssurance
    ? `<div class="section"><h2>WebMCP Tool Surface</h2>
        <p style="color:#4b5563;font-size:13px;margin-bottom:12px;">
          Coverage state: <strong>${escapeHtml(data.webMcpAssurance.coverageState)}</strong>.
          ${data.webMcpAssurance.toolDefinitionsAssessed} of ${data.webMcpAssurance.toolDefinitionsFound} tool definition(s) assessed.
          ${data.webMcpAssurance.incompleteDefinitions > 0 ? `${data.webMcpAssurance.incompleteDefinitions} incomplete.` : ""}
        </p>
        <table style="margin-bottom:16px;">
          <tr><td style="font-weight:600;padding:4px 0;width:180px;">Detector</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${escapeHtml(data.webMcpAssurance.detectorVersion)}</td></tr>
          <tr><td style="font-weight:600;padding:4px 0;">Inventory checksum</td><td style="padding:4px 0;font-family:monospace;font-size:12px;word-break:break-all;">${escapeHtml(data.webMcpAssurance.inventoryChecksum)}</td></tr>
          <tr><td style="font-weight:600;padding:4px 0;">Source coverage</td><td style="padding:4px 0;">${data.webMcpAssurance.scannedFiles} of ${data.webMcpAssurance.eligibleFiles} eligible files · ${data.webMcpAssurance.scannedBytes} bytes</td></tr>
          ${data.webMcpAssurance.sourceSelection ? `<tr><td style="font-weight:600;padding:4px 0;">Repository selection</td><td style="padding:4px 0;">${data.webMcpAssurance.sourceSelection.selectedFiles} of ${data.webMcpAssurance.sourceSelection.eligibleFiles} eligible files selected · ${data.webMcpAssurance.sourceSelection.skippedFiles} skipped${data.webMcpAssurance.sourceSelection.scannedBytes === undefined ? "" : ` · ${data.webMcpAssurance.sourceSelection.scannedBytes} admitted bytes`}</td></tr><tr><td style="font-weight:600;padding:4px 0;">Selection limits</td><td style="padding:4px 0;">${data.webMcpAssurance.sourceSelection.limits.maxFiles} files · ${data.webMcpAssurance.sourceSelection.limits.maxFileBytes} bytes/file · ${data.webMcpAssurance.sourceSelection.limits.maxTotalBytes} total bytes</td></tr>` : `<tr><td style="font-weight:600;padding:4px 0;">Repository selection</td><td style="padding:4px 0;">Legacy receipt — completeness unavailable</td></tr>`}
        </table>
        <div class="visual-grid">
          <div class="section" style="margin-bottom:0;"><h3>Tool Kinds</h3>${renderMetricBars(data.webMcpAssurance.toolCounts.byKind)}</div>
          <div class="section" style="margin-bottom:0;"><h3>Tool Behaviors</h3>${renderMetricBars(data.webMcpAssurance.toolCounts.byBehavior)}</div>
        </div>
        <div class="visual-grid" style="margin-top:16px;">
          <div class="section" style="margin-bottom:0;"><h3>Exposure Posture</h3>${renderMetricBars(data.webMcpAssurance.exposurePosture)}</div>
          <div class="section" style="margin-bottom:0;"><h3>Confirmation Posture</h3>${renderMetricBars(data.webMcpAssurance.confirmationPosture)}</div>
        </div>
        <div class="visual-grid" style="margin-top:16px;">
          <div class="section" style="margin-bottom:0;"><h3>WebMCP Findings by Control</h3>${renderMetricBars(data.webMcpAssurance.findingsByControl)}</div>
          <div class="section" style="margin-bottom:0;"><h3>WebMCP Findings by Severity</h3>${renderMetricBars(data.webMcpAssurance.findingsBySeverity)}</div>
        </div>
        ${data.webMcpAssurance.representativeRemediation.length > 0 ? `<h3 style="margin-top:16px;">Representative remediation</h3><ul class="methodology">${data.webMcpAssurance.representativeRemediation.map((item) => `<li><strong>${escapeHtml(item.controlId)} · ${escapeHtml(item.severity)}</strong> — ${escapeHtml(item.text)}</li>`).join("")}</ul>` : ""}
        ${data.webMcpAssurance.limitsReached.length > 0 ? `<p style="color:#ea580c;font-size:12px;margin-top:12px;">Coverage limited: ${escapeHtml(data.webMcpAssurance.limitsReached.join(", "))}</p>` : ""}
        <ul class="methodology">${data.webMcpAssurance.methodology.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>`
    : ""

  const standardsViews = data.scanInfo?.standards ?? []
  const standardsSection =
    standardsViews.length > 0
      ? `<div class="section"><h2>Standards Coverage</h2>
        <p style="color:#4b5563;font-size:13px;margin-bottom:12px;">
          Per-category evidence states computed from this scan's coverage receipts and findings.
          "Evaluated" means a mapped scanner produced evidence; "not evaluated" means nothing
          ran that covers the category. Organizational attestation can still be required
          when scanner evidence exists; it is not discharged by an evaluated state.
        </p>
        ${standardsViews
          .map(
            (
              view
            ) => `<h3 style="font-size:13px;font-weight:650;margin:14px 0 6px;">${escapeHtml(view.name)} <span style="color:#6b7280;font-weight:400;">${escapeHtml(view.version)}</span>${view.badge ? ` <span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:10px;font-weight:600;">${escapeHtml(view.badge)}</span>` : ""}</h3>
            <p style="font-size:12px;color:#6b7280;margin-bottom:6px;">${view.evaluated} evaluated · ${view.requiresAttestation} require attestation (including evaluated controls) · ${view.notEvaluated} not evaluated${view.violationSignals > 0 ? ` · <strong style="color:#b91c1c;">${view.violationSignals} violation signal${view.violationSignals === 1 ? "" : "s"}</strong>` : ""}</p>
            <table>
              ${view.categories
                .map(
                  (cat) => `<tr>
                    <td style="padding:4px 8px 4px 0;font-family:monospace;font-size:11px;width:110px;">${escapeHtml(cat.id)}</td>
                    <td style="padding:4px 8px 4px 0;font-size:12px;">${escapeHtml(cat.title)}</td>
                    <td style="padding:4px 0;font-size:11px;width:150px;"><span style="display:inline-block;padding:1px 7px;border-radius:4px;${
                      cat.state === "evaluated"
                        ? cat.violationSignals > 0
                          ? "background:#fee2e2;color:#b91c1c;"
                          : cat.limited
                            ? "background:#ccfbf1;color:#0f766e;"
                            : "background:#dcfce7;color:#166534;"
                        : cat.state === "requires-attestation"
                          ? "background:#fef3c7;color:#92400e;"
                          : "background:#f3f4f6;color:#6b7280;"
                    }">${cat.state === "evaluated" ? (cat.violationSignals > 0 ? `evaluated · ${cat.violationSignals} signal${cat.violationSignals === 1 ? "" : "s"}` : cat.limited ? "evaluated · partial" : "evaluated") : cat.state === "requires-attestation" ? "requires attestation" : "not evaluated"}</span>${cat.attestable && cat.state !== "requires-attestation" ? ' <span style="color:#92400e;">attestation required</span>' : ""}</td>
                  </tr>`
                )
                .join("")}
            </table>`
          )
          .join("")}
      </div>`
      : ""

  const urlExecution = data.scanInfo?.urlExecution
  const urlExecutionSection = urlExecution
    ? `<div class="section"><h2>URL Execution Scope</h2>
        <p style="margin-bottom:12px;">${escapeHtml(renderUrlExecutionLine(urlExecution))}</p>
        ${urlExecution.issueCodes.length > 0 ? `<p style="color:#ea580c;font-size:12px;margin-bottom:12px;">Coverage limited: ${escapeHtml(urlExecution.issueCodes.join(", "))}</p>` : ""}
        <p style="color:#617083;font-size:12px;">This public, non-mutating review did not authenticate or validate exploitability.</p>
      </div>`
    : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(data.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { color-scheme: light dark; --bg:#f4f8fb; --surface:#fff; --text:#102033; --muted:#617083; --border:#dce5ed; --accent:#176b87; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 1040px; margin: 0 auto; padding: 40px 24px; }
    .header { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 24px; }
    .header h1 { font-size: 32px; line-height:1.15; letter-spacing:-.035em; font-weight: 750; margin-bottom: 8px; }
    .header .meta, .muted { font-size: 13px; color: var(--muted); }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .stat-card .label { font-size: 10px; letter-spacing:.1em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .section { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; margin-bottom: 20px; break-inside:avoid; }
    .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; font-size: 11px; text-transform: uppercase; color: #6b7280; font-weight: 600; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; text-align: center; }
    .assurance-hero { display:grid;grid-template-columns:1fr auto;gap:28px;align-items:center;background:linear-gradient(135deg,#102b43,#12394a);color:#f5fbff;border-radius:18px;padding:28px;margin-bottom:20px; }
    .assurance-hero h2 { font-size:26px;letter-spacing:-.025em;margin:4px 0 8px; }
    .assurance-hero p { color:#c8dce8;max-width:680px; }
    .eyebrow { color:#75d8ee;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase; }
    .score-ring { --size:112px;width:var(--size);height:var(--size);border-radius:50%;display:grid;place-items:center;background:conic-gradient(#75d8ee calc(var(--score) * 1%),#294c5d 0);position:relative; }
    .score-ring:after { content:"";position:absolute;inset:9px;border-radius:50%;background:#102b43; }
    .score-ring div { z-index:1;text-align:center; }.score-ring strong { display:block;font-size:30px;line-height:1; }.score-ring span { display:block;color:#a9c5d2;font-size:10px;margin-top:5px;text-transform:uppercase; }
    .visual-grid { display:grid;grid-template-columns:1fr 1fr;gap:20px; }
    .bar-row { display:grid;grid-template-columns:112px 1fr 34px;align-items:center;gap:10px;margin:10px 0; }
    .bar-label { font-size:11px;font-weight:650;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .bar-track { height:9px;background:#e7edf2;border-radius:999px;overflow:hidden; }.bar-fill { display:block;height:100%;border-radius:999px; }.bar-fill.accent { background:var(--accent); }.bar-value { text-align:right;font-size:12px;font-weight:700; }
    .actions { list-style:none;display:grid;gap:10px; }.actions li { display:grid;gap:2px;padding:12px 14px;border:1px solid var(--border);border-radius:10px; }.actions span,.methodology { color:var(--muted);font-size:12px; }.methodology { padding-left:18px;display:grid;gap:7px; }
    @media (max-width:700px) { .container{padding:22px 14px}.summary-grid,.visual-grid{grid-template-columns:1fr 1fr}.assurance-hero{grid-template-columns:1fr}.score-ring{--size:96px}.table-wrap{overflow-x:auto}.header h1{font-size:27px} }
    @media print { :root{--bg:#fff}.container{max-width:none;padding:0}.section,.stat-card{box-shadow:none}.assurance-hero{-webkit-print-color-adjust:exact;print-color-adjust:exact} }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(data.title)}</h1>
      <div class="meta">
        ${escapeHtml(data.workspaceName)} · Generated ${toIso(data.generatedAt).split("T")[0]}
        ${data.scanInfo ? ` · Target: ${escapeHtml(data.scanInfo.targetName)}` : ""}
      </div>
    </div>

    ${assuranceSection}

    <div class="summary-grid">
      <div class="stat-card">
        <div class="label">Total Findings</div>
        <div class="value">${data.totalFindings}</div>
      </div>
      <div class="stat-card">
        <div class="label">Verified</div>
        <div class="value">${data.verifiedCount}</div>
      </div>
      <div class="stat-card">
        <div class="label">Fixed</div>
        <div class="value">${data.fixedCount}</div>
      </div>
      <div class="stat-card">
        <div class="label">Retests Passed</div>
        <div class="value">${data.retestSummary.passed}</div>
      </div>
    </div>

    ${
      data.scanInfo
        ? `
    <div class="section">
      <h2>Scan Information</h2>
      <table>
        <tr><td style="font-weight:600;padding:4px 0;width:140px;">Scan ID</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${escapeHtml(data.scanInfo.scanId)}</td></tr>
        <tr><td style="font-weight:600;padding:4px 0;">Status</td><td style="padding:4px 0;">${escapeHtml(data.scanInfo.status)}</td></tr>
        <tr><td style="font-weight:600;padding:4px 0;">Target</td><td style="padding:4px 0;">${escapeHtml(data.scanInfo.targetName)} (${escapeHtml(data.scanInfo.targetType)})</td></tr>
        ${data.scanInfo.targetUrl ? `<tr><td style="font-weight:600;padding:4px 0;">URL</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${escapeHtml(data.scanInfo.targetUrl)}</td></tr>` : ""}
        ${data.scanInfo.startedAt ? `<tr><td style="font-weight:600;padding:4px 0;">Started</td><td style="padding:4px 0;">${toIso(data.scanInfo.startedAt)}</td></tr>` : ""}
        ${data.scanInfo.endedAt ? `<tr><td style="font-weight:600;padding:4px 0;">Ended</td><td style="padding:4px 0;">${toIso(data.scanInfo.endedAt)}</td></tr>` : ""}
        ${data.scanInfo.summary ? `<tr><td style="font-weight:600;padding:4px 0;">Summary</td><td style="padding:4px 0;">${escapeHtml(data.scanInfo.summary)}</td></tr>` : ""}
      </table>
    </div>

    `
        : ""
    }

    ${standardsSection}

    ${methodologySection}

    ${urlExecutionSection}

    ${aiAppSecuritySection}

    ${webMcpAssuranceSection}

    ${aiAssuranceSection}

    <div class="section">
      <h2>Findings by Severity</h2>
      ${severityBars || "<p style='color:#6b7280;font-size:13px;'>No findings</p>"}
    </div>

    <div class="section">
      <h2>Findings Detail (${data.totalFindings})</h2>
      ${data.findingsTruncated ? "<p style='color:#ea580c;font-size:12px;margin-bottom:12px;'>Showing the 500 most recent findings. Additional findings exist but are not included in this report.</p>" : ""}
      ${
        data.findings.length > 0
          ? `
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Title</th>
            <th>Summary</th>
            <th>Status</th>
            <th>Verification</th>
            <th>Fix / Retest</th>
          </tr>
        </thead>
        <tbody>
          ${findingsRows}
        </tbody>
      </table>
      `
          : "<p style='color:#6b7280;font-size:13px;'>No findings recorded.</p>"
      }
    </div>

    <div class="footer">
      Generated by LyraShield AI · ${toIso(data.generatedAt)}
    </div>
  </div>
</body>
</html>`
}

function renderUrlExecutionLine(
  execution: NonNullable<NonNullable<ReportData["scanInfo"]>["urlExecution"]>
): string {
  const labels: Record<string, string> = {
    WEB_APP_SAFE: "Surface Review",
    WEB_APP_STANDARD: "Expanded Surface Review",
    WEB_APP_DEEP: "Behavioral Surface Review",
    API_SAFE: "Endpoint Review",
    API_STANDARD: "Contract Review",
    API_DEEP: "Contract Behavior Review",
  }
  const name = labels[execution.profile] ?? execution.profile
  const methods = execution.methods.join(", ")
  const parts: string[] = []
  if (execution.documentCount > 0) parts.push(`${execution.documentCount} pages`)
  if (execution.assetCount > 0) parts.push(`${execution.assetCount} assets`)
  if (execution.operationCount > 0) parts.push(`${execution.operationCount} operations`)
  if (execution.methodProbeCount > 0) parts.push(`${execution.methodProbeCount} method probes`)
  if (execution.originProbeCount > 0) parts.push(`${execution.originProbeCount} origin probes`)
  const scope = parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
  return `${name}${scope} · ${methods}`
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
