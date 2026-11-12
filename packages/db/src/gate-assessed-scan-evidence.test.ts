import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { isVerifiedAssessedScan } from "./gate-assessed-scan-evidence"

function fixture() {
  const coverage = [
    {
      scanner: "sca",
      controlId: "sca",
      status: "COMPLETED",
      reason: null,
      subject: null,
      metadata: null,
    },
  ]
  const manifest = {
    target: { id: "target", type: "REPO" },
    sourceExecution: { sourceRevision: "a".repeat(40) },
    terminalOutcome: { status: "COMPLETED" },
    coverage,
  }
  const checksumInput = JSON.stringify(manifest)
  const checksum = createHash("sha256").update(checksumInput).digest("hex")
  const endedAt = new Date("2026-11-12T00:00:00Z")
  return {
    workspaceId: "ws",
    verdict: {
      targetId: "target",
      scanId: "scan",
      assessmentSnapshot: {
        version: 2,
        scanId: "scan",
        completedAtMs: endedAt.getTime(),
        manifestChecksum: checksum,
        manifestVersion: RESULT_MANIFEST_VERSION,
        policyId: "policy",
        policyFingerprint: "fingerprint",
        identity: { kind: "COMMIT", value: "a".repeat(40) },
      },
    },
    target: { id: "target", workspaceId: "ws", type: "REPO", deletedAt: null },
    scan: {
      id: "scan",
      workspaceId: "ws",
      targetId: "target",
      deletedAt: null,
      status: "COMPLETED",
      endedAt,
      policyId: "policy",
      resultManifest: { version: RESULT_MANIFEST_VERSION, checksumInput, checksum, manifest },
      coverageReceipts: coverage,
    },
    overflow: false,
  }
}

describe("assessed scan evidence", () => {
  it("accepts a same-workspace completed scan bound to checksum, coverage and snapshot", () => {
    expect(isVerifiedAssessedScan(fixture())).toBe(true)
  })

  it.each([
    [
      "legacy manifest",
      (f: ReturnType<typeof fixture>) => {
        f.scan.resultManifest.checksumInput = null as never
      },
    ],
    [
      "tampered checksum input",
      (f: ReturnType<typeof fixture>) => {
        f.scan.resultManifest.checksumInput += " "
      },
    ],
    [
      "changed manifest",
      (f: ReturnType<typeof fixture>) => {
        f.scan.resultManifest.manifest.target.type = "API"
      },
    ],
    [
      "changed coverage",
      (f: ReturnType<typeof fixture>) => {
        f.scan.coverageReceipts = []
      },
    ],
    [
      "foreign workspace",
      (f: ReturnType<typeof fixture>) => {
        f.scan.workspaceId = "foreign"
      },
    ],
    [
      "foreign target",
      (f: ReturnType<typeof fixture>) => {
        f.scan.targetId = "foreign"
      },
    ],
    [
      "deleted target",
      (f: ReturnType<typeof fixture>) => {
        f.target.deletedAt = new Date() as never
      },
    ],
    [
      "deleted scan",
      (f: ReturnType<typeof fixture>) => {
        f.scan.deletedAt = new Date() as never
      },
    ],
    [
      "incomplete scan",
      (f: ReturnType<typeof fixture>) => {
        f.scan.status = "PARTIAL"
      },
    ],
    [
      "mismatched verdict scan",
      (f: ReturnType<typeof fixture>) => {
        f.verdict.scanId = "other"
      },
    ],
    [
      "mismatched release identity",
      (f: ReturnType<typeof fixture>) => {
        f.verdict.assessmentSnapshot.identity.value = "b".repeat(40)
      },
    ],
    [
      "mismatched completion time",
      (f: ReturnType<typeof fixture>) => {
        f.verdict.assessmentSnapshot.completedAtMs++
      },
    ],
    [
      "mismatched policy",
      (f: ReturnType<typeof fixture>) => {
        f.scan.policyId = "other"
      },
    ],
    [
      "unsupported manifest version",
      (f: ReturnType<typeof fixture>) => {
        f.scan.resultManifest.version++
      },
    ],
    [
      "overflow",
      (f: ReturnType<typeof fixture>) => {
        f.overflow = true
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const input = fixture()
    mutate(input)
    expect(isVerifiedAssessedScan(input)).toBe(false)
  })
})
