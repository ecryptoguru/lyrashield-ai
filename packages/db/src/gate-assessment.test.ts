import { describe, expect, it } from "vitest"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { GATE_ASSESSMENT_VERSION } from "@lyrashield/gate"
import { fingerprintPolicy, parseAssessmentSnapshot, snapshotFromManifest } from "./gate-assessment"

/**
 * The stored manifest version is shared between the worker producer
 * (manifest-types re-exports RESULT_MANIFEST_VERSION) and this consumer. These
 * tests pin the consumer side of the contract: it accepts exactly the shared
 * version and rejects everything else, so a producer bump without a reader
 * bump fails closed — never silently misreads.
 */
describe("gate-assessment manifest version contract", () => {
  const baseInput = {
    scanId: "scan-1",
    endedAt: new Date("2026-01-01T00:00:00Z"),
    policyId: "policy-1",
    policyFingerprint: fingerprintPolicy({ mode: "STANDARD" }),
    manifest: {
      version: RESULT_MANIFEST_VERSION,
      checksum: "a".repeat(64),
      manifest: {
        sourceExecution: {
          kind: "deterministic_retest",
          sourceRevision: "b".repeat(40),
        },
      },
    },
  }

  it("accepts a manifest stamped with the shared RESULT_MANIFEST_VERSION", () => {
    const snapshot = snapshotFromManifest(baseInput)
    expect(snapshot).toMatchObject({
      version: GATE_ASSESSMENT_VERSION,
      manifestVersion: RESULT_MANIFEST_VERSION,
      identity: { kind: "COMMIT", value: "b".repeat(40) },
    })
  })

  it("rejects manifests one version below and above the supported contract", () => {
    for (const version of [RESULT_MANIFEST_VERSION - 1, RESULT_MANIFEST_VERSION + 1]) {
      expect(
        snapshotFromManifest({
          ...baseInput,
          manifest: { ...baseInput.manifest, version },
        })
      ).toBeNull()
    }
  })

  it("rejects stored snapshots whose manifestVersion is not the shared version", () => {
    const snapshot = snapshotFromManifest(baseInput)
    expect(snapshot).not.toBeNull()
    expect(parseAssessmentSnapshot(snapshot)).toMatchObject({
      manifestVersion: RESULT_MANIFEST_VERSION,
    })
    expect(
      parseAssessmentSnapshot({ ...snapshot!, manifestVersion: RESULT_MANIFEST_VERSION - 1 })
    ).toBeNull()
    expect(
      parseAssessmentSnapshot({ ...snapshot!, manifestVersion: RESULT_MANIFEST_VERSION + 1 })
    ).toBeNull()
  })
})
