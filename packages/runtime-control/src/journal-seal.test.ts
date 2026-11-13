import { describe, expect, it } from "vitest"
import {
  createJournalSeal,
  verifyJournalSeal,
  verifyJournalSealForContinuation,
  createObservedSealAck,
  verifyObservedSealAck,
} from "./journal-seal"

const genesis = "0".repeat(64)
const key = "checkpoint-key-".repeat(4)
const body = {
  schema: "lyrashield-journal-seal/1" as const,
  epochId: "epoch-1",
  supervisorInstanceId: "supervisor-1",
  revision: 1,
  firstSequence: 1,
  lastSequence: 2,
  previousSealHash: genesis,
  originalPreviousHash: genesis,
  originalLastHash: "1".repeat(64),
  wrapperPreviousHash: genesis,
  wrapperLastHash: "2".repeat(64),
  originalSegmentSha256: "3".repeat(64),
  wrapperSegmentSha256: "4".repeat(64),
  originalBytes: 100,
  wrapperBytes: 200,
  recordCount: 2,
  independentHeadHash: "5".repeat(64),
  observedJournalAckHash: "6".repeat(64),
}

describe("signed journal seal", () => {
  it("authenticates the entire segment commitment and rejects changed fields", () => {
    const signed = createJournalSeal(body, key)
    expect(verifyJournalSeal(signed, key)).toEqual(signed)
    expect(() => verifyJournalSeal({ ...signed, wrapperLastHash: "7".repeat(64) }, key)).toThrow()
    expect(() => verifyJournalSeal({ ...signed, extra: true }, key)).toThrow()
    expect(() => verifyJournalSeal(signed, "different-key-".repeat(4))).toThrow()
  })

  it("rejects malformed ranges, counts and genesis anchors before signing", () => {
    expect(() => createJournalSeal({ ...body, recordCount: 1 }, key)).toThrow()
    expect(() => createJournalSeal({ ...body, lastSequence: 33, recordCount: 33 }, key)).toThrow()
    expect(() => createJournalSeal({ ...body, previousSealHash: "1".repeat(64) }, key)).toThrow()
  })

  it("binds the observed database seal acknowledgement to the exact seal identity", () => {
    const seal = createJournalSeal(body, key)
    const acknowledgement = createObservedSealAck(seal, key)
    expect(verifyObservedSealAck(acknowledgement, key)).toEqual(acknowledgement)
    expect(() => verifyObservedSealAck({ ...acknowledgement, revision: 2 }, key)).toThrow()
    expect(() =>
      verifyObservedSealAck({ ...acknowledgement, sealHash: "a".repeat(64) }, key)
    ).toThrow()
    expect(() => verifyObservedSealAck(acknowledgement, "different-key-".repeat(4))).toThrow()
  })

  it("authenticates v2 byte positions and the bounded recovery snapshot", () => {
    const v2 = {
      ...body,
      schema: "lyrashield-journal-seal/2" as const,
      originalSegmentStartSequence: 1,
      originalByteOffset: 100,
      wrapperSegmentStartSequence: 1,
      wrapperByteOffset: 200,
      recoverySnapshotSha256: "8".repeat(64),
      recoverySnapshotBytes: 512,
    }
    const signed = createJournalSeal(v2, key)
    expect(verifyJournalSeal(signed, key)).toEqual(signed)
    expect(verifyJournalSealForContinuation(signed, key)).toEqual(signed)
    expect(() => verifyJournalSealForContinuation(createJournalSeal(body, key), key)).toThrow()
    expect(() => verifyJournalSeal({ ...signed, originalByteOffset: 101 }, key)).toThrow()
    expect(() =>
      verifyJournalSeal({ ...signed, recoverySnapshotSha256: "9".repeat(64) }, key)
    ).toThrow()
    expect(() => createJournalSeal({ ...v2, wrapperByteOffset: -1 }, key)).toThrow()
    expect(() =>
      createJournalSeal({ ...v2, originalByteOffset: 64 * 1024 * 1024 + 1 }, key)
    ).toThrow()
    expect(() => createJournalSeal({ ...v2, originalSegmentStartSequence: 3 }, key)).toThrow()
    expect(() =>
      createJournalSeal({ ...v2, recoverySnapshotBytes: 1024 * 1024 + 1 }, key)
    ).toThrow()
    expect(() =>
      verifyJournalSeal({ ...createJournalSeal(body, key), recoverySnapshotBytes: 512 }, key)
    ).toThrow()
    const missing: Partial<typeof v2> = { ...v2 }
    delete missing.recoverySnapshotSha256
    expect(() => createJournalSeal(missing as typeof v2, key)).toThrow()
  })
})
