import { prisma } from "./client"

export interface ReportData {
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
  } | null
  findings: Array<{
    id: string
    title: string
    severity: string
    status: string
    verified: boolean
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
  totalFindings: number
  verifiedCount: number
  fixedCount: number
  retestSummary: { passed: number; failed: number; pending: number }
  findingsTruncated: boolean
  generatedAt: Date
}

export async function gatherReportData(workspaceId: string, scanId?: string): Promise<ReportData> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId },
    select: { name: true },
  })

  let scanInfo: ReportData["scanInfo"] = null
  let scanWhere: { workspaceId: string; deletedAt: null; scanId?: string }

  if (scanId) {
    const scan = await prisma.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      include: {
        target: { select: { name: true, type: true, url: true } },
      },
    })

    if (scan) {
      scanInfo = {
        scanId: scan.id,
        status: scan.status,
        summary: scan.summary,
        targetName: scan.target?.name ?? "Unknown",
        targetType: scan.target?.type ?? "unknown",
        targetUrl: scan.target?.url ?? null,
        startedAt: scan.startedAt,
        endedAt: scan.endedAt,
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
      confidence: true,
      cwe: true,
      cvssScore: true,
      category: true,
      summary: true,
      exploitability: true,
      recommendedFix: true,
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
  let verifiedCount = 0
  let fixedCount = 0
  const retestCounts = { passed: 0, failed: 0, pending: 0 }

  for (const f of sortedFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
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

  return {
    title: scanInfo ? `Security Report — ${scanInfo.targetName}` : "Security Report",
    type: "developer",
    workspaceName: workspace?.name ?? "Unknown Workspace",
    scanInfo,
    findings: sortedFindings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      status: f.status,
      verified: f.verified,
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
    totalFindings: findingsTruncated ? FINDINGS_LIMIT : findings.length,
    findingsTruncated,
    verifiedCount,
    fixedCount,
    retestSummary: retestCounts,
    generatedAt: new Date(),
  }
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
            ${f.verified ? "✅ Verified" : "⚠️ Unverified"}<br>
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

  const severityBars = Object.entries(data.findingsBySeverity)
    .map(([sev, count]) => {
      const color = SEVERITY_COLORS[sev] ?? "#6b7280"
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="display:inline-block;width:80px;font-size:12px;font-weight:600;color:${color};">${sev}</span>
        <span style="font-size:13px;">${count}</span>
      </div>`
    })
    .join("")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(data.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; color: #111827; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
    .header { border-bottom: 2px solid #e5e7eb; padding-bottom: 20px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .header .meta { font-size: 13px; color: #6b7280; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
    .stat-card .label { font-size: 11px; text-transform: uppercase; color: #6b7280; font-weight: 600; }
    .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; font-size: 11px; text-transform: uppercase; color: #6b7280; font-weight: 600; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(data.title)}</h1>
      <div class="meta">
        ${escapeHtml(data.workspaceName)} · Generated ${data.generatedAt.toISOString().split("T")[0]}
        ${data.scanInfo ? ` · Target: ${escapeHtml(data.scanInfo.targetName)}` : ""}
      </div>
    </div>

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
        ${data.scanInfo.startedAt ? `<tr><td style="font-weight:600;padding:4px 0;">Started</td><td style="padding:4px 0;">${data.scanInfo.startedAt.toISOString()}</td></tr>` : ""}
        ${data.scanInfo.endedAt ? `<tr><td style="font-weight:600;padding:4px 0;">Ended</td><td style="padding:4px 0;">${data.scanInfo.endedAt.toISOString()}</td></tr>` : ""}
        ${data.scanInfo.summary ? `<tr><td style="font-weight:600;padding:4px 0;">Summary</td><td style="padding:4px 0;">${escapeHtml(data.scanInfo.summary)}</td></tr>` : ""}
      </table>
    </div>
    `
        : ""
    }

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
      Generated by LyraShield AI · ${data.generatedAt.toISOString()}
    </div>
  </div>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
