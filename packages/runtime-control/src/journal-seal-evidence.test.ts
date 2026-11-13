import { createHash, createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import { createJournalSeal, createObservedSealAck } from "./journal-seal"
import { StoredJournalSealEvidenceReader } from "./journal-seal-evidence"
import { recordHash, signRecord } from "./journal-record"

const headKey = "head-key-".repeat(8)
const sealKey = "seal-key-".repeat(8)
const originalKey = "original-key-".repeat(8)
const payloadSchema = z.object({ value: z.string() }).strict()
const prefix = "epochs/epoch-1/supervisors/supervisor-1"
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex")
const sign = (key: string, value: unknown) =>
  createHmac("sha256", key).update(canonicalJson(value)).digest("hex")

function fixture() {
  const originalBody = {
    version: 1 as const,
    sequence: 1,
    previousHash: "0".repeat(64),
    payload: { value: "original" },
  }
  const originalHash = recordHash(originalBody)
  const original = {
    ...originalBody,
    hash: originalHash,
    signature: signRecord(originalKey, canonicalJson({ ...originalBody, hash: originalHash })),
  }
  const wrapperBody = {
    version: 1 as const,
    sequence: 1,
    previousHash: "0".repeat(64),
    payload: {
      epochId: "epoch-1",
      operationId: "operation-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      attemptId: "attempt-1",
      eventId: "event-1",
      payload: original,
    },
  }
  const wrapperHash = recordHash(wrapperBody)
  const wrapper = {
    ...wrapperBody,
    hash: wrapperHash,
    signature: signRecord(headKey, canonicalJson({ ...wrapperBody, hash: wrapperHash })),
  }
  const headBody = {
    schema: "lyrashield-independent-authority-head/1" as const,
    supervisorInstanceId: "supervisor-1",
    epochId: "epoch-1",
    operationId: "operation-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    attemptId: "attempt-1",
    eventId: "event-1",
    sequence: 1,
    previousHash: "0".repeat(64),
    recordHash: wrapperHash,
  }
  const head = { ...headBody, signature: sign(headKey, headBody) }
  const ackBody = { schema: "lyrashield-supervisor-observed-mirror-ack/1", head }
  const ack = canonicalJson({ ...ackBody, signature: sign(headKey, ackBody) })
  const originalArchive = `${JSON.stringify(original)}\n`
  const wrapperArchive = `${JSON.stringify(wrapper)}\n`
  const seal = createJournalSeal(
    {
      schema: "lyrashield-journal-seal/1",
      epochId: "epoch-1",
      supervisorInstanceId: "supervisor-1",
      revision: 1,
      firstSequence: 1,
      lastSequence: 1,
      previousSealHash: "0".repeat(64),
      originalPreviousHash: "0".repeat(64),
      originalLastHash: originalHash,
      wrapperPreviousHash: "0".repeat(64),
      wrapperLastHash: head.recordHash,
      originalSegmentSha256: hash(originalArchive),
      wrapperSegmentSha256: hash(wrapperArchive),
      originalBytes: Buffer.byteLength(originalArchive),
      wrapperBytes: Buffer.byteLength(wrapperArchive),
      recordCount: 1,
      independentHeadHash: hash(canonicalJson(head)),
      observedJournalAckHash: hash(ack),
    },
    sealKey
  )
  const sealAck = canonicalJson(createObservedSealAck(seal, sealKey))
  const objects = new Map([
    [`${prefix}/head`, canonicalJson(head)],
    [`${prefix}/seal-head`, canonicalJson(seal)],
    [`${prefix}/seals/${seal.sealHash}`, canonicalJson(seal)],
    [`${prefix}/acknowledgements/1`, ack],
    [`${prefix}/seal-acknowledgements/${seal.sealHash}`, sealAck],
    [`${prefix}/seal-segments/${seal.sealHash}/original`, originalArchive],
    [`${prefix}/seal-segments/${seal.sealHash}/wrapper`, wrapperArchive],
  ])
  let mirrorHead = head
  let mirrorSeal = seal
  let retainedMirrorSeal: typeof seal | null = seal
  const store = {
    readBounded: async (key: string, maxBytes: number) => {
      const value = objects.get(key)
      if (value === undefined) return null
      const bytes = Buffer.from(value)
      if (bytes.length > maxBytes) throw new Error("oversized")
      return { bytes, etag: `etag-${hash(value)}` }
    },
  }
  const mirror = {
    readHeadBounded: async () => mirrorHead,
    readSealHeadBounded: async () => mirrorSeal,
    readSealBounded: async () => retainedMirrorSeal,
  }
  const reader = new StoredJournalSealEvidenceReader({
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
    store,
    mirror,
    headSigningSecret: headKey,
    sealSigningSecret: sealKey,
    originalSigningSecret: originalKey,
    wrapperSigningSecret: headKey,
    validateOriginal: (value) => payloadSchema.parse(value),
  })
  return {
    reader,
    objects,
    seal,
    head,
    setMirrorHead: (value: typeof head) => {
      mirrorHead = value
    },
    setMirrorSeal: (value: typeof seal) => {
      mirrorSeal = value
    },
    deleteMirrorSeal: () => {
      retainedMirrorSeal = null
    },
    setRetainedMirrorSeal: (value: typeof seal) => {
      retainedMirrorSeal = value
    },
  }
}

describe("independent current seal evidence", () => {
  it("binds the reader to the installed stream and all root-pinned key hashes", () => {
    const f = fixture()
    const installed = {
      epochId: "epoch-1",
      supervisorInstanceId: "supervisor-1",
      originalKeyHash: hash(originalKey),
      wrapperKeyHash: hash(headKey),
      checkpointKeyHash: hash(sealKey),
    }
    expect(() => f.reader.assertInstalledStream(installed)).not.toThrow()
    expect(() =>
      f.reader.assertInstalledStream({ ...installed, originalKeyHash: "f".repeat(64) })
    ).toThrow()
    expect(() =>
      f.reader.assertInstalledStream({ ...installed, wrapperKeyHash: "f".repeat(64) })
    ).toThrow()
    expect(() =>
      f.reader.assertInstalledStream({ ...installed, checkpointKeyHash: "f".repeat(64) })
    ).toThrow()
    expect(() =>
      f.reader.assertInstalledStream({ ...installed, epochId: "foreign-epoch" })
    ).toThrow()
  })
  it("reads and authenticates matching live heads and both exact observed acknowledgements", async () => {
    const f = fixture()
    const evidence = await f.reader.readCurrentSealEvidence({
      epochId: "epoch-1",
      supervisorInstanceId: "supervisor-1",
    })
    expect(evidence?.seal).toEqual(f.seal)
    expect(evidence?.journalHead).toEqual(f.head)
    expect(Buffer.from(evidence!.journalObservedAck).toString("utf8")).toBe(
      f.objects.get(`${prefix}/acknowledgements/1`)
    )
  })

  it.each([
    "missing-ack",
    "missing-journal-ack",
    "changed-ack",
    "missing-archive",
    "changed-archive",
    "missing-mirror-record",
    "changed-seal",
    "foreign-head",
    "mirror-seal",
  ])("fails closed on %s without inventing an acknowledgement", async (damage) => {
    const f = fixture()
    if (damage === "missing-ack")
      f.objects.delete(`${prefix}/seal-acknowledgements/${f.seal.sealHash}`)
    if (damage === "missing-journal-ack") f.objects.delete(`${prefix}/acknowledgements/1`)
    if (damage === "changed-ack") f.objects.set(`${prefix}/acknowledgements/1`, "{}")
    if (damage === "missing-archive")
      f.objects.delete(`${prefix}/seal-segments/${f.seal.sealHash}/original`)
    if (damage === "changed-archive")
      f.objects.set(`${prefix}/seal-segments/${f.seal.sealHash}/wrapper`, "x".repeat(200))
    if (damage === "changed-seal") f.objects.set(`${prefix}/seals/${f.seal.sealHash}`, "{}")
    if (damage === "foreign-head") f.setMirrorHead({ ...f.head, recordHash: "f".repeat(64) })
    if (damage === "mirror-seal") f.setMirrorSeal({ ...f.seal, sealHash: "f".repeat(64) })
    if (damage === "missing-mirror-record") f.deleteMirrorSeal()
    await expect(
      f.reader.readCurrentSealEvidence({
        epochId: "epoch-1",
        supervisorInstanceId: "supervisor-1",
      })
    ).rejects.toThrow()
  })

  it("independently rejects invalid original signatures even under a re-signed seal", async () => {
    const f = fixture()
    const oldPrefix = `${prefix}/seal-segments/${f.seal.sealHash}`
    const original = f.objects
      .get(`${oldPrefix}/original`)!
      .replace('"value":"original"', '"value":"tampered"')
    const wrapper = f.objects.get(`${oldPrefix}/wrapper`)!
    const body = { ...f.seal }
    Reflect.deleteProperty(body, "sealHash")
    Reflect.deleteProperty(body, "signature")
    const forged = createJournalSeal(
      {
        ...body,
        originalSegmentSha256: hash(original),
        originalBytes: Buffer.byteLength(original),
      },
      sealKey
    )
    f.objects.set(`${prefix}/seal-head`, canonicalJson(forged))
    f.objects.set(`${prefix}/seals/${forged.sealHash}`, canonicalJson(forged))
    f.objects.set(
      `${prefix}/seal-acknowledgements/${forged.sealHash}`,
      canonicalJson(createObservedSealAck(forged, sealKey))
    )
    f.objects.set(`${prefix}/seal-segments/${forged.sealHash}/original`, original)
    f.objects.set(`${prefix}/seal-segments/${forged.sealHash}/wrapper`, wrapper)
    f.setMirrorSeal(forged)
    f.setRetainedMirrorSeal(forged)
    await expect(
      f.reader.readCurrentSealEvidence({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
    ).rejects.toThrow(/signature|hash/)
  })

  it("requires the exact committed recovery snapshot before accepting a v2 seal", async () => {
    const f = fixture()
    const oldPrefix = `${prefix}/seal-segments/${f.seal.sealHash}`
    const original = f.objects.get(`${oldPrefix}/original`)!
    const wrapper = f.objects.get(`${oldPrefix}/wrapper`)!
    const snapshot = canonicalJson({ schema: "test-snapshot/1", value: "retained" })
    const body = { ...f.seal }
    Reflect.deleteProperty(body, "sealHash")
    Reflect.deleteProperty(body, "signature")
    const seal = createJournalSeal(
      {
        ...body,
        schema: "lyrashield-journal-seal/2",
        originalSegmentStartSequence: 1,
        originalByteOffset: Buffer.byteLength(original),
        wrapperSegmentStartSequence: 1,
        wrapperByteOffset: Buffer.byteLength(wrapper),
        recoverySnapshotSha256: hash(snapshot),
        recoverySnapshotBytes: Buffer.byteLength(snapshot),
      },
      sealKey
    )
    f.objects.set(`${prefix}/seal-head`, canonicalJson(seal))
    f.objects.set(`${prefix}/seals/${seal.sealHash}`, canonicalJson(seal))
    f.objects.set(
      `${prefix}/seal-acknowledgements/${seal.sealHash}`,
      canonicalJson(createObservedSealAck(seal, sealKey))
    )
    f.objects.set(`${prefix}/seal-segments/${seal.sealHash}/original`, original)
    f.objects.set(`${prefix}/seal-segments/${seal.sealHash}/wrapper`, wrapper)
    f.objects.set(`${prefix}/seal-journal-heads/${seal.independentHeadHash}`, canonicalJson(f.head))
    f.setMirrorSeal(seal)
    f.setRetainedMirrorSeal(seal)
    await expect(
      f.reader.readCurrentSealEvidence({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
    ).rejects.toThrow(/snapshot|unavailable/)
    f.objects.set(`${prefix}/recovery-snapshots/${seal.sealHash}`, snapshot)
    expect(
      (
        await f.reader.readCurrentSealEvidence({
          epochId: "epoch-1",
          supervisorInstanceId: "supervisor-1",
        })
      )?.seal
    ).toEqual(seal)
    const headBody = { ...f.head }
    Reflect.deleteProperty(headBody, "signature")
    const nextBody = {
      ...headBody,
      sequence: 2,
      previousHash: f.head.recordHash,
      recordHash: "f".repeat(64),
      eventId: "event-2",
    }
    const newerHead = { ...nextBody, signature: sign(headKey, nextBody) }
    f.setMirrorHead(newerHead)
    f.objects.set(`${prefix}/head`, canonicalJson(newerHead))
    await expect(
      f.reader.readCurrentSealEvidence({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
    ).rejects.toThrow()
    expect(
      (
        await f.reader.readSealAnchorForContinuation({
          epochId: "epoch-1",
          supervisorInstanceId: "supervisor-1",
        })
      )?.journalHead
    ).toEqual(newerHead)
    f.objects.delete(`${prefix}/seal-journal-heads/${seal.independentHeadHash}`)
    await expect(
      f.reader.readSealAnchorForContinuation({
        epochId: "epoch-1",
        supervisorInstanceId: "supervisor-1",
      })
    ).rejects.toThrow()
    f.objects.set(`${prefix}/seal-journal-heads/${seal.independentHeadHash}`, canonicalJson(f.head))
    f.setMirrorHead(f.head)
    f.objects.set(`${prefix}/head`, canonicalJson(f.head))
    f.objects.set(
      `${prefix}/recovery-snapshots/${seal.sealHash}`,
      snapshot.replace("retained", "modified")
    )
    await expect(
      f.reader.readCurrentSealEvidence({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
    ).rejects.toThrow()
  })
})
