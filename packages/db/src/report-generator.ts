import { prisma } from "./client"

export interface ReportData {
  version?: 2
  audience?: "developer" | "executive" | "compliance"
  title: string
  type: string
  workspaceName: string
  scanInfo: {
    scanId: string
    status: string
    summary: string | null
    targetName: string
    targetType: string
    targetUrl: string | null
    startedAt: Date | null
    endedAt: Date | null
    manifestChecksum: string | null
    coverage: { completed: number; limited: number; notApplicable: number }
  } | null
  findings: Array<{
    id: string
    title: string
    severity: string
    status: string
    verified: boolean
    verificationStatus?: string
    confidence: string
    cwe: string | null
    cvssScore: number | null
    category: string | null
    summary: string
    exploitability: string | null
    recommendedFix: string | null
    fixStatus: string
    retestStatus: string | null
  }>
  findingsBySeverity: Record<string, number>
  findingsByStatus?: Record<string, number>
  findingsByCategory?: Record<string, number>
  totalFindings: number
  verifiedCount: number
  fixedCount: number
  retestSummary: { passed: number; failed: number; pending: number }
  findingsTruncated: boolean
  generatedAt: Date
  assurance?: {
    verdict: "NOT_EVALUATED" | "GO" | "GO_WITH_CONDITIONS" | "NO_GO"
    score: number | null
    grade: string | null
    narrative: string
    scoreTrend: Array<{ score: number; grade: string; computedAt: Date }>
    ageBuckets: Record<string, number>
    priorityActions: Array<{ label: string; detail: string; severity: string }>
    methodology: string[]
  }
}

export async function gatherReportData(
  workspaceId: string,
  scanId?: string,
  audience: "developer" | "executive" | "compliance" = "developer"
): Promise<ReportData> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId },
    select: { name: true },
  })

  let scanInfo: ReportData["scanInfo"] = null
  let targetId: string | null = null
  let scanWhere: { workspaceId: string; deletedAt: null; scanId?: string }

  if (scanId) {
    const scan = await prisma.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      include: {
        target: { select: { name: true, type: true, url: true } },
        resultManifest: { select: { checksum: true } },
        coverageReceipts: { select: { status: true } },
      },
    })

    if (scan) {
      targetId = scan.targetId
      scanInfo = {
        scanId: scan.id,
        status: scan.status,
        summary: scan.summary,
        targetName: scan.target?.name ?? "Unknown",
        targetType: scan.target?.type ?? "unknown",
        targetUrl: scan.target?.url ?? null,
        startedAt: scan.startedAt,
        endedAt: scan.endedAt,
        manifestChecksum: scan.resultManifest?.checksum ?? null,
        coverage: (scan.coverageReceipts ?? []).reduce(
          (acc, receipt) => {
            if (receipt.status === "COMPLETED") acc.completed++
            else if (receipt.status === "NOT_APPLICABLE") acc.notApplicable++
            else acc.limited++
            return acc
          },
          { completed: 0, limited: 0, notApplicable: 0 }
        ),
      }
    }

    scanWhere = { workspaceId, deletedAt: null, scanId }
  } else {
    scanWhere = { workspaceId, deletedAt: null }
  }

  const FINDINGS_LIMIT = 500

  const findings = await prisma.finding.findMany({
    where: scanWhere,
    select: {
      id: true,
      title: true,
      severity: true,
      status: true,
      verified: true,
      verificationStatus: true,
      confidence: true,
      cwe: true,
      cvssScore: true,
      category: true,
      summary: true,
      exploitability: true,
      recommendedFix: true,
      firstSeenAt: true,
      fixProposals: { select: { id: true, status: true } },
      retests: { select: { id: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: FINDINGS_LIMIT + 1,
  })

  const findingsTruncated = findings.length > FINDINGS_LIMIT
  const truncatedFindings = findingsTruncated ? findings.slice(0, FINDINGS_LIMIT) : findings

  const severityRank: Record<string, number> = {
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    INFO: 1,
  }
  const sortedFindings = [...truncatedFindings].sort((a, b) => {
    const aRank = severityRank[a.severity] ?? 0
    const bRank = severityRank[b.severity] ?? 0
    return bRank - aRank
  })

  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byCategory: Record<string, number> = {}
  const ageBuckets: Record<string, number> = {
    "0–7 days": 0,
    "8–30 days": 0,
    "31–90 days": 0,
    "90+ days": 0,
  }
  let verifiedCount = 0
  let fixedCount = 0
  const retestCounts = { passed: 0, failed: 0, pending: 0 }

  for (const f of sortedFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1
    const category = f.category?.trim() || "Uncategorized"
    byCategory[category] = (byCategory[category] ?? 0) + 1
    const ageDays = f.firstSeenAt
      ? Math.max(0, Math.floor((Date.now() - f.firstSeenAt.getTime()) / 86_400_000))
      : 0
    if (ageDays <= 7) ageBuckets["0–7 days"]!++
    else if (ageDays <= 30) ageBuckets["8–30 days"]!++
    else if (ageDays <= 90) ageBuckets["31–90 days"]!++
    else ageBuckets["90+ days"]!++
    if (f.verified) verifiedCount++
    if (f.status === "FIXED") fixedCount++

    const latestRetest = f.retests[0]
    if (latestRetest) {
      if (latestRetest.status === "passed") retestCounts.passed++
      else if (latestRetest.status === "failed") retestCounts.failed++
      else if (latestRetest.status === "pending" || latestRetest.status === "running")
        retestCounts.pending++
    }
  }

  const scoreTrend = await prisma.scoreSnapshot.findMany({
    where: { workspaceId, ...(targetId ? { targetId } : {}) },
    orderBy: { computedAt: "desc" },
    take: 10,
    select: { score: true, grade: true, computedAt: true },
  })
  const currentScore = scoreTrend[0] ?? null
  const criticalCount = bySeverity.CRITICAL ?? 0
  const highCount = bySeverity.HIGH ?? 0
  const verdict = !scanInfo
    ? "NOT_EVALUATED"
    : criticalCount > 0
      ? "NO_GO"
      : highCount > 0
        ? "GO_WITH_CONDITIONS"
        : "GO"
  const narrative =
    verdict === "NOT_EVALUATED"
      ? "No completed scan is attached, so release posture has not been evaluated."
      : verdict === "NO_GO"
        ? `${criticalCount} critical finding${criticalCount === 1 ? " requires" : "s require"} remediation and verification before release.`
        : verdict === "GO_WITH_CONDITIONS"
          ? `${highCount} high-severity finding${highCount === 1 ? " remains" : "s remain"}; release should proceed only with documented owners and conditions.`
          : totalFindingsLabel(sortedFindings.length)
  const priorityActions: ReportData["assurance"] extends infer A
    ? A extends { priorityActions: infer P }
      ? P
      : never
    : never = []

  if (criticalCount > 0)
    priorityActions.push({
      label: "Resolve critical exposure",
      detail: `${criticalCount} critical finding${criticalCount === 1 ? "" : "s"} must be fixed and retested.`,
      severity: "CRITICAL",
    })
  if (highCount > 0)
    priorityActions.push({
      label: "Assign high-risk remediation",
      detail: `${highCount} high-severity finding${highCount === 1 ? " needs" : "s need"} an owner and due date.`,
      severity: "HIGH",
    })
  if (retestCounts.failed > 0)
    priorityActions.push({
      label: "Rework failed retests",
      detail: `${retestCounts.failed} remediation retest${retestCounts.failed === 1 ? " has" : "s have"} not passed.`,
      severity: "MEDIUM",
    })
  if (priorityActions.length === 0)
    priorityActions.push({
      label: "Maintain verification cadence",
      detail: "Continue scheduled scanning and preserve evidence for material releases.",
      severity: "INFO",
    })

  return {
    version: 2,
    audience,
    title: scanInfo ? `Security Report — ${scanInfo.targetName}` : "Security Report",
    type: audience,
    workspaceName: workspace?.name ?? "Unknown Workspace",
    scanInfo,
    findings: sortedFindings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      status: f.status,
      verified: f.verified,
      verificationStatus: f.verificationStatus,
      confidence: f.confidence,
      cwe: f.cwe,
      cvssScore: f.cvssScore,
      category: f.category,
      summary: f.summary,
      exploitability: f.exploitability,
      recommendedFix: f.recommendedFix,
      fixStatus: f.fixProposals.length > 0 ? f.fixProposals[0]!.status : "none",
      retestStatus: f.retests[0]?.status ?? null,
    })),
    findingsBySeverity: bySeverity,
    findingsByStatus: byStatus,
    findingsByCategory: byCategory,
    totalFindings: findingsTruncated ? FINDINGS_LIMIT : findings.length,
    findingsTruncated,
    verifiedCount,
    fixedCount,
    retestSummary: retestCounts,
    generatedAt: new Date(),
    assurance: {
      verdict,
      score: currentScore?.score ?? null,
      grade: currentScore?.grade ?? null,
      narrative,
      scoreTrend: [...scoreTrend].reverse(),
      ageBuckets,
      priorityActions,
      methodology: [
        "Counts are frozen at report creation time and do not change with live scan state.",
        "Findings are ordered by severity and limited to the 500 most recent records.",
        "Detection is not verification; a verified finding requires an independent verification receipt.",
        scanInfo?.manifestChecksum
          ? `Result manifest SHA-256: ${scanInfo.manifestChecksum}. Coverage: ${scanInfo.coverage.completed} completed, ${scanInfo.coverage.limited} limited, ${scanInfo.coverage.notApplicable} not applicable.`
          : "This legacy scan has no immutable result manifest; treat its coverage and verification state as incomplete.",
        "Public shares exclude evidence, repository coordinates, and technical finding details.",
      ],
    },
  }
}

function totalFindingsLabel(total: number): string {
  return total === 0
    ? "No retained findings were recorded in this report snapshot."
    : `${total} finding${total === 1 ? " is" : "s are"} recorded with no critical or high-severity release blocker.`
}

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
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;background:${sevColor};font-size:11px;font-weight:600;">${f.severity}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
            <strong>${escapeHtml(f.title)}</strong>
            ${f.cwe ? `<br><span style="font-size:11px;color:#6b7280;">${escapeHtml(f.cwe)}</span>` : ""}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;">
            ${escapeHtml(f.summary).slice(0, 120)}${f.summary.length > 120 ? "…" : ""}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;background:${statusColor};font-size:11px;font-weight:600;">${f.status}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;">
            ${f.verified ? "✅ Verified" : `⚠️ ${escapeHtml((f.verificationStatus ?? "DETECTED").replaceAll("_", " "))}`}<br>
            <span style="color:#6b7280;">${escapeHtml(f.confidence)}</span>
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
        <span class="bar-label" style="color:${color};">${sev}</span>
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
      </div>`
    : ""

  const methodologySection = data.assurance
    ? `<div class="section"><h2>Methodology and Limits</h2><ul class="methodology">${data.assurance.methodology
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul></div>`
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

    ${methodologySection}

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
