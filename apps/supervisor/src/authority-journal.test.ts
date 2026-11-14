import { explicitRecoveryJournal, fixtureAuthorityFence } from "./test-fixtures"
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SignedJournal,
  MAX_SUPERVISOR_JOURNAL_PAGE_BYTES,
  authorityEventSchema,
  canonicalJson,
  type AuthorityEvent,
  type AuthorityHead,
  type AuthorityMirror,
  type ConditionalObjectStore,
  type JournalRecord,
  type StoredObject,
} from "@lyrashield/runtime-control"
import { z } from "zod"
import {
  SupervisorAuthorityJournal,
  SUPERVISOR_CURSOR_HISTORY_LIMITS,
  createSupervisorAuthorityJournal,
  type SupervisorAuthorityJournalOptions,
} from "./authority-journal"
import {
  supervisorJournalEventSchema,
  supervisorJournalRecordSchema,
  type SupervisorJournalEvent,
} from "./journal-events"
import { createSupervisorHandler } from "./http"
import { SupervisorService, type SupervisorServiceOptions } from "./service"

const roots: string[] = []
const signingSecret = "a".repeat(48)
const supervisorInstanceId = "supervisor-journal-1"
const epochId = "epoch-journal-1"
const genesis = "0".repeat(64)
const binding = {
  attemptId: "attempt-journal-1",
  scanId: "scan-journal-1",
  workspaceId: "workspace-journal-1",
  operationId: "operation-journal-1",
  authorityEpochId: epochId,
  authorityRevision: 7,
  workerIdentity: "worker-journal-1",
  billingMode: "UNMETERED" as const,
  expiresAt: "2026-11-11T20:00:00.000Z",
}
const intent: SupervisorJournalEvent = {
  type: "command_intent",
  supervisorInstanceId,
  observedAt: "2026-11-11T10:00:00.000Z",
  command: {
    type: "PREPARE",
    commandId: "command-journal-1",
    attempt: binding,
    executors: [],
  },
}
const cursor = { epochId, supervisorInstanceId, afterSequence: 0, afterHash: genesis, limit: 10 }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class Store implements ConditionalObjectStore {
  objects = new Map<string, StoredObject>()
  writes = 0
  loseAcknowledgement = false
  hideRecords = false
  failRead = false
  onRecordWrite?: (bytes: Uint8Array) => Promise<void>

  async read(key: string): Promise<StoredObject | null> {
    if (this.failRead) throw new Error("storage unavailable")
    if (this.hideRecords && key.includes("/records/")) return null
    return this.objects.get(key) ?? null
  }

  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ) {
    const old = this.objects.get(key)
    if (
      ("ifNoneMatch" in condition && old) ||
      ("ifMatch" in condition && old?.etag !== condition.ifMatch)
    ) {
      return "conflict" as const
    }
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.writes}` })
    if (key.includes("/records/")) await this.onRecordWrite?.(bytes)
    if (this.loseAcknowledgement && key.includes("/records/")) {
      this.loseAcknowledgement = false
      throw new Error("storage applied write but lost acknowledgement")
    }
    return "written" as const
  }
}

class Mirror implements AuthorityMirror {
  head: AuthorityHead | null = null
  records = new Map<number, JournalRecord<unknown>>()
  writes = 0
  loseAcknowledgement = false

  async readHead() {
    return this.head
  }
  async readRecord(sequence: number) {
    return this.records.get(sequence) ?? null
  }
  async compareAndAppend(
    previous: AuthorityHead | null,
    head: AuthorityHead,
    record: JournalRecord<unknown>
  ) {
    if (same(head, this.head) && same(this.records.get(record.sequence) ?? null, record))
      return "written" as const
    if (!same(previous, this.head)) return "conflict" as const
    this.head = structuredClone(head)
    this.records.set(record.sequence, structuredClone(record))
    this.writes += 1
    if (this.loseAcknowledgement) {
      this.loseAcknowledgement = false
      throw new Error("database committed but lost acknowledgement")
    }
    return "written" as const
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function boundedPorts(fixture: Awaited<ReturnType<typeof setup>>) {
  const store = Object.assign(fixture.store, {
    readBounded: async (key: string, maxBytes: number) => {
      const object = await fixture.store.read(key)
      if (object && object.bytes.byteLength > maxBytes)
        throw new Error("bounded object exceeds limit")
      return object
    },
  })
  const mirror = Object.assign(fixture.mirror, {
    readHeadBounded: async (maxBytes: number) => {
      const head = await fixture.mirror.readHead()
      if (head && Buffer.byteLength(canonicalJson(head)) > maxBytes)
        throw new Error("bounded head exceeds limit")
      return head
    },
    readRecordBounded: async (sequence: number, maxBytes: number) => {
      const record = await fixture.mirror.readRecord(sequence)
      if (record && Buffer.byteLength(canonicalJson(record)) > maxBytes)
        throw new Error("bounded record exceeds limit")
      return record
    },
  })
  return { store, mirror }
}

async function setup(
  authorize: SupervisorAuthorityJournalOptions["authorize"] = async () => true,
  authorizeStream: SupervisorAuthorityJournalOptions["authorizeStream"] = async () => true,
  authorizeConfirmed?: SupervisorAuthorityJournalOptions["authorizeConfirmed"]
) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-authority-test-"))
  roots.push(root)
  const originalPath = join(root, "original.jsonl")
  const independentPath = join(root, "independent.jsonl")
  const original = new SignedJournal(originalPath, signingSecret, (value) =>
    supervisorJournalEventSchema.parse(value)
  )
  const local = new SignedJournal<AuthorityEvent<JournalRecord<SupervisorJournalEvent>>>(
    independentPath,
    signingSecret,
    (value) => authorityEventSchema(z.custom<JournalRecord<SupervisorJournalEvent>>()).parse(value)
  )
  const store = new Store()
  const mirror = new Mirror()
  const options = {
    original,
    local,
    store,
    mirror,
    epochId,
    supervisorInstanceId,
    signingSecret,
    authorize,
    ...(authorizeConfirmed ? { authorizeConfirmed } : {}),
    authorizeStream,
    authorizeRecovery: async () => true,
  }
  return {
    root,
    originalPath,
    independentPath,
    original,
    local,
    store,
    mirror,
    options,
    journal: new SupervisorAuthorityJournal(options),
  }
}

describe("supervisor independent journal adapter", () => {
  it("keeps installed historical authorization separate from expired live grants", async () => {
    let live = true
    const confirmed = vi.fn(async () => true)
    const f = await setup(
      async () => live,
      async () => true,
      confirmed
    )
    const original = await f.journal.append(intent)
    live = false
    expect(await f.journal.load()).toEqual([original])
    expect(confirmed).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ payload: original }) }),
      binding
    )
    await expect(
      f.journal.append({ ...intent, observedAt: "2026-11-11T10:00:01.000Z" })
    ).rejects.toThrow()
  })

  it("provides publication ports only while an independently authenticated snapshot is serialized", async () => {
    const f = await setup()
    await f.journal.append(intent)
    let outside!: () => Promise<unknown>
    const hashes = await f.journal.withPublication(async (ports) => {
      const confirmed = await ports.independent.loadConfirmed()
      const originals = await ports.original.load()
      outside = () => ports.independent.loadConfirmed()
      expect(ports.validateOriginal(originals[0]!.payload)).toEqual(intent)
      return { original: originals[0]!.hash, wrapper: confirmed[0]!.hash }
    })
    expect(hashes.original).toMatch(/^[a-f0-9]{64}$/)
    expect(hashes.wrapper).toMatch(/^[a-f0-9]{64}$/)
    await expect(outside()).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
  })

  it("does not return publication results when original history changes during the callback", async () => {
    const f = await setup()
    await f.journal.append(intent)
    await expect(
      f.journal.withPublication(async (ports) => {
        await ports.original.append({ ...intent, observedAt: "2026-11-11T10:00:01.000Z" })
        return "stale-publication"
      })
    ).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
  })

  it("uses exact persisted recovery authority to seal an expired pending original only with its UNKNOWN hold", async () => {
    let live = true
    const f = await setup(
      async () => live,
      async () => true,
      async () => true
    )
    f.mirror.loseAcknowledgement = true
    await expect(f.journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const original = (await f.original.load())[0]!
    live = false
    const recovered = await f.journal.recoverPending()
    expect(recovered.recoveredRecord).toEqual(original)
    expect(recovered.holdRecord.payload.type).toBe("command_recovery_hold")
    expect(recovered.holdRecord.payload).toMatchObject({
      recoveredHash: original.hash,
      commandId: "command-journal-1",
    })
    expect((await f.journal.load()).at(-1)!.payload.type).toBe("command_recovery_hold")
  })
  it("uses native bounded ranges beyond64 without checkpoint services or whole-history page reads", async () => {
    const f = await setup()
    const { store, mirror } = boundedPorts(f)
    await f.journal.append(intent)
    for (let index = 1; index < 130; index++) {
      await f.journal.append({
        ...intent,
        command: { ...intent.command, commandId: `prepare-${index}` },
      })
    }
    const originals = await f.original.load()
    const wrapped = await f.local.load()
    const originalLoad = vi.spyOn(f.original, "load")
    const wrapperLoad = vi.spyOn(f.local, "load")
    const originalRange = vi.spyOn(f.original, "readRange")
    const wrapperRange = vi.spyOn(f.local, "readRange")
    const objectReads = vi.spyOn(store, "readBounded")
    const mirrorReads = vi.spyOn(mirror, "readRecordBounded")
    const all = []
    let next = { ...cursor, limit: 7 }
    for (;;) {
      const page = await f.journal.readCursor(next)
      expect(Buffer.byteLength(canonicalJson(page))).toBeLessThanOrEqual(
        MAX_SUPERVISOR_JOURNAL_PAGE_BYTES
      )
      all.push(...page.records)
      next = page.nextCursor
      if (!page.hasMore) break
    }
    expect(all).toEqual(wrapped)
    expect(all.map((record) => record.payload.payload)).toEqual(originals)
    expect(next.afterSequence).toBe(130)
    expect(originalLoad).not.toHaveBeenCalled()
    expect(wrapperLoad).not.toHaveBeenCalled()
    originalRange.mockClear()
    wrapperRange.mockClear()
    objectReads.mockClear()
    mirrorReads.mockClear()
    expect((await f.journal.readCursor({ ...cursor, limit: 1 })).records).toEqual(
      wrapped.slice(0, 1)
    )
    expect(originalRange).toHaveBeenCalledTimes(2)
    expect(wrapperRange).toHaveBeenCalledTimes(2)
    expect(objectReads).toHaveBeenCalledTimes(10)
    expect(mirrorReads).toHaveBeenCalledTimes(4)
    await f.original.close()
    await f.local.close()
    const original = new SignedJournal(
      f.originalPath,
      signingSecret,
      supervisorJournalEventSchema.parse
    )
    const local = new SignedJournal(f.independentPath, signingSecret, (value) =>
      authorityEventSchema(z.custom<JournalRecord<SupervisorJournalEvent>>()).parse(value)
    )
    const restarted = new SupervisorAuthorityJournal({ ...f.options, original, local })
    expect(
      (await restarted.readCursor({ ...next, afterSequence: 123, afterHash: originals[122]!.hash }))
        .records
    ).toEqual(wrapped.slice(123))
    await original.close()
    await local.close()
  }, 120_000)

  it("holds bounded readback after lost acknowledgement and recovers only by exact replay", async () => {
    const f = await setup()
    boundedPorts(f)
    f.store.loseAcknowledgement = true
    await expect(f.journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const writes = f.store.writes
    await expect(f.journal.readCursor(cursor)).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    expect(f.store.writes).toBe(writes)
    const original = await f.journal.append(intent)
    expect((await f.journal.readCursor(cursor)).records[0]?.payload.payload).toEqual(original)
    expect(await f.original.load()).toHaveLength(1)
    await f.original.close()
    await f.local.close()
  }, 60_000)

  it("stops new IO when the page budget expires and keeps exact replay and STOP available", async () => {
    const f = await setup()
    const { store, mirror } = boundedPorts(f)
    await f.journal.append(intent)
    let now = 0
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now)
    const bounded = store.readBounded.bind(store)
    const read = vi.spyOn(store, "readBounded").mockImplementation(async (key, limit) => {
      const object = await bounded(key, limit)
      now = 5001
      return object
    })
    const mirrorRead = vi.spyOn(mirror, "readHeadBounded")
    try {
      const writes = [f.store.writes, f.mirror.writes]
      await expect(f.journal.readCursor(cursor)).rejects.toMatchObject({
        code: "AUTHORITY_UNKNOWN",
      })
      expect(read).toHaveBeenCalledTimes(1)
      expect(mirrorRead).not.toHaveBeenCalled()
      expect([f.store.writes, f.mirror.writes]).toEqual(writes)
    } finally {
      clock.mockRestore()
      read.mockRestore()
      mirrorRead.mockRestore()
    }
    await expect(f.journal.readCursor({ ...cursor, afterSequence: 2 })).rejects.toMatchObject({
      code: "CURSOR_CONFLICT",
    })
    await expect(
      f.journal.readCursor({ ...cursor, afterHash: "f".repeat(64) })
    ).rejects.toMatchObject({ code: "CURSOR_CONFLICT" })
    await f.journal.append({
      ...intent,
      command: {
        type: "STOP",
        commandId: "stop-after-timeout",
        attemptId: binding.attemptId,
        expectedReceiptHash: "b".repeat(64),
      },
    })
    expect((await f.journal.readCursor(cursor)).records).toHaveLength(2)
    await f.original.close()
    await f.local.close()
  }, 60_000)

  it("rejects a changed remote record and revoked stream through the bounded path", async () => {
    let active = true
    const f = await setup(
      async () => true,
      async () => active
    )
    boundedPorts(f)
    await f.journal.append(intent)
    active = false
    await expect(f.journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    const other = await setup()
    boundedPorts(other)
    await other.journal.append(intent)
    other.store.hideRecords = true
    await expect(other.journal.readCursor(cursor)).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    other.store.hideRecords = false
    const key = [...other.store.objects.keys()].find((key) => key.endsWith("/records/1"))!
    other.store.objects.set(key, { bytes: Buffer.from("tampered"), etag: "changed" })
    await expect(other.journal.readCursor(cursor)).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
    await f.original.close()
    await f.local.close()
    await other.original.close()
    await other.local.close()
  }, 60_000)
  it("requires persisted stream authority even for an empty genesis cursor", async () => {
    const eventAuthority = vi.fn(async () => false)
    const streamAuthority = vi.fn(async () => false)
    const { journal, original, store, mirror } = await setup(eventAuthority, streamAuthority)
    const load = vi.spyOn(original, "loadBounded")
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(streamAuthority).toHaveBeenCalledOnce()
    expect(streamAuthority).toHaveBeenCalledWith({ epochId, supervisorInstanceId })
    expect(eventAuthority).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(store.writes + mirror.writes).toBe(0)
  })

  it("checks stream authority after empty readback and holds revocation", async () => {
    let calls = 0
    const { journal } = await setup(
      async () => true,
      async () => ++calls < 3
    )
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(calls).toBe(3)
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(calls).toBe(3)
  })

  it.each([1, 3])(
    "keeps unavailable stream authority unresolved at read boundary %s",
    async (unavailableAt) => {
      let calls = 0
      const { journal, store, mirror } = await setup(
        async () => true,
        async () => {
          if (++calls === unavailableAt) throw new Error("persisted epoch read unavailable")
          return true
        }
      )
      await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
      expect(store.writes + mirror.writes).toBe(0)
      expect((await journal.readCursor(cursor)).records).toEqual([])
    }
  )

  it("uses constant local snapshot loads with measured bounded mirror I/O", async () => {
    const eventAuthority = vi.fn(async () => true)
    const streamAuthority = vi.fn(async () => true)
    const fixture = await setup(eventAuthority, streamAuthority)
    await fixture.journal.append(intent)
    for (let index = 1; index < 10; index += 1)
      await fixture.journal.append({
        type: "attempt_status",
        supervisorInstanceId,
        observedAt: intent.observedAt,
        attemptId: binding.attemptId,
        status: "UNKNOWN",
      })
    const originalLoad = vi.spyOn(fixture.original, "load")
    const boundedOriginal = vi.spyOn(fixture.original, "loadBounded")
    const boundedLocal = vi.spyOn(fixture.local, "loadBounded")
    const remote = vi.spyOn(fixture.store, "read")
    const database = vi.spyOn(fixture.mirror, "readRecord")
    eventAuthority.mockClear()
    streamAuthority.mockClear()
    const page = await fixture.journal.readCursor({ ...cursor, limit: 1 })
    expect(page.records).toHaveLength(1)
    expect(originalLoad).not.toHaveBeenCalled()
    expect(boundedOriginal).toHaveBeenCalledTimes(3)
    expect(boundedLocal).toHaveBeenCalledTimes(5)
    expect(remote.mock.calls.filter(([key]) => key.includes("/records/")).length).toBe(20)
    expect(database).toHaveBeenCalledTimes(20)
    expect(eventAuthority).toHaveBeenCalledTimes(10)
    expect(streamAuthority).toHaveBeenCalledTimes(3)
    remote.mockClear()
    database.mockClear()
    boundedOriginal.mockClear()
    boundedLocal.mockClear()
    eventAuthority.mockClear()
    const cold = new SupervisorAuthorityJournal(fixture.options)
    await cold.readCursor({ ...cursor, limit: 1 })
    expect(boundedOriginal).toHaveBeenCalledTimes(3)
    expect(boundedLocal).toHaveBeenCalledTimes(6)
    expect(remote.mock.calls.filter(([key]) => key.includes("/records/")).length).toBe(30)
    expect(database).toHaveBeenCalledTimes(30)
    expect(eventAuthority).toHaveBeenCalledTimes(10)
  })

  it("detects original history changes during persisted authority validation", async () => {
    let mutate = false
    let original!: SignedJournal<SupervisorJournalEvent>
    const fixture = await setup(async () => {
      if (mutate) {
        mutate = false
        await original.append({
          type: "attempt_status",
          supervisorInstanceId,
          observedAt: intent.observedAt,
          attemptId: binding.attemptId,
          status: "UNKNOWN",
        })
      }
      return true
    })
    original = fixture.original
    await fixture.journal.append(intent)
    mutate = true
    await expect(fixture.journal.readCursor(cursor)).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
    expect(await original.load()).toHaveLength(2)
    expect(fixture.mirror.writes).toBe(1)
  })

  it("rejects a cursor changed by a queued append without latching the writer", async () => {
    const fixture = await setup()
    let entered!: () => void
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.store.onRecordWrite = async (bytes) => {
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
      if (value.record.payload.payload.payload.type === "command_intent") {
        entered()
        await held
      }
    }
    const first = fixture.journal.append(intent)
    await writing
    const second = fixture.journal.append({
      type: "attempt_status",
      supervisorInstanceId,
      observedAt: intent.observedAt,
      attemptId: binding.attemptId,
      status: "UNKNOWN",
    })
    let captured!: () => void
    const capture = new Promise<void>((resolve) => {
      captured = resolve
    })
    const bounded = fixture.local.loadBounded.bind(fixture.local)
    vi.spyOn(fixture.local, "loadBounded").mockImplementation(async (limits) => {
      const records = await bounded(limits)
      captured()
      return records
    })
    const read = fixture.journal.readCursor(cursor)
    await capture
    release()
    await Promise.all([first, second])
    await expect(read).rejects.toMatchObject({ code: "CURSOR_CONFLICT" })
    expect((await fixture.journal.readCursor(cursor)).records).toHaveLength(2)
  })

  it("holds service retries and restart until exact trusted journal recovery occurs", async () => {
    const fixture = await setup()
    let clock = new Date("2026-11-11T10:00:00.000Z")
    const first = serviceFixture(explicitRecoveryJournal(fixture.journal), () => clock)
    fixture.store.loseAcknowledgement = true
    await expect(first.service.execute(first.prepare)).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    const pending = (await fixture.original.load())[0]!
    const bytes = await readFile(fixture.originalPath, "utf8")
    clock = new Date(clock.getTime() + 1)
    await expect(first.service.execute(first.prepare)).rejects.toMatchObject({
      code: "REPLAY_REQUIRED",
    })
    expect(first.effects.count).toBe(0)
    await fixture.original.close()
    await fixture.local.close()
    const restarted = createSupervisorAuthorityJournal({
      originalPath: fixture.originalPath,
      independentPath: fixture.independentPath,
      originalSigningSecret: signingSecret,
      signingSecret,
      epochId,
      supervisorInstanceId,
      store: fixture.store,
      mirror: fixture.mirror,
      authorize: async () => true,
      authorizeStream: async () => true,
      authorizeRecovery: async () => true,
    })
    try {
      const second = serviceFixture(explicitRecoveryJournal(restarted.journal), () => clock)
      await expect(second.service.initialize()).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
      await expect(second.service.execute(second.prepare)).rejects.toMatchObject({
        code: "REPLAY_REQUIRED",
      })
      expect(second.effects.count).toBe(0)
      expect(await readFile(fixture.originalPath, "utf8")).toBe(bytes)
      // Explicit trusted durability repair repeats the stored payload/observedAt
      // only. It never replays PREPARE, executor or provider effects.
      expect(await restarted.journal.append(pending.payload)).toEqual(pending)
      const reconciled = serviceFixture(restarted.journal, () => clock)
      expect((await reconciled.service.execute(reconciled.prepare)).status).toBe("UNKNOWN")
      expect(reconciled.effects.count).toBe(0)
      expect(await readFile(fixture.originalPath, "utf8")).toBe(bytes)
    } finally {
      await restarted.close()
    }
  })

  it("rejects an oversized cursor before serialization while STOP preserves all history", async () => {
    const { journal, store, original } = await setup()
    const { service, effects, prepare } = serviceFixture(journal)
    await service.execute(prepare)
    for (let index = 0; index < SUPERVISOR_CURSOR_HISTORY_LIMITS.maxRecords; index += 1) {
      await journal.append({
        type: "attempt_status",
        supervisorInstanceId,
        observedAt: intent.observedAt,
        attemptId: binding.attemptId,
        status: "UNKNOWN",
      })
    }
    const before = await original.load()
    expect(before.length).toBeGreaterThan(64)
    let entered!: () => void
    const stopping = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    store.onRecordWrite = async (bytes) => {
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
      if (
        value.record.payload.payload.payload.type === "command_intent" &&
        value.record.payload.payload.payload.command.type === "STOP"
      ) {
        entered()
        await held
      }
    }
    const attempt = await service.getAttempt(binding.attemptId)
    const stop = service.execute({
      type: "STOP",
      commandId: "stop-over-limit",
      attemptId: binding.attemptId,
      expectedReceiptHash: attempt!.receipt.hash,
    })
    await stopping
    const reads = vi.spyOn(store, "read")
    try {
      await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "READ_LIMIT" })
      expect(reads).not.toHaveBeenCalled()
    } finally {
      release()
    }
    expect((await stop).status).toBe("NEVER_DISPATCHED")
    expect(effects.count).toBe(0)
    const after = await journal.load()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.length).toBeGreaterThan(before.length)
  }, 30_000)

  it("preserves original canonical envelopes and cursor predecessors across restart", async () => {
    const { journal, original, originalPath, local, store, mirror, options } = await setup()
    const first = await journal.append(intent)
    const second = await journal.append({
      type: "attempt_status",
      supervisorInstanceId,
      observedAt: intent.observedAt,
      attemptId: binding.attemptId,
      status: "UNKNOWN",
    })
    const originalBytes = await readFile(originalPath, "utf8")
    expect(
      originalBytes
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    ).toEqual([first, second])
    expect((await local.load()).map((record) => record.payload.payload)).toEqual([first, second])
    expect(first).toEqual((await original.load())[0])
    const restarted = new SupervisorAuthorityJournal(options)
    const writes = [store.writes, mirror.writes]
    const page = await restarted.readCursor({ ...cursor, limit: 1 })
    expect(page.records[0]?.payload.payload).toEqual(first)
    expect(page.records[0]?.payload).toMatchObject({
      epochId,
      operationId: binding.operationId,
      scanId: binding.scanId,
      workspaceId: binding.workspaceId,
      attemptId: binding.attemptId,
      eventId: `supervisor:${first.hash}`,
    })
    expect(page.nextCursor).toMatchObject({ afterSequence: 1, afterHash: first.hash })
    expect(page.hasMore).toBe(true)
    const next = await restarted.readCursor(page.nextCursor)
    expect(next.records[0]?.payload.payload).toEqual(second)
    expect(next.hasMore).toBe(false)
    expect(await restarted.load()).toEqual([first, second])
    expect([store.writes, mirror.writes]).toEqual(writes)
    expect(await readFile(originalPath, "utf8")).toBe(originalBytes)
  })

  it.each(["store", "mirror"] as const)(
    "replays the same identity after a lost %s acknowledgement",
    async (target) => {
      const { journal, original, local, store, mirror } = await setup()
      const selected = target === "store" ? store : mirror
      selected.loseAcknowledgement = true
      await expect(journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
      const pending = (await original.load())[0]!
      const wrapped = (await local.load())[0]!
      const writes = [store.writes, mirror.writes]
      await expect(journal.load()).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
      await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
      expect([store.writes, mirror.writes]).toEqual(writes)
      await expect(
        journal.append({ ...intent, observedAt: "2026-11-11T10:01:00.000Z" })
      ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" })
      expect(await journal.append(intent)).toEqual(pending)
      expect(await original.load()).toEqual([pending])
      expect(await local.load()).toEqual([wrapped])
      expect(store.writes).toBe(3)
      expect(mirror.writes).toBe(1)
    }
  )

  it("binds paginated evidence to one authenticated head and rejects changed continuation", async () => {
    const f = await setup()
    await f.journal.append(intent)
    await f.journal.append({
      type: "attempt_status",
      supervisorInstanceId,
      observedAt: intent.observedAt,
      attemptId: binding.attemptId,
      status: "UNKNOWN",
    })
    const first = await f.journal.readCursor({ ...cursor, limit: 1 })
    expect(first.hasMore).toBe(true)
    expect(first.snapshotHead).toEqual(f.mirror.head)
    expect(first.nextCursor).toMatchObject({
      snapshotSequence: 2,
      snapshotHash: f.mirror.head!.recordHash,
    })
    const second = await f.journal.readCursor(first.nextCursor)
    expect(second.hasMore).toBe(false)
    expect(second.snapshotHead).toEqual(first.snapshotHead)
    await f.journal.append({
      type: "attempt_status",
      supervisorInstanceId,
      observedAt: intent.observedAt,
      attemptId: binding.attemptId,
      status: "UNKNOWN",
    })
    await expect(f.journal.readCursor(first.nextCursor)).rejects.toMatchObject({
      code: "CURSOR_CONFLICT",
    })
  })

  it("rejects a cursor with only one snapshot binding field", async () => {
    const f = await setup()
    await expect(f.journal.readCursor({ ...cursor, snapshotSequence: 0 })).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    })
  })

  it("requires exact original replay when the original fsync acknowledgement is lost", async () => {
    const fixture = await setup()
    let lose = true
    const source = {
      load: () => fixture.original.load(),
      confirmRecord: (record: JournalRecord<SupervisorJournalEvent>) =>
        fixture.original.confirmRecord(record),
      append: async (payload: SupervisorJournalEvent) => {
        const record = await fixture.original.append(payload)
        if (lose) {
          lose = false
          throw new Error("original fsync acknowledgement lost")
        }
        return record
      },
    }
    const journal = new SupervisorAuthorityJournal({ ...fixture.options, original: source })
    await expect(journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    await expect(journal.load()).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    const pending = (await fixture.original.load())[0]!
    expect(await journal.append(intent)).toEqual(pending)
    expect(await fixture.original.load()).toHaveLength(1)
    expect(await journal.load()).toEqual([pending])
  })

  it("does not repair an original-only pending event during a read", async () => {
    const { journal, original, local, store, mirror } = await setup()
    const pending = await original.append(intent)
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    expect(await local.load()).toEqual([])
    expect(store.writes + mirror.writes).toBe(0)
    expect(await journal.append(intent)).toEqual(pending)
  })

  it("holds original replay when its port cannot confirm fsync", async () => {
    const fixture = await setup()
    await fixture.original.append(intent)
    const original = {
      append: (payload: SupervisorJournalEvent) => fixture.original.append(payload),
      load: () => fixture.original.load(),
    }
    const journal = new SupervisorAuthorityJournal({ ...fixture.options, original })
    await expect(journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    expect(await fixture.original.load()).toHaveLength(1)
    expect(await fixture.local.load()).toHaveLength(0)
    expect(fixture.store.writes + fixture.mirror.writes).toBe(0)
  })

  it("keeps negative readback unresolved without advancing or changing identity", async () => {
    const { journal, original, local, store, mirror } = await setup()
    store.loseAcknowledgement = true
    await expect(journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    store.hideRecords = true
    await expect(journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    expect(await original.load()).toHaveLength(1)
    expect(await local.load()).toHaveLength(1)
    expect(store.writes).toBe(1)
    expect(mirror.writes).toBe(0)
    store.hideRecords = false
    await journal.append(intent)
    expect(await journal.load()).toHaveLength(1)
  })

  it("revalidates the complete persisted binding and latches a revoked epoch", async () => {
    let authorized = true
    const observations: unknown[] = []
    const { journal, original, store, mirror } = await setup(async (event, storedBinding) => {
      observations.push({ event, storedBinding })
      return (
        authorized &&
        storedBinding.operationId === binding.operationId &&
        storedBinding.authorityRevision === binding.authorityRevision
      )
    })
    await journal.append(intent)
    expect(observations.length).toBeGreaterThan(1)
    expect(observations.at(-1)).toMatchObject({ storedBinding: binding })
    const writes = [store.writes, mirror.writes]
    authorized = false
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    authorized = true
    await expect(journal.load()).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(await original.load()).toHaveLength(1)
    expect([store.writes, mirror.writes]).toEqual(writes)
  })

  it("rejects a stale original epoch before writing either journal", async () => {
    const { journal, original, local } = await setup()
    const stale = structuredClone(intent)
    if (stale.type !== "command_intent" || stale.command.type !== "PREPARE")
      throw new Error("fixture")
    stale.command.attempt.authorityEpochId = "epoch-stale"
    await expect(journal.append(stale)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(await original.load()).toEqual([])
    expect(await local.load()).toEqual([])
  })

  it("rejects tampered original signed bytes", async () => {
    const { journal, originalPath } = await setup()
    await journal.append(intent)
    const bytes = await readFile(originalPath, "utf8")
    await writeFile(originalPath, bytes.replace("operation-journal-1", "operation-journal-2"))
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
  })

  it("rejects a validly signed wrapper that changes original operation binding", async () => {
    const { journal, original, local } = await setup()
    const record = await original.append(intent)
    await local.append({
      epochId,
      operationId: "operation-foreign",
      scanId: binding.scanId,
      workspaceId: binding.workspaceId,
      attemptId: binding.attemptId,
      eventId: `supervisor:${record.hash}`,
      payload: record,
    })
    await expect(journal.load()).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
  })

  it("rejects conflicting mirror records even when its head still matches", async () => {
    const { journal, mirror } = await setup()
    await journal.append(intent)
    const record = mirror.records.get(1)!
    mirror.records.set(1, { ...record, signature: "f".repeat(64) })
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
  })

  it("holds an older database history without repairing or reopening it", async () => {
    const { journal, store, mirror } = await setup()
    await journal.append(intent)
    const writes = [store.writes, mirror.writes]
    mirror.head = null
    mirror.records.clear()
    await expect(journal.load()).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    await expect(journal.append(intent)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect([store.writes, mirror.writes]).toEqual(writes)
    expect(mirror.head).toBeNull()
  })

  it.each([
    { ...cursor, epochId: "epoch-other" },
    { ...cursor, supervisorInstanceId: "supervisor-other" },
    { ...cursor, afterSequence: 1, afterHash: genesis },
    { ...cursor, afterSequence: 4 },
  ])("rejects a foreign or conflicting cursor %j", async (input) => {
    const { journal } = await setup()
    await journal.append(intent)
    await expect(journal.readCursor(input)).rejects.toMatchObject({ code: "CURSOR_CONFLICT" })
    expect((await journal.readCursor(cursor)).records).toHaveLength(1)
  })

  it.each([
    { ...cursor, limit: 101 },
    { ...cursor, limit: 0 },
    { ...cursor, extra: true },
    { ...cursor, afterSequence: -1 },
    { ...cursor, afterSequence: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unbounded or malformed cursor %j", async (input) => {
    const { journal } = await setup()
    await expect(journal.readCursor(input)).rejects.toMatchObject({ code: "INVALID_CURSOR" })
  })

  it("requires separate original and independent files in the factory", () => {
    expect(() =>
      createSupervisorAuthorityJournal({
        originalPath: "/same",
        independentPath: "/same",
        originalSigningSecret: signingSecret,
        signingSecret,
        epochId,
        supervisorInstanceId,
        store: new Store(),
        mirror: new Mirror(),
        authorize: async () => false,
        authorizeStream: async () => true,
        authorizeRecovery: async () => true,
      })
    ).toThrow("separate files")
  })

  it.each([
    "segment",
    "segment-reversed",
    "segment-stem",
    "segment-stem-reversed",
    "lock",
    "case-variant-segment",
    "case-variant-lock",
    "unicode-variant-segment",
    "parent-alias-segment",
  ])("rejects %s factory namespace collisions before creating either writer", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-factory-namespace-"))
    roots.push(root)
    let originalPath = join(root, "original.jsonl")
    let independentPath = `${originalPath}.segment.2`
    if (kind === "segment-reversed")
      [originalPath, independentPath] = [independentPath, originalPath]
    if (kind === "segment-stem") independentPath = `${originalPath}.segment`
    if (kind === "segment-stem-reversed") {
      independentPath = originalPath
      originalPath = `${originalPath}.segment`
    }
    if (kind === "lock") independentPath = `${originalPath}.lock`
    if (kind === "case-variant-segment") independentPath = join(root, "ORIGINAL.JSONL.SEGMENT.2")
    if (kind === "case-variant-lock") independentPath = join(root, "ORIGINAL.JSONL.LOCK")
    if (kind === "unicode-variant-segment") {
      originalPath = join(root, "café")
      independentPath = join(root, "cafe\u0301.segment.2")
    }
    if (kind === "parent-alias-segment") {
      await symlink(root, join(root, "alias"))
      independentPath = join(root, "alias", "original.jsonl.segment.2")
    }
    const names = await readdir(root)
    expect(() =>
      createSupervisorAuthorityJournal({
        originalPath,
        independentPath,
        originalSigningSecret: signingSecret,
        signingSecret,
        epochId,
        supervisorInstanceId,
        store: new Store(),
        mirror: new Mirror(),
        authorize: async () => false,
        authorizeStream: async () => true,
        authorizeRecovery: async () => true,
      })
    ).toThrow(/namespace|separate files/)
    expect(await readdir(root)).toEqual(names)
  })

  it.each(["normalized", "symlink", "parent-alias", "hardlink"])(
    "rejects %s factory file aliases without changing retained bytes",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "supervisor-factory-alias-"))
      roots.push(root)
      const originalPath = join(root, "original.jsonl")
      let independentPath = join(root, "independent.jsonl")
      await writeFile(originalPath, "retained bytes")
      if (kind === "normalized") independentPath = `${root}/./original.jsonl`
      if (kind === "symlink") await symlink(originalPath, independentPath)
      if (kind === "hardlink") await link(originalPath, independentPath)
      if (kind === "parent-alias") {
        await symlink(root, join(root, "alias"))
        independentPath = join(root, "alias", "original.jsonl")
      }
      const names = await readdir(root)
      expect(() =>
        createSupervisorAuthorityJournal({
          originalPath,
          independentPath,
          originalSigningSecret: signingSecret,
          signingSecret,
          epochId,
          supervisorInstanceId,
          store: new Store(),
          mirror: new Mirror(),
          authorize: async () => false,
          authorizeStream: async () => true,
          authorizeRecovery: async () => true,
        })
      ).toThrow(/separate files|symbolic/)
      expect(await readdir(root)).toEqual(names)
      expect(await readFile(originalPath, "utf8")).toBe("retained bytes")
    }
  )

  it("denies publication-mode append and recovery before changing either signed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-publication-read-only-"))
    roots.push(root)
    const originalPath = join(root, "original.jsonl"),
      independentPath = join(root, "wrapped.jsonl")
    const original = new SignedJournal(
      originalPath,
      "o".repeat(48),
      supervisorJournalEventSchema.parse
    )
    const local = new SignedJournal(
      independentPath,
      signingSecret,
      authorityEventSchema(supervisorJournalRecordSchema).parse
    )
    const journal = new SupervisorAuthorityJournal({
      original,
      local,
      signingSecret,
      epochId,
      supervisorInstanceId,
      store: new Store(),
      mirror: new Mirror(),
      authorize: async () => true,
      authorizeStream: async () => true,
      authorizeRecovery: async () => true,
      readOnly: true,
    })
    await expect(journal.append(intent)).rejects.toThrow("Publication journal is read-only")
    await expect(journal.recoverPending()).rejects.toThrow("Publication journal is read-only")
    expect(await readdir(root)).toEqual([])
    await Promise.all([original.close(), local.close()])
  })

  it("runs confirmed private projection after releasing the journal serialization queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-private-projection-"))
    roots.push(root)
    let projected = false
    const built = createSupervisorAuthorityJournal({
      originalPath: join(root, "original.jsonl"),
      independentPath: join(root, "wrapped.jsonl"),
      originalSigningSecret: "o".repeat(48),
      signingSecret,
      epochId,
      supervisorInstanceId,
      store: new Store(),
      mirror: new Mirror(),
      authorize: async () => true,
      authorizeStream: async () => true,
      authorizeRecovery: async () => true,
      onConfirmed: async (record) => {
        const page = await built.journal.readCursor(cursor)
        expect(page.records[0]?.payload.payload).toEqual(record)
        projected = true
      },
    })
    try {
      await built.journal.append(intent)
      expect(projected).toBe(true)
    } finally {
      await built.close()
    }
  })

  it("reopens the factory's original and wrapper files without changing signed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-factory-test-"))
    roots.push(root)
    const originalPath = join(root, "original.jsonl")
    const independentPath = join(root, "independent.jsonl")
    const options = {
      originalPath,
      independentPath,
      originalSigningSecret: "o".repeat(48),
      signingSecret,
      epochId,
      supervisorInstanceId,
      store: new Store(),
      mirror: new Mirror(),
      authorize: async () => true,
      authorizeStream: async () => true,
      authorizeRecovery: async () => true,
    }
    const first = createSupervisorAuthorityJournal(options)
    const receipt = await first.journal.append(intent)
    await first.close()
    const originalBytes = await readFile(originalPath, "utf8")
    const wrapperBytes = await readFile(independentPath, "utf8")
    const restarted = createSupervisorAuthorityJournal(options)
    try {
      expect(await restarted.journal.load()).toEqual([receipt])
      expect((await restarted.journal.readCursor(cursor)).records[0]?.payload.payload).toEqual(
        receipt
      )
      expect(await readFile(originalPath, "utf8")).toBe(originalBytes)
      expect(await readFile(independentPath, "utf8")).toBe(wrapperBytes)
    } finally {
      await restarted.close()
    }
  })

  it("bounds pages by bytes while keeping contiguous original cursors", async () => {
    const { journal } = await setup()
    await journal.append(intent)
    for (let index = 0; index < 3; index += 1) {
      await journal.append({
        type: "resource_bound",
        supervisorInstanceId,
        observedAt: intent.observedAt,
        commandId: "command-journal-1",
        attemptId: binding.attemptId,
        ownership: { fixture: "x".repeat(120 * 1024), index },
      })
    }
    const page = await journal.readCursor(cursor)
    expect(Buffer.byteLength(canonicalJson(page))).toBeLessThanOrEqual(
      MAX_SUPERVISOR_JOURNAL_PAGE_BYTES
    )
    expect(page.records.length).toBeGreaterThan(0)
    expect(page.records.length).toBeLessThan(4)
    expect(page.hasMore).toBe(true)
    const next = await journal.readCursor(page.nextCursor)
    expect(next.records[0]?.payload.payload.sequence).toBe(page.nextCursor.afterSequence + 1)
    expect(next.records[0]?.payload.payload.previousHash).toBe(page.nextCursor.afterHash)
    expect(next.hasMore).toBe(false)
    await expect(
      journal.append({
        type: "resource_bound",
        supervisorInstanceId,
        observedAt: intent.observedAt,
        commandId: "command-journal-1",
        attemptId: binding.attemptId,
        ownership: { fixture: "x".repeat(128 * 1024) },
      })
    ).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" })
    expect(await journal.load()).toHaveLength(4)
  })

  it("serves authenticated cursor reads through the service without physical effects", async () => {
    const { journal } = await setup()
    const original = await journal.append(intent)
    const { service, effects } = serviceFixture(journal)
    const controlToken = "c".repeat(48)
    const server = createServer(
      createSupervisorHandler(service, { controlToken, admission: "closed" })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const query = new URLSearchParams(
      Object.entries(cursor).map(([key, value]): [string, string] => [key, String(value)])
    )
    const url = `http://127.0.0.1:${address.port}/v1/journal?${query}`
    try {
      expect((await fetch(url)).status).toBe(401)
      const response = await fetch(url, { headers: { authorization: `Bearer ${controlToken}` } })
      expect(response.status).toBe(200)
      const page = await response.json()
      expect(page).toMatchObject({
        records: [{ payload: { payload: original } }],
        nextCursor: { afterHash: original.hash },
      })
      const headers = { authorization: `Bearer ${controlToken}` }
      const invalid = new URL(url)
      invalid.searchParams.set("limit", "101")
      expect((await fetch(invalid, { headers })).status).toBe(400)
      invalid.searchParams.set("limit", "10")
      invalid.searchParams.set("epochId", "epoch-foreign")
      expect((await fetch(invalid, { headers })).status).toBe(409)
      expect(effects.count).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it("performs no create or start when durability of the create intent is ambiguous", async () => {
    const { journal, store } = await setup()
    const { service, effects, prepare } = serviceFixture(journal)
    const prepared = await service.execute(prepare)
    store.onRecordWrite = async (bytes) => {
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
      if (value.record.payload.payload.payload.type === "resource_create_planned") {
        store.loseAcknowledgement = true
      }
    }
    await expect(
      service.execute({
        type: "START_UNMETERED",
        commandId: "start-journal-1",
        attemptId: binding.attemptId,
        executorKey: "scanner",
        expectedReceiptHash: prepared.receipt.hash,
      })
    ).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    expect(effects.count).toBe(0)
    await expect(journal.readCursor(cursor)).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
  })

  it("serializes accepted STOP against an unacknowledged create intent", async () => {
    const { journal, store } = await setup()
    const { service, effects, prepare } = serviceFixture(journal)
    const prepared = await service.execute(prepare)
    let createdIntent!: () => void
    const entered = new Promise<void>((resolve) => {
      createdIntent = resolve
    })
    let releaseIntent!: () => void
    const release = new Promise<void>((resolve) => {
      releaseIntent = resolve
    })
    store.onRecordWrite = async (bytes) => {
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
      if (value.record.payload.payload.payload.type === "resource_create_planned") {
        createdIntent()
        await release
      }
    }
    const start = service.execute({
      type: "START_UNMETERED",
      commandId: "start-journal-1",
      attemptId: binding.attemptId,
      executorKey: "scanner",
      expectedReceiptHash: prepared.receipt.hash,
    })
    await entered
    const attempt = await service.getAttempt(binding.attemptId)
    const stop = service.execute({
      type: "STOP",
      commandId: "stop-journal-1",
      attemptId: binding.attemptId,
      expectedReceiptHash: attempt!.receipt.hash,
    })
    // STOP must set its in-flight marker before storage acknowledges creation intent.
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseIntent()
    const [started, stopped] = await Promise.all([start, stop])
    expect(started.status).toBe("UNKNOWN")
    expect(stopped.status).toBe("UNKNOWN")
    expect(effects.count).toBe(0)
    const records = await journal.load()
    expect(
      records.some(
        (record) =>
          record.payload.type === "command_intent" && record.payload.command.type === "STOP"
      )
    ).toBe(true)
  })
})

function serviceFixture(
  journal: SupervisorServiceOptions["journal"],
  now: () => Date = () => new Date("2026-11-11T10:00:00.000Z")
) {
  const effects = { count: 0 }
  const prepare = {
    type: "PREPARE" as const,
    commandId: "prepare-service-journal-1",
    attempt: binding,
    executors: [
      {
        key: "scanner",
        spec: {
          kind: "container",
          image: "fixture@sha256:" + "a".repeat(64),
          argv: [],
          env: {},
          network: "fixture-network",
          cpus: 1,
          memoryMb: 64,
          pidsLimit: 16,
          readOnly: true,
          grantEnvName: "LLM_API_KEY",
        },
      },
    ],
  }
  const service = new SupervisorService({
    authorityFence: fixtureAuthorityFence,
    journal,
    signingSecret,
    supervisorInstanceId,
    admission: "open",
    now,
    providerGatewayUrl: "http://127.0.0.1:1",
    executor: {
      create: async () => {
        effects.count += 1
        throw new Error("unexpected create")
      },
      start: async () => {
        effects.count += 1
        throw new Error("unexpected start")
      },
      inspect: async () => ({ state: "ABSENT" as const }),
      stop: async () => ({ state: "ABSENT" as const }),
    },
    providerGateway: {
      issueGrant: async () => {
        effects.count += 1
        throw new Error("unexpected provider grant")
      },
      findGrantByRequest: async () => null,
      inspectGrant: async () => null,
      revokeGrant: async () => {
        throw new Error("unexpected revocation")
      },
    },
    policy: {
      allowedImages: new Set([prepare.executors[0]!.spec.image]),
      allowedNetworks: new Set(["fixture-network"]),
      allowedProcessCommands: new Set(),
      allowedCwdRoots: [tmpdir()],
      allowedCgroupRoot: tmpdir(),
    },
  })
  return { service, effects, prepare }
}
