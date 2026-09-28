import { prisma } from "./client"
import {
  AI_ASSURANCE_CONTROL_IDS,
  listControlEvidence,
  aiAssuranceStateForVersion,
  type ControlEvidenceVersionSummary,
} from "./ai-assurance-service"
import { getAiSecurityScoreSnapshot } from "./ai-security-score-service"
import { getAiSystemProfile } from "./ai-system-profile-service"
import { getThreatModel } from "./threat-model-service"
import { defaultStandards, renderStandards } from "@lyrashield/security"
import { WEBMCP_CONTROL_IDS, type WebMcpSeverity } from "@lyrashield/security/webmcp"
import {
  CONTROL_TITLE_BY_ID,
  WEBMCP_SEVERITY_KEYS,
  isReportData,
  parseWebMcpAssurance,
  webMcpFindingIdentity,
} from "./report-generator.validation"
import type { ReportData, ReportWebMcpAssurance } from "./report-generator.validation"

export { isReportData, parseWebMcpAssurance }
export type { ReportData, ReportWebMcpAssurance }

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
  let webMcpCoverage: ReportWebMcpAssurance | undefined = undefined
  let scanCoverageReceipts: Array<{ controlId: string; scanner: string; status: string }> = []
  let scanWhere:
    | { workspaceId: string; deletedAt: null }
    | {
        workspaceId: string
        deletedAt: null
        candidates: { some: { scanId: string } }
      }

  if (scanId) {
    const scan = await prisma.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      include: {
        target: { select: { name: true, type: true, url: true } },
        resultManifest: { select: { checksum: true, manifest: true } },
        coverageReceipts: { select: { controlId: true, scanner: true, status: true } },
      },
    })

    if (scan) {
      targetId = scan.targetId
      scanCoverageReceipts = scan.coverageReceipts ?? []
      const manifestRecord = scan.resultManifest?.manifest as
        { urlExecution?: NonNullable<ReportData["scanInfo"]>["urlExecution"] } | undefined
      const manifestCoverage = (
        scan.resultManifest?.manifest as
          | { coverage?: Array<{ scanner?: string; metadata?: { webMcpCoverage?: unknown } }> }
          | undefined
      )?.coverage
      const aiAppReceipt = manifestCoverage?.find(
        (receipt) => receipt.scanner === "ai_app_security"
      )
      const rawWebMcp = aiAppReceipt?.metadata?.webMcpCoverage
      webMcpCoverage = parseWebMcpAssurance(rawWebMcp) ?? undefined
      scanInfo = {
        scanId: scan.id,
        targetId: scan.targetId,
        goal: scan.goal,
        mode: scan.mode,
        status: scan.status,
        summary: scan.summary,
        targetName: scan.target?.name ?? "Unknown",
        targetType: scan.target?.type ?? "unknown",
        targetUrl: scan.target?.url ?? null,
        startedAt: scan.startedAt,
        endedAt: scan.endedAt,
        manifestChecksum: scan.resultManifest?.checksum ?? null,
        coverage: (scan.coverageReceipts ?? [])
          .filter((receipt) => receipt.controlId.startsWith("vibe-"))
          .reduce(
            (acc, receipt) => {
              if (receipt.status === "COMPLETED") acc.completed++
              else if (receipt.status === "NOT_APPLICABLE") acc.notApplicable++
              else acc.limited++
              return acc
            },
            { completed: 0, limited: 0, notApplicable: 0 }
          ),
        urlExecution: manifestRecord?.urlExecution,
      }
    }

    scanWhere = { workspaceId, deletedAt: null, candidates: { some: { scanId } } }
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
      owaspCategory: true,
      cvssScore: true,
      category: true,
      summary: true,
      exploitability: true,
      recommendedFix: true,
      firstSeenAt: true,
      candidates: {
        where: {
          scannerSource: "ai_app_security",
          ...(scanId ? { scanId } : {}),
        },
        select: { payload: true },
      },
      fixProposals: { select: { id: true, status: true } },
      retests: { select: { id: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: FINDINGS_LIMIT + 1,
  })

  const findingsTruncated = findings.length > FINDINGS_LIMIT
  const truncatedFindings = findingsTruncated ? findings.slice(0, FINDINGS_LIMIT) : findings

  // Standards matrix — computed from this scan's receipts + findings so the
  // report carries evidence, not a marketing claim.
  if (scanInfo && scanCoverageReceipts.length > 0) {
    scanInfo.standards = renderStandards(
      defaultStandards(),
      scanCoverageReceipts,
      truncatedFindings.map((f) => ({ cwe: f.cwe, owaspCategory: f.owaspCategory }))
    )
  }

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

  const webMcpFindingsByControl = Object.fromEntries(
    WEBMCP_CONTROL_IDS.map((controlId) => [controlId, 0])
  ) as ReportWebMcpAssurance["findingsByControl"]
  const webMcpFindingsBySeverity = Object.fromEntries(
    WEBMCP_SEVERITY_KEYS.map((severity) => [severity, 0])
  ) as ReportWebMcpAssurance["findingsBySeverity"]
  const representativeRemediation: ReportWebMcpAssurance["representativeRemediation"] = []
  for (const finding of sortedFindings) {
    const controlId = webMcpFindingIdentity(finding)
    if (!controlId) continue
    const severity = WEBMCP_SEVERITY_KEYS.includes(finding.severity as WebMcpSeverity)
      ? (finding.severity as WebMcpSeverity)
      : "INFO"
    webMcpFindingsByControl[controlId]++
    webMcpFindingsBySeverity[severity]++
    const remediation = finding.recommendedFix?.trim()
    if (
      remediation &&
      representativeRemediation.length < 5 &&
      !representativeRemediation.some((item) => item.controlId === controlId)
    ) {
      representativeRemediation.push({ controlId, severity, text: remediation.slice(0, 240) })
    }
  }
  const webMcpAssurance = webMcpCoverage
    ? {
        ...webMcpCoverage,
        findingsByControl: webMcpFindingsByControl,
        findingsBySeverity: webMcpFindingsBySeverity,
        representativeRemediation,
        methodology: [
          ...webMcpCoverage.methodology,
          findingsTruncated
            ? "WebMCP finding aggregates cover only the bounded 500-finding report snapshot."
            : "WebMCP finding aggregates cover all retained findings in this report snapshot.",
        ],
      }
    : undefined

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
  // Only terminal scans with usable coverage can ground a readiness verdict.
  // Partial scans remain conditional even with no retained findings.
  // Historical rows may carry lowercase enum spellings.
  const scanStatus = scanInfo?.status.toUpperCase()
  const scanUsableForVerdict = scanInfo !== null && scanStatus === "COMPLETED"
  const isPartialScan = scanStatus === "PARTIAL"
  const verdict = !scanUsableForVerdict
    ? isPartialScan
      ? criticalCount > 0
        ? "NO_GO"
        : "GO_WITH_CONDITIONS"
      : "NOT_EVALUATED"
    : criticalCount > 0
      ? "NO_GO"
      : highCount > 0
        ? "GO_WITH_CONDITIONS"
        : "GO"
  const incompleteScanners = isPartialScan
    ? [
        ...new Set(
          scanCoverageReceipts
            .filter((receipt) => !["COMPLETED", "NOT_APPLICABLE"].includes(receipt.status))
            .map((receipt) => receipt.scanner)
        ),
      ]
    : []
  const coverageNarrative = isPartialScan
    ? incompleteScanners.length > 0
      ? `Coverage is incomplete; these checks did not complete: ${incompleteScanners.join(", ")}.`
      : "Coverage is incomplete; later coverage may have stopped before a scanner receipt was recorded."
    : ""
  const verdictNarrative =
    verdict === "NOT_EVALUATED"
      ? scanInfo
        ? `The attached scan did not complete successfully (${scanInfo.status.toLowerCase()}), so its evidence cannot establish release posture.`
        : "No completed scan is attached, so release posture has not been evaluated."
      : verdict === "NO_GO"
        ? `${criticalCount} critical finding${criticalCount === 1 ? " requires" : "s require"} remediation and verification before release.`
        : verdict === "GO_WITH_CONDITIONS"
          ? highCount > 0
            ? `${highCount} high-severity finding${highCount === 1 ? " remains" : "s remain"}; release should proceed only with documented owners and conditions.`
            : "Complete and review the remaining scan coverage before relying on this release posture."
          : totalFindingsLabel(sortedFindings.length)
  const narrative = [coverageNarrative, verdictNarrative].filter(Boolean).join(" ")
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
  if (isPartialScan && scanInfo)
    priorityActions.push({
      label: "Complete coverage",
      detail:
        "Run the existing scan flow for this target after reviewing the recorded limitations.",
      severity: "MEDIUM",
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

  const aiAssuranceEvidence = targetId ? await listControlEvidence({ workspaceId, targetId }) : []
  const evidenceByControlId = new Map(
    aiAssuranceEvidence.map((evidence) => [evidence.controlId, evidence.currentVersion])
  )

  const aiSecurityScoreSnapshot = scanId
    ? await getAiSecurityScoreSnapshot(scanId, workspaceId).catch(() => null)
    : null

  const [aiSystemProfile, threatModel] = targetId
    ? await Promise.all([
        getAiSystemProfile(workspaceId, targetId),
        getThreatModel(workspaceId, targetId),
      ])
    : [null, null]

  const aiAppSecurity = aiSecurityScoreSnapshot
    ? {
        score: aiSecurityScoreSnapshot.score,
        methodology: aiSecurityScoreSnapshot.methodology,
        assessedCount: aiSecurityScoreSnapshot.assessedCount,
        totalControls: aiSecurityScoreSnapshot.totalControls,
        reason: (aiSecurityScoreSnapshot.breakdown as { reason?: string } | null)?.reason ?? null,
        generatedAt: aiSecurityScoreSnapshot.computedAt,
        methodologyWording: [
          "AI App Security Score is a private, versioned interpretation of deterministic and advisory signals.",
          "It is displayed only when minimum coverage is met; stale advisory data blocks the numeric score.",
          "This score is not a certification, compliance attestation, or universal security guarantee.",
        ],
      }
    : undefined

  const aiAssuranceControls = AI_ASSURANCE_CONTROL_IDS.map((controlId) => {
    const version = evidenceByControlId.get(controlId) as ControlEvidenceVersionSummary | undefined
    const state = aiAssuranceStateForVersion(version ?? null)
    return {
      controlId,
      controlTitle: CONTROL_TITLE_BY_ID[controlId] ?? controlId,
      state,
      status: version?.status ?? null,
      version: version?.version ?? null,
      attestation: version?.attestation ?? null,
      expiresAt: version?.expiresAt ?? null,
      reviewedById: version?.reviewedById ?? null,
      reviewedAt: version?.reviewedAt ?? null,
      artifacts: (version?.artifactManifest ?? []).map((artifact) => ({
        filename: artifact.filename,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        checksum: artifact.checksum,
      })),
    }
  })

  const aiAssurance: NonNullable<ReportData["aiAssurance"]> = {
    version: "ai-assurance/1.0.0" as const,
    profileState: !targetId
      ? "NOT_ASSESSED"
      : aiSystemProfile?.currentVersion
        ? "COMPLETE"
        : aiSystemProfile
          ? "INCOMPLETE"
          : "NOT_ASSESSED",
    threatModelState: !targetId
      ? "NOT_ASSESSED"
      : threatModel?.currentVersion
        ? "CURRENT"
        : "MISSING",
    evidence: aiAssuranceControls.map((control) => ({
      controlId: control.controlId,
      state: control.state,
      evidenceVersionId:
        control.version === null ? null : (evidenceByControlId.get(control.controlId)?.id ?? null),
      expiresAt: control.expiresAt,
    })),
    // Framework mappings are intentionally withheld until owner-approved mappings are enabled.
    frameworkVersion: "not-enabled",
    controls: aiAssuranceControls,
    generatedAt: new Date(),
    methodology: [
      "AI assurance control evidence is frozen at report creation time.",
      "Evidence versions are append-only, encrypted, and workspace-scoped.",
      "This section is not included in public or shared report payloads.",
    ],
  }

  return {
    version: 3,
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
    webMcpAssurance,
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
        "This public, non-mutating review did not authenticate or validate exploitability.",
        scanInfo?.manifestChecksum
          ? `Result manifest SHA-256: ${scanInfo.manifestChecksum}. Coverage: ${scanInfo.coverage.completed} completed, ${scanInfo.coverage.limited} limited, ${scanInfo.coverage.notApplicable} not applicable.`
          : "This legacy scan has no immutable result manifest; treat its coverage and verification state as incomplete.",
        "Public shares exclude evidence, repository coordinates, and technical finding details.",
      ],
    },
    aiAssurance,
    aiAppSecurity,
  }
}

function totalFindingsLabel(total: number): string {
  return total === 0
    ? "No retained findings were recorded in this report snapshot."
    : `${total} finding${total === 1 ? " is" : "s are"} recorded with no critical or high-severity release blocker.`
}

export { generateReportHTML } from "./report-generator-html"
