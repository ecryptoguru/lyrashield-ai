import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
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
  createSupervisorAuthorityJournal,
  type SupervisorAuthorityJournalOptions,
} from "./authority-journal"
import { supervisorJournalEventSchema, type SupervisorJournalEvent } from "./journal-events"
import { createSupervisorHandler } from "./http"
import { SupervisorService } from "./service"

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

async function setup(authorize: SupervisorAuthorityJournalOptions["authorize"] = async () => true) {
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
      expect(store.writes).toBe(2)
      expect(mirror.writes).toBe(1)
    }
  )

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
      })
    ).toThrow("separate files")
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

function serviceFixture(journal: SupervisorAuthorityJournal) {
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
    journal,
    signingSecret,
    supervisorInstanceId,
    admission: "open",
    now: () => new Date("2026-11-11T10:00:00.000Z"),
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
