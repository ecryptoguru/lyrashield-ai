import type { ReleasePacketPayload } from "@lyrashield/types"
import type { ReleasePacketReadResult } from "./release-packet-service"

/**
 * Quote one CSV cell and neutralize spreadsheet formula execution. The value is
 * preserved after the leading apostrophe so exports remain reviewable.
 */
export function escapeReleasePacketCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function generateReleasePacketCsv(
  payload: ReleasePacketPayload,
  verification: Pick<
    ReleasePacketReadResult,
    "authenticity" | "assessmentValidity" | "currentApplicability"
  >
): string {
  const rows: unknown[][] = [
    ["section", "key", "value"],
    ["scope", "packetVersion", payload.version],
    ["scope", "packetChecksum", payload.packetChecksum],
    ["scope", "generatedAt", payload.generatedAt],
    ["packet", "signatureState", verification.authenticity.signatureState],
    ["packet", "expiresAt", verification.authenticity.expiresAt ?? "unavailable"],
    ["packet", "expired", verification.authenticity.expired ?? "unavailable"],
    ["packet", "keyId", payload.signingKeyId ?? "unavailable"],
    ["packet", "signature", payload.packetSignature ?? "unavailable"],
    ["target", "id", payload.target.id],
    ["target", "name", payload.target.name],
    ["target", "type", payload.target.type],
    ["target", "environment", payload.target.environment],
    ["assessment", "verdictId", payload.assessment.verdictId],
    ["assessment", "standardVersion", payload.assessment.standardVersion],
    ["assessment", "state", payload.assessment.state],
    ["assessment", "applicable", payload.assessment.applicable],
    ["assessment", "currentApplicability", verification.currentApplicability.state],
    ["assessment", "signatureState", verification.assessmentValidity.signatureState],
    ["assessment", "expired", verification.assessmentValidity.expired ?? "unavailable"],
    ["assessment", "evaluatedAt", payload.assessment.evaluatedAt],
    ["assessment", "identityKind", payload.assessment.assessedIdentity?.kind ?? "unavailable"],
    ["assessment", "identityValue", payload.assessment.assessedIdentity?.value ?? "unavailable"],
    ["signature", "state", payload.signedAssessment.state],
    ["signature", "reportId", payload.signedAssessment.reportId ?? "unavailable"],
    ["signature", "reportChecksum", payload.signedAssessment.reportChecksum ?? "unavailable"],
    ["signature", "keyId", payload.signedAssessment.signingKeyId ?? "unavailable"],
    ["coverage", "completed", payload.coverage.completed.join(" | ")],
    ["coverage", "notApplicable", payload.coverage.notApplicable.join(" | ")],
    ["coverage", "incomplete", payload.coverage.incomplete.join(" | ")],
    ["coverage", "manifestChecksum", payload.coverage.manifestChecksum ?? "unavailable"],
    ["remediation", "baselineScanId", payload.remediation.baselineScanId ?? "unavailable"],
    ["remediation", "currentScanId", payload.remediation.currentScanId],
    ["remediation", "newFindings", payload.remediation.counts.newFindings],
    ["remediation", "recurringFindings", payload.remediation.counts.recurringFindings],
    ["remediation", "resolvedFindings", payload.remediation.counts.resolvedFindings],
    ["remediation", "uncertainMatches", payload.remediation.counts.uncertainMatches],
    ["remediation", "truncated", payload.remediation.truncated],
  ]

  for (const finding of payload.remediation.findings) {
    rows.push(
      ["finding", finding.findingId, finding.title],
      ["finding", `${finding.findingId}:category`, finding.category],
      ["finding", `${finding.findingId}:severity`, finding.severity],
      ["finding", `${finding.findingId}:status`, finding.status],
      ["finding", `${finding.findingId}:verificationStatus`, finding.verificationStatus],
      ["finding", `${finding.findingId}:sourceRevision`, finding.sourceRevision ?? "unavailable"],
      ["finding", `${finding.findingId}:retestState`, finding.retestState],
      ["finding", `${finding.findingId}:proposalState`, finding.proposalState],
      ["finding", `${finding.findingId}:evidenceHref`, finding.evidenceHref]
    )
  }

  return `${rows.map((row) => row.map(escapeReleasePacketCsvCell).join(",")).join("\r\n")}\r\n`
}
