import type { ReleasePacketPayload } from "@lyrashield/types"
import { useState } from "react"
import { TargetAssessmentSummary } from "../../apps/web/src/app/(dashboard)/dashboard/targets/[id]/target-assessment-summary"
import { TargetSpendSummary } from "../../apps/web/src/app/(dashboard)/dashboard/targets/[id]/target-spend-summary"
import { TargetSetupHealth } from "../../apps/web/src/app/(dashboard)/dashboard/targets/[id]/target-setup-health"
import { ReleasePacketView } from "../../apps/web/src/app/reports/release-packet/shared/[id]/release-packet-view"
import {
  projectTargetAssessment,
  type TargetAssessmentSource,
} from "../../apps/web/src/lib/target-assessment"

const spend = {
  state: "reconciled" as const,
  chargedMinutes: 2,
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
  const [actorId, setActorId] = useState("actor-1")
  const params = new URLSearchParams(location.search)
  if (params.has("release-packet")) {
    const signed = params.get("release-packet") === "signed"
    return (
      <ReleasePacketView
        result={{
          payload: signed
            ? {
                ...historicalPacket,
                version: "release_packet/1.1.0",
                signingKeyId: `lyrashield-packet-ed25519-${"d".repeat(64)}`,
                packetSignature: `${"a".repeat(86)}==`,
                expiresAt: "2026-11-06T06:00:00.000Z",
                signedAssessment: { state: "SIGNED" },
              }
            : historicalPacket,
          authenticity: {
            signatureState: signed
              ? "VERIFIED"
              : params.get("release-packet") === "invalid"
                ? "INVALID"
                : "HISTORICAL_UNSIGNED",
            expiresAt: signed ? "2026-11-06T06:00:00.000Z" : null,
            expired: signed ? false : null,
            checkedAt: "2026-11-06T00:00:00.000Z",
          },
          assessmentValidity: {
            signatureState: signed ? "VERIFIED" : "UNAVAILABLE",
            expiresAt: signed ? "2026-11-06T06:00:00.000Z" : null,
            expired: signed ? false : null,
          },
          currentApplicability: { state: signed ? "CURRENT" : "NOT_CURRENT", reasons: [] },
        }}
        workspaceId="ws-1"
        reportId="packet-1"
      />
    )
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
      <button type="button" onClick={() => setActorId("actor-2")}>
        Switch account
      </button>
      <TargetAssessmentSummary projection={projection} />
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <TargetSetupHealth
          workspaceId="ws-1"
          targetId="target-1"
          actorId={actorId}
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
