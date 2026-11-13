import { createHash, createHmac } from "node:crypto"
import { Readable } from "node:stream"
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"
import { canonicalJson, sha256Hex } from "./canonical-json"
import { createJournalSeal, type JournalSealEvidence } from "./journal-seal"
import { ProtectedJournalSealPinStore } from "./protected-journal-seal-pin-store"
import { R2ConditionalObjectStore } from "./r2-store"

const secret = "fixture-checkpoint-key-".repeat(3),
  zero = "0".repeat(64)
const stream = { epochId: "epoch-test", supervisorInstanceId: "supervisor-test" }
const sign = (body: unknown) =>
  createHmac("sha256", secret).update(canonicalJson(body)).digest("hex")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function fixture() {
  const options = {
    ...stream,
    epoch: 1,
    productRevision: "a".repeat(40),
    checkpointSecret: secret,
    checkpointKeyHash: sha256Hex(secret),
    controlAccountId: "b".repeat(32),
    controlBucket: "control-fixture",
    genesisRecordHash: "",
  }
  const genesisBody = {
    schema: "lyrashield-root-control-seal-genesis/1",
    productRevision: options.productRevision,
    ...stream,
  }
  const genesis = Buffer.from(canonicalJson({ ...genesisBody, signature: sign(genesisBody) }))
  options.genesisRecordHash = digest(genesis)
  const currentKey = `journal-seal-pins/${stream.epochId}/${stream.supervisorInstanceId}/current`
  const objects = new Map<string, { bytes: Buffer; etag: string }>([
    [currentKey, { bytes: genesis, etag: '"genesis"' }],
  ])
  let serial = 0,
    lost = false,
    active = true,
    writes = 0,
    late = false
  const client = {
    async send(command: GetObjectCommand | PutObjectCommand) {
      const key = command.input.Key!,
        object = objects.get(key)
      if (command instanceof GetObjectCommand) {
        if (!object) throw { $metadata: { httpStatusCode: 404 } }
        return {
          ETag: object.etag,
          ContentLength: object.bytes.length,
          Body: Readable.from([object.bytes]),
        }
      }
      if (
        (command.input.IfNoneMatch === "*" && object) ||
        (command.input.IfMatch && command.input.IfMatch !== object?.etag)
      )
        throw { $metadata: { httpStatusCode: 412 } }
      objects.set(key, {
        bytes: Buffer.from(command.input.Body as Uint8Array),
        etag: `"version-${++serial}"`,
      })
      if (key === currentKey) {
        writes++
        if (late) {
          late = false
          active = false
        }
        if (lost) {
          lost = false
          throw new Error("response lost after commit")
        }
      }
      return {}
    },
  }
  let observed: JournalSealEvidence | null = null
  const root = new ProtectedJournalSealPinStore(
    new R2ConditionalObjectStore(
      client as unknown as Pick<S3Client, "send">,
      options.controlBucket
    ),
    {
      readCurrentSealEvidence: async () => observed,
      readSealAnchorForContinuation: async () => observed,
    },
    {
      withAuthorizedStream: async (_stream, action) =>
        action({
          policy: {
            schema: "lyrashield-journal-seal-control/1",
            ...options,
            streamId: "stream-test",
            controlCredentialId: "a".repeat(32),
            databaseRole: "lyrashield_journal_seal_control",
            originalKeyHash: "c".repeat(64),
            wrapperKeyHash: "d".repeat(64),
            authorityDigest: "sha256:" + "e".repeat(64),
            runtimePolicyDigest: "sha256:" + "f".repeat(64),
          },
          assertActive() {
            if (!active) throw new Error("fence lost")
          },
        }),
    },
    options
  )
  function evidence(revision: number, previous: JournalSealEvidence | null, v2 = false) {
    const head = {
      schema: "lyrashield-independent-authority-head/1" as const,
      epochId: stream.epochId,
      supervisorInstanceId: stream.supervisorInstanceId,
      sequence: revision,
      recordHash: sha256Hex("wrapper" + revision),
      previousHash: previous?.seal.wrapperLastHash ?? zero,
      eventId: "event-" + revision,
      operationId: "operation-test",
      scanId: "scan-test",
      workspaceId: "workspace-test",
      attemptId: "attempt-test",
      signature: "1".repeat(64),
    }
    const journalObservedAck = Buffer.from("fixture independent signed ACK " + revision)
    const seal = createJournalSeal(
      {
        schema: v2 ? "lyrashield-journal-seal/2" : "lyrashield-journal-seal/1",
        ...(v2
          ? {
              originalSegmentStartSequence: 1,
              originalByteOffset: 100,
              wrapperSegmentStartSequence: 1,
              wrapperByteOffset: 120,
              recoverySnapshotSha256: sha256Hex("snapshot"),
              recoverySnapshotBytes: 10,
            }
          : {}),
        ...stream,
        revision,
        firstSequence: revision,
        lastSequence: revision,
        recordCount: 1,
        previousSealHash: previous?.seal.sealHash ?? zero,
        originalPreviousHash: previous?.seal.originalLastHash ?? zero,
        wrapperPreviousHash: previous?.seal.wrapperLastHash ?? zero,
        originalLastHash: sha256Hex("original" + revision),
        wrapperLastHash: head.recordHash,
        originalSegmentSha256: sha256Hex("original-segment" + revision),
        wrapperSegmentSha256: sha256Hex("wrapper-segment" + revision),
        originalBytes: 100,
        wrapperBytes: 120,
        independentHeadHash: sha256Hex(canonicalJson(head)),
        observedJournalAckHash: digest(journalObservedAck),
      },
      secret
    )
    const ack = {
      schema: "lyrashield-journal-seal-observed-mirror-ack/1",
      ...stream,
      revision,
      sealHash: seal.sealHash,
    }
    return {
      seal,
      journalHead: head,
      journalObservedAck,
      sealObservedAck: Buffer.from(canonicalJson({ ...ack, signature: sign(ack) })),
    }
  }
  return {
    root,
    options,
    evidence,
    setEvidence(value: JournalSealEvidence) {
      observed = value
    },
    lose() {
      lost = true
    },
    remove() {
      objects.delete(currentKey)
    },
    deactivate() {
      active = false
    },
    reactivate() {
      active = true
    },
    loseGateAtCas() {
      late = true
    },
    writes: () => writes,
    bytes: () => Buffer.from(objects.get(currentKey)!.bytes),
  }
}
describe("protected monotonic seal pin", () => {
  it("rejects v1 continuation and holds the gate through a v2 tail consumer", async () => {
    const old = fixture()
    old.setEvidence(old.evidence(1, null))
    await old.root.compareAndAdvance({ stream, expected: null })
    await expect(old.root.withBoundedContinuation(stream, async () => true)).rejects.toThrow()
    const f = fixture()
    const observed = f.evidence(1, null, true)
    f.setEvidence(observed)
    await f.root.compareAndAdvance({ stream, expected: null })
    f.setEvidence({
      ...observed,
      journalHead: { ...observed.journalHead, sequence: 2, recordHash: sha256Hex("new tail") },
    })
    expect(
      await f.root.withBoundedContinuation(stream, async ({ seal, journalHead, assertActive }) => {
        expect(seal.lastSequence).toBe(1)
        expect(journalHead.sequence).toBe(2)
        assertActive()
        return "independent tail proof belongs here"
      })
    ).toBe("independent tail proof belongs here")
    await expect(
      f.root.withBoundedContinuation(stream, async () => {
        f.deactivate()
        return "must not escape lost authority"
      })
    ).rejects.toThrow("fence lost")
  })
  it("requires authenticated commissioning seed; a missing object never becomes virgin genesis", async () => {
    const f = fixture()
    expect(await f.root.readCurrent(stream)).toBeNull()
    f.remove()
    await expect(f.root.readCurrent(stream)).rejects.toThrow()
    f.setEvidence(f.evidence(1, null))
    await expect(f.root.compareAndAdvance({ stream, expected: null })).rejects.toThrow()
    expect(f.writes()).toBe(0)
  })
  it("commits first pin against exact authenticated genesis parent and rejects late stale retry", async () => {
    const f = fixture(),
      first = f.evidence(1, null)
    f.setEvidence(first)
    expect(await f.root.compareAndAdvance({ stream, expected: null })).toBe("advanced")
    expect(JSON.parse(f.bytes().toString()).parentPinHash).toBe(f.options.genesisRecordHash)
    const pin = await f.root.readCurrent(stream)
    const second = f.evidence(2, first)
    f.setEvidence(second)
    expect(await f.root.compareAndAdvance({ stream, expected: pin })).toBe("advanced")
    expect(await f.root.compareAndAdvance({ stream, expected: null })).toBe("conflict")
    expect(f.writes()).toBe(2)
  })
  it("lost response retries only the original pin; newer state never acknowledges old operation", async () => {
    const f = fixture(),
      first = f.evidence(1, null)
    f.setEvidence(first)
    f.lose()
    await expect(f.root.compareAndAdvance({ stream, expected: null })).rejects.toThrow()
    expect(await f.root.compareAndAdvance({ stream, expected: null })).toBe("advanced")
    expect(f.writes()).toBe(2)
    const pin = await f.root.readCurrent(stream)
    f.setEvidence(f.evidence(2, first))
    await f.root.compareAndAdvance({ stream, expected: pin })
    expect(await f.root.compareAndAdvance({ stream, expected: null })).toBe("conflict")
  })
  it("late CAS after gate loss stays unconfirmed until exact conditional replay returns under fresh authority", async () => {
    const f = fixture(),
      first = f.evidence(1, null)
    f.setEvidence(first)
    f.loseGateAtCas()
    await expect(f.root.compareAndAdvance({ stream, expected: null })).rejects.toThrow()
    f.reactivate()
    await expect(f.root.readCurrent(stream)).rejects.toThrow()
    expect((await f.root.retryPending(stream, first.seal.sealHash)).sealHash).toBe(
      first.seal.sealHash
    )
    expect((await f.root.readCurrent(stream))?.revision).toBe(1)
    expect(f.writes()).toBe(2)
  })
  it("restored journal history and lost active fence cannot lower or advance the control pin", async () => {
    const f = fixture(),
      first = f.evidence(1, null)
    f.setEvidence(first)
    await f.root.compareAndAdvance({ stream, expected: null })
    const pin = await f.root.readCurrent(stream)
    const second = f.evidence(2, first)
    f.setEvidence(second)
    await f.root.compareAndAdvance({ stream, expected: pin })
    const current = await f.root.readCurrent(stream)
    f.setEvidence(first)
    await expect(f.root.compareAndAdvance({ stream, expected: current })).rejects.toThrow()
    f.setEvidence(f.evidence(3, second))
    f.deactivate()
    await expect(f.root.compareAndAdvance({ stream, expected: current })).rejects.toThrow()
    expect(f.writes()).toBe(2)
  })
})
