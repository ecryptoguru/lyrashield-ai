import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  sha256Hex,
  verifyJournalRecord,
  type SupervisorJournalCursor,
} from "@lyrashield/runtime-control"
import { supervisorJournalEventSchema } from "./journal-events"
import {
  CHECKPOINT_LIMITS,
  checkpointBodySchema,
  buildCheckpointCandidate,
  checkpointSign,
  verifyCheckpoint,
  type SupervisorCheckpoint,
} from "./checkpoint-format"
import { SupervisorCheckpointReader } from "./checkpoint-reader"
import {
  checkpointBinding,
  checkpointCursor,
  checkpointKeys,
  checkpointPrepare,
  checkpointStream,
  createCheckpointFixture,
  fixtureHead,
  recoverySelector,
} from "./checkpoint-test-fixtures"
import type {
  CheckpointStreamAuthority,
  SupervisorCheckpointReaderOptions,
} from "./checkpoint-ports"

const fixtures: Awaited<ReturnType<typeof createCheckpointFixture>>[] = []
async function fixture(count = 66) {
  const value = await createCheckpointFixture(count)
  fixtures.push(value)
  return value
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    await f.close()
    await rm(f.root, { recursive: true, force: true })
  }
})
function signedCheckpoint(
  value: SupervisorCheckpoint,
  changes: Partial<SupervisorCheckpoint>
): SupervisorCheckpoint {
  const body = checkpointBodySchema.parse(
    Object.fromEntries(
      Object.entries({ ...value, ...changes }).filter(
        ([key]) => !["checkpointHash", "signature"].includes(key)
      )
    )
  )
  const checkpointHash = sha256Hex(canonicalJson(body))
  return {
    ...body,
    checkpointHash,
    signature: checkpointSign(checkpointKeys.checkpointSigningSecret, { ...body, checkpointHash }),
  }
}

describe("closed bounded supervisor checkpoint foundation", () => {
  it("traverses every original beyond64 across bounded pages without changing either signed stream", async () => {
    const f = await fixture(130)
    const originals = await f.nativeOriginal.load(),
      wrapped = await f.nativeWrapper.load()
    const before = await Promise.all([
      readFile(join(f.root, "original.jsonl")),
      readFile(join(f.root, "wrapper.jsonl")),
    ])
    const originalLoad = vi.spyOn(f.nativeOriginal, "load"),
      wrapperLoad = vi.spyOn(f.nativeWrapper, "load")
    let cursor: SupervisorJournalCursor = checkpointCursor
    const all = []
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await f.reader.readCursor(cursor)
      expect(Buffer.byteLength(canonicalJson(page))).toBeLessThanOrEqual(256 * 1024)
      expect(page.records.length).toBeLessThanOrEqual(cursor.limit)
      all.push(...page.records)
      cursor = page.nextCursor
      if (!page.hasMore) break
      expect(page.records.length).toBeGreaterThan(0)
    }
    expect(all).toEqual(wrapped)
    expect(all.map((record) => record.payload.payload)).toEqual(originals)
    expect(cursor.afterSequence).toBe(130)
    expect(cursor.afterHash).toBe(originals.at(-1)!.hash)
    expect(originalLoad).not.toHaveBeenCalled()
    expect(wrapperLoad).not.toHaveBeenCalled()
    expect((await f.reader.readCursor(cursor)).records).toEqual([])
    expect(
      await Promise.all([
        readFile(join(f.root, "original.jsonl")),
        readFile(join(f.root, "wrapper.jsonl")),
      ])
    ).toEqual(before)
    expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    await expect(f.journal.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "READ_LIMIT",
    })
  })

  it("has fixed per-page IO independent of total history and requested one-record limit", async () => {
    const f = await fixture(130)
    const originalLoad = vi.spyOn(f.nativeOriginal, "load"),
      wrapperLoad = vi.spyOn(f.nativeWrapper, "load")
    const writes = [f.store.writes, f.mirror.writes]
    const page = await f.reader.readCursor({ ...checkpointCursor, limit: 1 })
    expect(page.records).toHaveLength(1)
    expect(originalLoad).not.toHaveBeenCalled()
    expect(wrapperLoad).not.toHaveBeenCalled()
    expect(f.calls).toMatchObject({
      localHeads: 2,
      localIndex: 2,
      localSegments: 2,
      stream: 2,
      checkpoint: 4,
      authorize: 66,
    })
    expect(f.calls.localBytes).toBeLessThanOrEqual(2 * CHECKPOINT_LIMITS.segmentBytes)
    expect(f.store.reads.filter((read) => read.key.includes("/records/"))).toHaveLength(64)
    expect(f.store.reads.filter((read) => read.key.endsWith("/head"))).toHaveLength(2)
    expect(f.store.reads.filter((read) => read.key.includes("/checkpoints/"))).toHaveLength(4)
    expect(f.store.reads.every((read) => read.bytes <= read.maxBytes)).toBe(true)
    expect(f.mirror.recordReads).toHaveLength(64)
    expect(f.mirror.headReads).toBe(2)
    expect(f.mirror.checkpointReads).toBe(4)
    expect([f.store.writes, f.mirror.writes]).toEqual(writes)
  })

  it.each([
    { afterSequence: "0" },
    { limit: 0 },
    { limit: 101 },
    { epochId: "foreign-epoch" },
    { supervisorInstanceId: "foreign-supervisor" },
    { afterSequence: 1000 },
    { afterHash: "f".repeat(64) },
  ])("rejects invalid or adversarial cursor %j without writes", async (changes) => {
    const f = await fixture()
    const writes = [f.store.writes, f.mirror.writes]
    await expect(f.reader.readCursor({ ...checkpointCursor, ...changes })).rejects.toBeInstanceOf(
      Error
    )
    expect([f.store.writes, f.mirror.writes]).toEqual(writes)
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })

  it("authenticates empty genesis before and after read and rejects revoked genesis", async () => {
    const f = await fixture(0)
    expect((await f.reader.readCursor(checkpointCursor)).records).toEqual([])
    expect(f.calls.stream).toBe(2)
    f.authorityState.active = false
    await expect(f.freshReader().readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
  })

  it.each(["stream", "record", "unavailable", "identity"])(
    "fails closed for %s authority",
    async (failure) => {
      const f = await fixture()
      if (failure === "stream") f.authorityState.active = false
      if (failure === "record") f.authorityState.records = false
      if (failure === "unavailable") f.authorityState.unavailable = true
      if (failure === "identity") f.options.trust.confirmCheckpoint = async () => null
      await expect(f.reader.readCursor(checkpointCursor)).rejects.toBeInstanceOf(Error)
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
      expect(f.store.writes + f.mirror.writes).toBe(0)
    }
  )

  it("requires authenticated identity rather than a synthetic successful boolean", async () => {
    const f = await fixture()
    f.options.trust.confirmCheckpoint = (async () =>
      true) as unknown as SupervisorCheckpointReaderOptions["trust"]["confirmCheckpoint"]
    await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "CHECKPOINT_CONFLICT",
    })
  })

  it.each(["local", "R2", "database", "index"])(
    "rejects tampered %s checkpoint evidence",
    async (location) => {
      const f = await fixture()
      const first = f.accepted.get(f.index.get(1)!)!
      if (location === "local") await writeFile(join(f.root, `${first.checkpointHash}.json`), "[]")
      if (location === "R2") {
        const key =
          f.store.reads[0]?.key ??
          `epochs/${checkpointStream.epochId}/supervisors/${checkpointStream.supervisorInstanceId}/records/1`
        f.store.objects.set(key, { bytes: Buffer.from("tampered"), etag: '"tampered"' })
      }
      if (location === "database")
        f.mirror.records.set(1, { ...f.acceptedRecords.get(1)!, hash: "f".repeat(64) })
      if (location === "index") f.options.local.readCheckpointAt = async () => f.heads.checkpoint
      await expect(f.reader.readCursor(checkpointCursor)).rejects.toBeInstanceOf(Error)
      expect(f.effects.create + f.effects.start).toBe(0)
    }
  )

  it.each(["signature", "foreign", "predecessor", "recordsHash", "range"])(
    "rejects adversarial checkpoint %s",
    async (change) => {
      const f = await fixture()
      const first = f.accepted.get(f.index.get(1)!)!
      const changed =
        change === "signature"
          ? { ...first, signature: "f".repeat(64) }
          : signedCheckpoint(
              first,
              change === "foreign"
                ? { epochId: "foreign-epoch" }
                : change === "predecessor"
                  ? { originalPreviousHash: "f".repeat(64) }
                  : change === "range"
                    ? { firstSequence: 2 }
                    : { recordsHash: "f".repeat(64) }
            )
      f.options.local.readCheckpointAt = async () => changed
      await expect(f.reader.readCursor(checkpointCursor)).rejects.toBeInstanceOf(Error)
      expect(f.store.writes + f.mirror.writes).toBe(0)
    }
  )

  it("rejects local segment bytes changed after initial validation", async () => {
    const f = await fixture()
    const first = f.accepted.get(f.index.get(1)!)!
    let seen = false
    f.store.beforeRead = async (key) => {
      if (key.endsWith("/records/1") && !seen) {
        seen = true
        await writeFile(join(f.root, `${first.checkpointHash}.json`), "[]")
      }
    }
    await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "CHECKPOINT_CONFLICT",
    })
    expect(f.effects.create + f.effects.start).toBe(0)
  })

  it.each(["R2", "database", "identity", "revision"])(
    "rejects %s checkpoint proof changed during record readback",
    async (changed) => {
      const f = await fixture()
      const first = f.accepted.get(f.index.get(1)!)!
      let seen = false
      f.store.beforeRead = async (key) => {
        if (!key.endsWith("/records/1") || seen) return
        seen = true
        if (changed === "revision") f.authorityState.current.revision++
        if (changed === "identity") f.options.trust.confirmCheckpoint = async () => null
        if (changed === "database")
          f.mirror.checkpoints.set(first.checkpointHash, { ...first, signature: "f".repeat(64) })
        if (changed === "R2")
          f.store.objects.set(
            `epochs/${checkpointStream.epochId}/supervisors/${checkpointStream.supervisorInstanceId}/checkpoints/${first.checkpointHash}`,
            {
              bytes: Buffer.from(canonicalJson({ ...first, signature: "f".repeat(64) })),
              etag: '"changed-checkpoint"',
            }
          )
      }
      await expect(f.reader.readCursor(checkpointCursor)).rejects.toBeInstanceOf(Error)
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    }
  )

  it.each(["local-head", "R2-checkpoint", "database-checkpoint", "segment"])(
    "does not repair missing %s publication during reads or restart",
    async (missing) => {
      const f = await fixture()
      const nativeBytes = await readFile(join(f.root, "original.jsonl"), "utf8")
      const checkpoint = f.heads.checkpoint!
      const readSegment = f.options.local.readSegment
      if (missing === "local-head") f.heads.checkpoint = null
      if (missing === "R2-checkpoint")
        f.store.objects.delete(
          `epochs/${checkpointStream.epochId}/supervisors/${checkpointStream.supervisorInstanceId}/checkpoints/${checkpoint.checkpointHash}`
        )
      if (missing === "database-checkpoint") f.mirror.checkpoints.delete(checkpoint.checkpointHash)
      if (missing === "segment") f.options.local.readSegment = async () => null
      const writes = [f.store.writes, f.mirror.writes]
      await expect(f.freshReader().readCursor(checkpointCursor)).rejects.toMatchObject({
        code: "CHECKPOINT_REQUIRED",
      })
      expect([f.store.writes, f.mirror.writes]).toEqual(writes)
      expect(await readFile(join(f.root, "original.jsonl"), "utf8")).toBe(nativeBytes)
      f.options.local.readSegment = readSegment
      // Explicit synthetic publication, never a side effect of the read endpoint.
      await f.publish()
      expect((await f.freshReader().readCursor(checkpointCursor)).records.length).toBeGreaterThan(0)
      expect(await readFile(join(f.root, "original.jsonl"), "utf8")).toBe(nativeBytes)
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    }
  )

  it("detects stream revocation after the page's record checks", async () => {
    const f = await fixture()
    let streamReads = 0
    const read = f.options.trust.readStream
    f.options.trust.readStream = async (stream) => {
      if (++streamReads === 2) f.authorityState.active = false
      return read(stream)
    }
    await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
  })

  it("does not hold STOP behind a delayed bounded checkpoint read", async () => {
    const f = await fixture()
    await f.service.initialize()
    const attempt = await f.service.getAttempt(checkpointBinding.attemptId)
    let entered!: () => void, release!: () => void
    const reading = new Promise<void>((resolve) => {
        entered = resolve
      }),
      held = new Promise<void>((resolve) => {
        release = resolve
      })
    f.store.beforeRead = async (key) => {
      if (key.endsWith("/records/1")) {
        entered()
        await held
      }
    }
    const pending = f.reader.readCursor(checkpointCursor)
    void pending.catch(() => undefined)
    await reading
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const stopping = f.service.execute({
        type: "STOP",
        commandId: "stop-checkpoint-reader",
        attemptId: checkpointBinding.attemptId,
        expectedReceiptHash: attempt.receipt.hash,
      })
      const stopped = await Promise.race([
        stopping,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("STOP waited behind checkpoint read")), 5000)
        }),
      ])
      expect(stopped.status).toBe("NEVER_DISPATCHED")
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    } finally {
      if (deadline) clearTimeout(deadline)
      release()
    }
    await expect(pending).rejects.toBeInstanceOf(Error)
  })

  it("keeps pending original identity unresolved, then explicitly recovers before new checkpoint publication", async () => {
    const f = await fixture()
    const before = await readFile(join(f.root, "original.jsonl"), "utf8")
    f.store.loseOnRecord = true
    await expect(
      f.journal.append({
        type: "attempt_status",
        supervisorInstanceId: checkpointStream.supervisorInstanceId,
        observedAt: "2026-11-11T10:00:00.000Z",
        commandId: checkpointPrepare.commandId,
        attemptId: checkpointBinding.attemptId,
        status: "UNKNOWN",
      })
    ).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const pendingBytes = await readFile(join(f.root, "original.jsonl"), "utf8")
    expect(pendingBytes.startsWith(before)).toBe(true)
    expect(pendingBytes.trim().split("\n")).toHaveLength(67)
    await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    const recovered = await f.service.recover(recoverySelector)
    expect(recovered.command.status).toBe("UNKNOWN")
    expect((await readFile(join(f.root, "original.jsonl"), "utf8")).startsWith(pendingBytes)).toBe(
      true
    )
    await expect(f.freshReader().readCursor(checkpointCursor)).rejects.toBeInstanceOf(Error)
    await f.publish()
    expect((await f.freshReader().readCursor(checkpointCursor)).records.length).toBeGreaterThan(0)
    expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
  })

  it("supports a fresh reader after native journals close without reloading their full history", async () => {
    const f = await fixture()
    await f.close()
    const originalLoad = vi.spyOn(f.nativeOriginal, "load"),
      wrapperLoad = vi.spyOn(f.nativeWrapper, "load")
    const page = await f.freshReader().readCursor({
      ...checkpointCursor,
      afterSequence: 64,
      afterHash: f.acceptedRecords.get(64)!.payload.payload.hash,
    })
    expect(page.records.map((record) => record.sequence)).toEqual([65, 66])
    expect(originalLoad).not.toHaveBeenCalled()
    expect(wrapperLoad).not.toHaveBeenCalled()
  })

  it("rejects an old fully signed restored snapshot against current persisted authority on restart", async () => {
    const f = await fixture()
    const old = f.acceptedRecords.get(32)!,
      checkpoint = f.accepted.get(f.index.get(32)!)!
    f.options.local.readHeads = async () => ({
      original: old.payload.payload,
      wrapper: old,
      checkpoint,
    })
    const key = `epochs/${checkpointStream.epochId}/supervisors/${checkpointStream.supervisorInstanceId}/head`
    f.store.objects.set(key, {
      bytes: Buffer.from(canonicalJson(fixtureHead(old))),
      etag: '"restored-old-head"',
    })
    f.mirror.head = fixtureHead(old)
    await expect(f.freshReader().readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
  })

  it("rejects in-process rollback even when unsafe synthetic authority returns an older signed state", async () => {
    const f = await fixture()
    await f.reader.readCursor(checkpointCursor)
    const old = f.acceptedRecords.get(32)!,
      checkpoint = f.accepted.get(f.index.get(32)!)!
    const authority: CheckpointStreamAuthority = {
      ...f.authorityState.current,
      revision: 1,
      confirmedSequence: 32,
      originalHash: old.payload.payload.hash,
      wrapperHash: old.hash,
      checkpointHash: checkpoint.checkpointHash,
    }
    f.options.trust.readStream = async () => authority
    await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "CHECKPOINT_ROLLBACK",
    })
  })

  it.each([0, 66])(
    "rejects a delayed older concurrent commit with %i original records",
    async (count) => {
      const f = await fixture(count)
      const prior = structuredClone(f.authorityState.current)
      let reachedOlder!: () => void, reachedNewer!: () => void
      let releaseOlder!: (value: CheckpointStreamAuthority) => void
      let releaseNewer!: (value: CheckpointStreamAuthority) => void
      const olderReached = new Promise<void>((resolve) => {
          reachedOlder = resolve
        }),
        newerReached = new Promise<void>((resolve) => {
          reachedNewer = resolve
        }),
        olderHeld = new Promise<CheckpointStreamAuthority>((resolve) => {
          releaseOlder = resolve
        }),
        newerHeld = new Promise<CheckpointStreamAuthority>((resolve) => {
          releaseNewer = resolve
        })
      const readStream = f.options.trust.readStream
      let calls = 0
      f.options.trust.readStream = async (stream) => {
        const call = ++calls
        const authority = await readStream(stream)
        if (call === 2) {
          reachedOlder()
          return olderHeld
        }
        if (call === 4) {
          reachedNewer()
          return newerHeld
        }
        return authority
      }
      const older = f.reader.readCursor(checkpointCursor)
      void older.catch(() => undefined)
      await olderReached
      if (count) {
        await f.journal.append({
          type: "attempt_status",
          supervisorInstanceId: checkpointStream.supervisorInstanceId,
          observedAt: "2026-11-11T10:00:01.000Z",
          commandId: checkpointPrepare.commandId,
          attemptId: checkpointBinding.attemptId,
          status: "UNKNOWN",
        })
        await f.publish()
      } else f.authorityState.current.revision++
      const current = structuredClone(f.authorityState.current)
      const newer = f.reader.readCursor(checkpointCursor)
      void newer.catch(() => undefined)
      await newerReached
      // Let the newer port promise attach its held-result continuation first.
      await Promise.resolve()
      // Queue both final authority validations before either read can commit its observation.
      releaseNewer(current)
      releaseOlder(prior)
      await expect(newer).resolves.toMatchObject({ hasMore: count > 0 })
      await expect(older).rejects.toMatchObject({ code: "CHECKPOINT_ROLLBACK" })
      f.options.trust.readStream = async () => prior
      await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
        code: "CHECKPOINT_ROLLBACK",
      })
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    }
  )

  it("verifies native original signatures without treating a single record as a chain proof", async () => {
    const f = await fixture()
    const original = f.acceptedRecords.get(32)!.payload.payload
    expect(
      verifyJournalRecord(original, checkpointKeys.originalSigningSecret, (value) =>
        supervisorJournalEventSchema.parse(value)
      )
    ).toEqual(original)
    expect(() =>
      verifyJournalRecord(
        { ...original, hash: "f".repeat(64) },
        checkpointKeys.originalSigningSecret,
        (value) => supervisorJournalEventSchema.parse(value)
      )
    ).toThrow()
    const second = [...f.acceptedRecords.values()].slice(32, 64)
    expect(() => buildCheckpointCandidate(second, null, checkpointStream, checkpointKeys)).toThrow()
    expect(() =>
      verifyCheckpoint(
        { ...f.heads.checkpoint!, schema: "lyrashield-supervisor-checkpoint/2" },
        checkpointKeys.checkpointSigningSecret
      )
    ).toThrow()
  })

  it("requires every mandatory protected bounded reader and trust port", async () => {
    const f = await fixture()
    expect(
      () =>
        new SupervisorCheckpointReader({
          ...f.options,
          trust: undefined,
        } as unknown as SupervisorCheckpointReaderOptions)
    ).toThrow()
    const first = f.accepted.get(f.index.get(1)!)!
    await writeFile(
      join(f.root, `${first.checkpointHash}.json`),
      Buffer.alloc(CHECKPOINT_LIMITS.segmentBytes + 1)
    )
    await expect(f.reader.readCursor(checkpointCursor)).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
  })

  it.each(["originalPreviousHash", "wrapperPreviousHash", "previousCheckpointHash"] as const)(
    "rejects a correctly signed non-genesis checkpoint with unavailable %s",
    async (field) => {
      const f = await fixture()
      const second = f.accepted.get(f.index.get(33)!)!
      const candidate = signedCheckpoint(second, { [field]: "0".repeat(64) })
      expect(() => verifyCheckpoint(candidate, checkpointKeys.checkpointSigningSecret)).toThrow(
        "checkpoint predecessor anchor is unavailable"
      )
      expect(await f.reader.readCursor(checkpointCursor)).toMatchObject({ hasMore: true })
    }
  )
})
