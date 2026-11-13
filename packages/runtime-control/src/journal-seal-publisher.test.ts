import { createHash, createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import {
  IndependentAuthorityJournal,
  authorityEventSchema,
  type AuthorityHead,
} from "./independent-journal"
import { SignedJournal, type JournalRecord } from "./journal"
import { StoredJournalSealEvidenceReader } from "./journal-seal-evidence"
import { JournalSealPublisher } from "./journal-seal-publisher"
import { withVerifiedJournalContinuation } from "./journal-continuation"
import type { JournalSeal } from "./journal-seal"
import { ProtectedJournalSealPinStore } from "./protected-journal-seal-pin-store"
import { R2ConditionalObjectStore } from "./r2-store"

const roots: string[] = []
const originalKey = "o".repeat(48),
  wrapperKey = "w".repeat(48),
  sealKey = "s".repeat(48)
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function objectStore(bucket: string) {
  const objects = new Map<string, { bytes: Buffer; etag: string }>()
  let serial = 0
  const client = {
    async send(command: GetObjectCommand | PutObjectCommand) {
      const key = command.input.Key!
      const current = objects.get(key)
      if (command instanceof GetObjectCommand) {
        if (!current) throw { $metadata: { httpStatusCode: 404 } }
        return {
          ETag: current.etag,
          ContentLength: current.bytes.length,
          Body: Readable.from([current.bytes]),
        }
      }
      if (
        (command.input.IfNoneMatch === "*" && current) ||
        (command.input.IfMatch && command.input.IfMatch !== current?.etag)
      )
        throw { $metadata: { httpStatusCode: 412 } }
      objects.set(key, {
        bytes: Buffer.from(command.input.Body as Uint8Array),
        etag: `"etag-${++serial}"`,
      })
      return {}
    },
  }
  return {
    objects,
    store: new R2ConditionalObjectStore(client as unknown as Pick<S3Client, "send">, bucket),
  }
}

async function fixture(recordCount = 2, useV2 = false) {
  const root = await mkdtemp(join(tmpdir(), "seal-publisher-"))
  roots.push(root)
  const sourceSchema = z.object({ value: z.string() }).strict()
  const original = new SignedJournal(join(root, "original"), originalKey, (value) =>
    sourceSchema.parse(value)
  )
  const wrapper = new SignedJournal(join(root, "wrapper"), wrapperKey, (value) =>
    authorityEventSchema(z.unknown()).parse(value)
  )
  const remote = objectStore("journal-evidence")
  let currentHead: AuthorityHead | null = null
  let currentSeal: JournalSeal | null = null
  const records = new Map<number, JournalRecord<unknown>>()
  let loseSealAck = false
  const mirror = {
    readHead: async () => currentHead,
    readHeadBounded: async () => currentHead,
    readRecord: async (sequence: number) => records.get(sequence) ?? null,
    readRecordBounded: async (sequence: number) => records.get(sequence) ?? null,
    compareAndAppend: async (
      previous: AuthorityHead | null,
      head: AuthorityHead,
      record: JournalRecord<unknown>
    ) => {
      if (
        canonicalJson(currentHead) === canonicalJson(head) &&
        canonicalJson(records.get(record.sequence)) === canonicalJson(record)
      )
        return "written" as const
      if (canonicalJson(currentHead) !== canonicalJson(previous)) return "conflict" as const
      currentHead = head
      records.set(record.sequence, structuredClone(record))
      return "written" as const
    },
    readSealHeadBounded: async () => currentSeal,
    readSealBounded: async (revision: number) =>
      currentSeal?.revision === revision ? currentSeal : null,
    compareAndAppendSeal: async (
      previous: JournalSeal | null,
      next: JournalSeal,
      head: AuthorityHead
    ) => {
      if (canonicalJson(head) !== canonicalJson(currentHead)) return "conflict" as const
      if (canonicalJson(currentSeal) !== canonicalJson(next)) {
        if (canonicalJson(currentSeal) !== canonicalJson(previous)) return "conflict" as const
        currentSeal = next
      }
      if (loseSealAck) {
        loseSealAck = false
        throw new Error("seal commit reply lost")
      }
      return "written" as const
    },
  }
  const independent = new IndependentAuthorityJournal({
    local: wrapper,
    store: remote.store,
    mirror,
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
    signingSecret: wrapperKey,
    payloadSchema: z.unknown(),
    authorize: async () => true,
  })
  for (let index = 1; index <= recordCount; index += 1) {
    const record = await original.append({ value: `record-${index}` })
    await independent.appendIntent({
      epochId: "epoch-1",
      operationId: "operation-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      attemptId: "attempt-1",
      eventId: `source-${index}`,
      payload: record,
    })
  }
  const control = objectStore("control-evidence")
  const evidence = new StoredJournalSealEvidenceReader({
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
    store: remote.store,
    mirror,
    headSigningSecret: wrapperKey,
    sealSigningSecret: sealKey,
    originalSigningSecret: originalKey,
    wrapperSigningSecret: wrapperKey,
    validateOriginal: (value) => sourceSchema.parse(value),
  })
  const genesis = {
    schema: "lyrashield-root-control-seal-genesis/1",
    productRevision: "a".repeat(40),
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
  }
  const genesisBytes = Buffer.from(
    canonicalJson({
      ...genesis,
      signature: createHmac("sha256", sealKey).update(canonicalJson(genesis)).digest("hex"),
    })
  )
  await control.store.put("journal-seal-pins/epoch-1/supervisor-1/current", genesisBytes, {
    ifNoneMatch: true,
  })
  const options = {
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
    epoch: 1,
    productRevision: "a".repeat(40),
    checkpointSecret: sealKey,
    checkpointKeyHash: createHash("sha256").update(sealKey).digest("hex"),
    controlAccountId: "a".repeat(32),
    controlBucket: "control-evidence",
    genesisRecordHash: createHash("sha256").update(genesisBytes).digest("hex"),
  }
  const gate = {
    withAuthorizedStream: async <T>(
      _stream: unknown,
      fn: (proof: {
        policy: typeof options & {
          authorityDigest: string
          runtimePolicyDigest: string
          databaseRole: "lyrashield_journal_seal_control"
        }
        assertActive(): void
      }) => Promise<T>
    ) =>
      fn({
        policy: {
          ...options,
          authorityDigest: `sha256:${"a".repeat(64)}`,
          runtimePolicyDigest: `sha256:${"b".repeat(64)}`,
          databaseRole: "lyrashield_journal_seal_control" as const,
        },
        assertActive: () => undefined,
      }),
  }
  const pin = new ProtectedJournalSealPinStore(control.store, evidence, gate, options)
  const publisher = new JournalSealPublisher({
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
    original,
    wrapper,
    independent,
    store: remote.store,
    mirror,
    pin,
    headSigningSecret: wrapperKey,
    sealSigningSecret: sealKey,
    originalSigningSecret: originalKey,
    wrapperSigningSecret: wrapperKey,
    validateOriginal: (value: unknown) => sourceSchema.parse(value),
    ...(useV2
      ? {
          recoverySnapshot: {
            create: async (input: {
              epochId: string
              supervisorInstanceId: string
              lastSequence: number
              originalLastHash: string
              wrapperLastHash: string
            }) => ({
              bytes: Buffer.from(
                canonicalJson({
                  schema: "lyrashield-supervisor-recovery-snapshot/1",
                  epochId: input.epochId,
                  supervisorInstanceId: input.supervisorInstanceId,
                  sequence: input.lastSequence,
                  originalHash: input.originalLastHash,
                  wrapperHash: input.wrapperLastHash,
                  attempts: [],
                  commands: [],
                })
              ),
              sequence: input.lastSequence,
              originalLastHash: input.originalLastHash,
              wrapperLastHash: input.wrapperLastHash,
            }),
          },
        }
      : {}),
    fence: { run: async (fn) => fn(() => undefined) },
  })
  return {
    original,
    wrapper,
    independent,
    root,
    publisher,
    pin,
    remote,
    control,
    mirror,
    evidence,
    loseNextSealAck: () => {
      loseSealAck = true
    },
  }
}

describe("journal seal publication", () => {
  it("rejects a pending original and a journal changed while recovering", async () => {
    const f = await fixture(2, true)
    const options = {
      stream: { epochId: "epoch-1", supervisorInstanceId: "supervisor-1" },
      pin: f.pin,
      evidence: f.evidence,
      originalPath: join(f.root, "original"),
      wrapperPath: join(f.root, "wrapper"),
      originalSigningSecret: originalKey,
      wrapperSigningSecret: wrapperKey,
      sealSigningSecret: sealKey,
      validateOriginal: (value: unknown) => z.object({ value: z.string() }).strict().parse(value),
      authorize: async () => true,
    }
    try {
      await f.publisher.publishNext()
      await expect(
        withVerifiedJournalContinuation(options, async () => {
          await f.original.append({ value: "pending" })
          return true
        })
      ).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
      await expect(
        withVerifiedJournalContinuation(options, async () => true)
      ).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
  it("rejects a reader or signing keys not bound to the protected pin", async () => {
    const f = await fixture(2, true)
    const validateOriginal = (value: unknown) =>
      z.object({ value: z.string() }).strict().parse(value)
    const options = {
      stream: { epochId: "epoch-1", supervisorInstanceId: "supervisor-1" },
      pin: f.pin,
      evidence: f.evidence,
      originalPath: join(f.root, "original"),
      wrapperPath: join(f.root, "wrapper"),
      originalSigningSecret: originalKey,
      wrapperSigningSecret: wrapperKey,
      sealSigningSecret: sealKey,
      validateOriginal,
      authorize: async () => true,
    }
    try {
      await f.publisher.publishNext()
      await expect(
        withVerifiedJournalContinuation(
          { ...options, originalSigningSecret: "x".repeat(48) },
          async () => true
        )
      ).rejects.toThrow(/keys/)
      const unrelated = new StoredJournalSealEvidenceReader({
        ...options.stream,
        store: f.remote.store,
        mirror: f.mirror,
        headSigningSecret: wrapperKey,
        sealSigningSecret: sealKey,
        originalSigningSecret: originalKey,
        wrapperSigningSecret: wrapperKey,
        validateOriginal,
      })
      await expect(
        withVerifiedJournalContinuation({ ...options, evidence: unrelated }, async () => true)
      ).rejects.toThrow()
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
  it("verifies a newer original and independently mirrored tail under the pin gate", async () => {
    const f = await fixture(2, true)
    try {
      const seal = await f.publisher.publishNext()
      const next = await f.original.append({ value: "record-3" })
      await f.independent.appendIntent({
        epochId: "epoch-1",
        operationId: "operation-1",
        scanId: "scan-1",
        workspaceId: "workspace-1",
        attemptId: "attempt-1",
        eventId: "source-3",
        payload: next,
      })
      const records = await withVerifiedJournalContinuation(
        {
          stream: { epochId: "epoch-1", supervisorInstanceId: "supervisor-1" },
          pin: f.pin,
          evidence: f.evidence,
          originalPath: join(f.root, "original"),
          wrapperPath: join(f.root, "wrapper"),
          originalSigningSecret: originalKey,
          wrapperSigningSecret: wrapperKey,
          sealSigningSecret: sealKey,
          validateOriginal: (value) => z.object({ value: z.string() }).strict().parse(value),
          authorize: async () => true,
        },
        async ({ originalTail, sealed, sealedRecords }) => {
          expect(sealed.sealHash).toBe(seal.sealHash)
          expect(sealedRecords.originals.map((record) => record.sequence)).toEqual([1, 2])
          return originalTail.records
        }
      )
      expect(records).toEqual([next])
      f.remote.objects.delete("epochs/epoch-1/supervisors/supervisor-1/acknowledgements/3")
      await expect(
        withVerifiedJournalContinuation(
          {
            stream: { epochId: "epoch-1", supervisorInstanceId: "supervisor-1" },
            pin: f.pin,
            evidence: f.evidence,
            originalPath: join(f.root, "original"),
            wrapperPath: join(f.root, "wrapper"),
            originalSigningSecret: originalKey,
            wrapperSigningSecret: wrapperKey,
            sealSigningSecret: sealKey,
            validateOriginal: (value) => z.object({ value: z.string() }).strict().parse(value),
            authorize: async () => true,
          },
          async () => true
        )
      ).rejects.toThrow(/acknowledgement|unavailable/)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
  it("publishes a v2 seal with exact local tail positions and committed recovery snapshot", async () => {
    const f = await fixture(2, true)
    try {
      const original = await f.original.readRawRange(0, { maxBytes: 8192, maxRecords: 2 })
      const wrapper = await f.wrapper.readRawRange(0, { maxBytes: 8192, maxRecords: 2 })
      const seal = await f.publisher.publishNext()
      expect(seal.schema).toBe("lyrashield-journal-seal/2")
      if (seal.schema !== "lyrashield-journal-seal/2") throw new Error("expected v2 seal")
      expect([seal.originalSegmentStartSequence, seal.originalByteOffset]).toEqual([
        original.endPosition!.segmentStartSequence,
        original.endPosition!.byteOffsetAfterLastSealedRecord,
      ])
      expect([seal.wrapperSegmentStartSequence, seal.wrapperByteOffset]).toEqual([
        wrapper.endPosition!.segmentStartSequence,
        wrapper.endPosition!.byteOffsetAfterLastSealedRecord,
      ])
      expect(
        f.remote.objects.has(
          `epochs/epoch-1/supervisors/supervisor-1/recovery-snapshots/${seal.sealHash}`
        )
      ).toBe(true)
      expect(
        await f.pin.withBoundedContinuation(
          { epochId: "epoch-1", supervisorInstanceId: "supervisor-1" },
          async ({ seal }) => seal
        )
      ).toEqual(seal)
      f.remote.objects.delete(
        `epochs/epoch-1/supervisors/supervisor-1/recovery-snapshots/${seal.sealHash}`
      )
      await expect(
        f.pin.withBoundedContinuation(
          { epochId: "epoch-1", supervisorInstanceId: "supervisor-1" },
          async ({ seal }) => seal
        )
      ).rejects.toThrow()
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
  it("seals an existing history over 32 records in contiguous protected prefixes", async () => {
    const f = await fixture(33)
    try {
      const first = await f.publisher.publishNext()
      expect([first.firstSequence, first.lastSequence, first.revision]).toEqual([1, 32, 1])
      const second = await f.publisher.publishNext()
      expect([second.firstSequence, second.lastSequence, second.revision]).toEqual([33, 33, 2])
      expect(second.previousSealHash).toBe(first.sealHash)
      expect(second.originalPreviousHash).toBe(first.originalLastHash)
      expect(second.wrapperPreviousHash).toBe(first.wrapperLastHash)
      expect(
        (await f.pin.readCurrent({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" }))
          ?.sealHash
      ).toBe(second.sealHash)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
  it("publishes exact signed archives, observed mirror ACK and protected pin", async () => {
    const f = await fixture()
    try {
      const seal = await f.publisher.publishNext()
      expect(seal.lastSequence).toBe(2)
      expect(
        (await f.pin.readCurrent({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" }))
          ?.sealHash
      ).toBe(seal.sealHash)
      expect(
        [...f.remote.objects.keys()].some((key) =>
          key.endsWith(`/seal-segments/${seal.sealHash}/original`)
        )
      ).toBe(true)
      expect(
        [...f.remote.objects.keys()].some((key) =>
          key.endsWith(`/seal-acknowledgements/${seal.sealHash}`)
        )
      ).toBe(true)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
  it("does not manufacture an observed mirror ACK after a lost commit reply", async () => {
    const f = await fixture()
    try {
      f.loseNextSealAck()
      await expect(f.publisher.publishNext()).rejects.toThrow("seal commit reply lost")
      expect(
        [...f.remote.objects.keys()].some((key) => key.includes("/seal-acknowledgements/"))
      ).toBe(false)
      expect(
        await f.pin.readCurrent({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
      ).toBeNull()
      expect((await f.publisher.publishNext()).lastSequence).toBe(2)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })

  it("replays the exact completed seal after a lost protected pin response", async () => {
    const f = await fixture()
    try {
      const original = f.pin.compareAndAdvance.bind(f.pin)
      vi.spyOn(f.pin, "compareAndAdvance").mockImplementationOnce(async (input) => {
        await original(input)
        throw new Error("protected pin reply lost")
      })
      let sealHash = ""
      try {
        await f.publisher.publishNext()
        throw new Error("publication unexpectedly returned")
      } catch (error) {
        sealHash = Reflect.get(error as object, "sealHash") as string
      }
      expect(sealHash).toMatch(/^[a-f0-9]{64}$/)
      expect((await f.publisher.publishNext({ resumeSealHash: sealHash })).sealHash).toBe(sealHash)
      const originalArchive = [...f.remote.objects.keys()].find((key) =>
        key.endsWith(`/seal-segments/${sealHash}/original`)
      )!
      f.remote.objects.delete(originalArchive)
      await expect(f.publisher.publishNext({ resumeSealHash: sealHash })).rejects.toThrow(
        /archive|unavailable/
      )
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })

  it("reconfirms a committed control CAS whose response was lost under a fresh gate", async () => {
    const f = await fixture()
    try {
      const original = f.control.store.put.bind(f.control.store)
      let lost = false
      vi.spyOn(f.control.store, "put").mockImplementation(async (key, bytes, condition) => {
        const result = await original(key, bytes, condition)
        if (!lost && key.endsWith("/current") && "ifMatch" in condition) {
          lost = true
          throw new Error("control CAS response lost")
        }
        return result
      })
      let sealHash = ""
      try {
        await f.publisher.publishNext()
        throw new Error("publication unexpectedly returned")
      } catch (error) {
        sealHash = Reflect.get(error as object, "sealHash") as string
      }
      expect(sealHash).toMatch(/^[a-f0-9]{64}$/)
      await expect(
        f.pin.readCurrent({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
      ).rejects.toThrow()
      expect((await f.publisher.publishNext({ resumeSealHash: sealHash })).sealHash).toBe(sealHash)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })

  it("replays the exact seal after the object-head response is lost", async () => {
    const f = await fixture()
    try {
      const original = f.remote.store.put.bind(f.remote.store)
      let lost = false
      vi.spyOn(f.remote.store, "put").mockImplementation(async (key, bytes, condition) => {
        const result = await original(key, bytes, condition)
        if (!lost && key.endsWith("/seal-head")) {
          lost = true
          throw new Error("seal head reply lost")
        }
        return result
      })
      let sealHash = ""
      try {
        await f.publisher.publishNext()
        throw new Error("publication unexpectedly returned")
      } catch (error) {
        sealHash = Reflect.get(error as object, "sealHash") as string
      }
      expect(sealHash).toMatch(/^[a-f0-9]{64}$/)
      expect(
        await f.pin.readCurrent({ epochId: "epoch-1", supervisorInstanceId: "supervisor-1" })
      ).toBeNull()
      expect((await f.publisher.publishNext({ resumeSealHash: sealHash })).sealHash).toBe(sealHash)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })

  it("does not publish when a confirmed journal acknowledgement is missing", async () => {
    const f = await fixture()
    try {
      f.remote.objects.delete("epochs/epoch-1/supervisors/supervisor-1/acknowledgements/2")
      await expect(f.publisher.publishNext()).rejects.toThrow()
      expect([...f.remote.objects.keys()].some((key) => key.includes("/seals/"))).toBe(false)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })

  it("treats an incorrect replay hash only as a selector and performs no publication", async () => {
    const f = await fixture()
    try {
      const keys = [...f.remote.objects.keys()].sort()
      await expect(f.publisher.publishNext({ resumeSealHash: "a".repeat(64) })).rejects.toThrow(
        /selector/
      )
      expect([...f.remote.objects.keys()].sort()).toEqual(keys)
    } finally {
      await f.original.close()
      await f.wrapper.close()
    }
  })
})
