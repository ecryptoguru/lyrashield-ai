import type { ReleasePacketPayload } from "@lyrashield/types"
import { TargetAssessmentSummary } from "../../apps/web/src/app/(dashboard)/dashboard/targets/[id]/target-assessment-summary"
import { TargetSpendSummary } from "../../apps/web/src/app/(dashboard)/dashboard/targets/[id]/target-spend-summary"
import { TargetSetupHealth } from "../../apps/web/src/app/(dashboard)/dashboard/targets/[id]/target-setup-health"
import { ReleasePacketView } from "../../apps/web/src/app/reports/release-packet/shared/[id]/release-packet-view"
import {
  projectTargetAssessment,
  type TargetAssessmentSource,
} from "../../apps/web/src/lib/target-assessment"

const spend = {
  maximum: {
    state: "known" as const,
    amountUsd: "3.20",
    source: "ADMITTED_PROVIDER_CEILING" as const,
    observedAt: "2026-11-05T00:00:00.000Z",
  },
  consumed: {
    state: "unavailable" as const,
    reason: "SETTLEMENT_PENDING" as const,
  },
  reserved: {
    state: "unavailable" as const,
    reason: "NO_PROVIDER_DOLLAR_RESERVATION" as const,
  },
  agentMinutes: { funded: 5, charged: 2, absorbed: 1 },
}

const baseSource: TargetAssessmentSource = {
  target: { id: "target-1", name: "Release App", type: "WEB_APP", environment: "PRODUCTION" },
  canStartScan: true,
  latestScan: null,
  gate: { status: "available", value: null },
  remediation: {
    status: "available",
    value: {
      newFindings: 2,
      recurringFindings: 1,
      resolvedFindings: 1,
      uncertainMatches: 1,
      blockingFindings: 2,
    },
  },
  spend: { status: "available", value: spend },
}

export default function CustomerSetupQualityHarness() {
  const params = new URLSearchParams(location.search)
  if (params.has("release-packet")) {
    return <ReleasePacketView payload={historicalPacket} workspaceId="ws-1" reportId="packet-1" />
  }
  const failed = params.get("target-assessment") === "failure"
  const projection = projectTargetAssessment({
    ...baseSource,
    remediation: failed
      ? { status: "unavailable", code: "REMEDIATION_UNAVAILABLE" }
      : baseSource.remediation,
  })
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <TargetAssessmentSummary projection={projection} />
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <TargetSetupHealth
          workspaceId="ws-1"
          targetId="target-1"
          goal="LAUNCH_REVIEW"
          mode="STANDARD"
        />
        <TargetSpendSummary projection={projection.spend} />
      </div>
    </main>
  )
}

const historicalPacket: ReleasePacketPayload = {
  version: "release_packet/1.0.0",
  packetChecksum: "a".repeat(64),
  generatedAt: "2026-11-05T00:00:00.000Z",
  target: { id: "target-1", name: "Release App", type: "WEB_APP", environment: "PRODUCTION" },
  assessment: {
    verdictId: "verdict-1",
    standardVersion: "lyrashield-gate/2.4.0",
    state: "INSUFFICIENT_EVIDENCE",
    historicalState: "NOT_READY",
    applicable: false,
    reasons: [{ code: "EVIDENCE_CHANGED", message: "Evidence changed after assessment" }],
    evaluatedAt: "2026-11-05T00:00:00.000Z",
    assessedIdentity: { kind: "COMMIT", value: "b".repeat(40) },
    coverageStatement: ["sast"],
    nonCoverage: [{ controlId: "sca", scanner: "sca", reason: "feed unavailable" }],
  },
  signedAssessment: {
    state: "UNAVAILABLE",
    reportId: "assessment-report-1",
    reason: "verification key unavailable",
  },
  remediation: {
    baselineScanId: "scan-0",
    currentScanId: "scan-1",
    counts: { newFindings: 1, recurringFindings: 1, resolvedFindings: 1, uncertainMatches: 1 },
    findings: [
      {
        category: "uncertain",
        findingId: "finding-1",
        dedupeKey: "dedupe-1",
        title: "Potential tenant escape",
        severity: "HIGH",
        status: "OPEN",
        verificationStatus: "DETECTED",
        sourceRevision: "b".repeat(40),
        evidenceHref: "/dashboard/findings/finding-1",
        retestState: "unsupported",
        proposalState: "stale",
      },
    ],
    truncated: false,
  },
  coverage: {
    completed: ["sast"],
    notApplicable: [],
    incomplete: ["sca"],
    manifestChecksum: "c".repeat(64),
  },
}
