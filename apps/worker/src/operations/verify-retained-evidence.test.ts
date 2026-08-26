import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ getSystemPrisma: vi.fn() }))
vi.mock("@lyrashield/evidence-storage", () => ({ readEncryptedArtifact: vi.fn() }))

import {
  runRetainedEvidenceCli,
  verifyRetainedEvidence,
  type RetainedEvidenceVerifierDeps,
} from "./verify-retained-evidence"

const CHECKSUM = "a".repeat(64)
const EXPECTED = {
  evidenceId: "ev_exact_1",
  workspaceId: "ws-1",
  encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
  checksum: CHECKSUM,
}

function deps(overrides: Partial<RetainedEvidenceVerifierDeps> = {}): RetainedEvidenceVerifierDeps {
  return {
    findEvidence: vi.fn().mockResolvedValue({
      storageUri: "s3://private/evidence/ws-1/artifact",
      checksum: CHECKSUM,
      encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
      finding: { workspaceId: "ws-1" },
    }),
    readArtifact: vi.fn().mockResolvedValue({
      checksum: CHECKSUM,
      encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
    }),
    ...overrides,
  }
}

describe("verifyRetainedEvidence", () => {
  it("reads only the exact record and verifies its immutable checksum", async () => {
    const testDeps = deps()
    await expect(verifyRetainedEvidence(EXPECTED, testDeps)).resolves.toBeUndefined()
    expect(testDeps.findEvidence).toHaveBeenCalledWith("ev_exact_1", "ws-1")
    expect(testDeps.readArtifact).toHaveBeenCalledWith(
      "s3://private/evidence/ws-1/artifact",
      "ws-1"
    )
  })

  it("fails closed for malformed IDs, missing metadata, and checksum drift", async () => {
    await expect(
      verifyRetainedEvidence({ ...EXPECTED, evidenceId: "ev/*" }, deps())
    ).rejects.toThrow(/exact database/)
    await expect(
      verifyRetainedEvidence({ ...EXPECTED, workspaceId: "ws/*" }, deps())
    ).rejects.toThrow(/workspace ID/)
    await expect(
      verifyRetainedEvidence({ ...EXPECTED, encryptionKeyRef: "current" }, deps())
    ).rejects.toThrow(/versioned evidence key ref/)
    await expect(
      verifyRetainedEvidence({ ...EXPECTED, checksum: "ABC123" }, deps())
    ).rejects.toThrow(/lowercase SHA-256/)
    await expect(
      verifyRetainedEvidence(
        EXPECTED,
        deps({
          findEvidence: vi.fn().mockResolvedValue({
            storageUri: null,
            checksum: null,
            encryptionKeyRef: null,
            finding: { workspaceId: "ws-1" },
          }),
        })
      )
    ).rejects.toThrow(/missing retained encryption metadata/)
    await expect(
      verifyRetainedEvidence(
        EXPECTED,
        deps({
          readArtifact: vi.fn().mockResolvedValue({
            checksum: "b".repeat(64),
            encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
          }),
        })
      )
    ).rejects.toThrow(/checksum/)
    await expect(
      verifyRetainedEvidence(
        EXPECTED,
        deps({
          readArtifact: vi.fn().mockResolvedValue({
            checksum: CHECKSUM,
            encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v2",
          }),
        })
      )
    ).rejects.toThrow(/key reference/)
  })

  it("binds workspace, key ref, and checksum before reading object storage", async () => {
    for (const changed of [
      { workspaceId: "ws-other" },
      { encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v2" },
      { checksum: "b".repeat(64) },
    ]) {
      const testDeps = deps()
      await expect(verifyRetainedEvidence({ ...EXPECTED, ...changed }, testDeps)).rejects.toThrow(
        /operator-bound metadata/
      )
      expect(testDeps.readArtifact).not.toHaveBeenCalled()
    }
  })

  it("prints fixed markers without leaking dependency errors or private metadata", async () => {
    const output = { log: vi.fn(), error: vi.fn() }
    const testDeps = deps({
      findEvidence: vi
        .fn()
        .mockRejectedValue(new Error("secret=s3://private-bucket/content-and-key")),
    })

    await expect(
      runRetainedEvidenceCli(
        [
          "--evidence-id",
          EXPECTED.evidenceId,
          "--workspace-id",
          EXPECTED.workspaceId,
          "--expected-key-ref",
          EXPECTED.encryptionKeyRef,
          "--expected-checksum",
          EXPECTED.checksum,
        ],
        testDeps,
        output
      )
    ).resolves.toBe(1)
    expect(output.log).not.toHaveBeenCalled()
    expect(output.error).toHaveBeenCalledWith("RETAINED_EVIDENCE_READBACK_FAILED")
    expect(JSON.stringify(output.error.mock.calls)).not.toContain("private-bucket")
  })
})
