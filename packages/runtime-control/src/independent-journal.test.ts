import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { SignedJournal, type JournalRecord } from "./journal"
import {
  IndependentAuthorityJournal,
  authorityEventSchema,
  type AuthorityHead,
  type AuthorityMirror,
  type ConditionalObjectStore,
  type StoredObject,
} from "./independent-journal"

const secret = "j".repeat(48)
const roots: string[] = []
const event = {
  epochId: "epoch-2",
  operationId: "operation-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  attemptId: "attempt-1",
  eventId: "command-1",
  payload: { action: "START" },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class Store implements ConditionalObjectStore {
  objects = new Map<string, StoredObject>()
  writes = 0
  loseCreateAcknowledgement = false
  negativeReadAfterConflict = false
  hideNextRead = false
  failNextRead = false
  onRecordWrite?: () => void

  async read(key: string): Promise<StoredObject | null> {
    if (this.failNextRead) {
      this.failNextRead = false
      throw new Error("temporary read failure")
    }
    if (this.hideNextRead) {
      this.hideNextRead = false
      return null
    }
    return this.objects.get(key) ?? null
  }

  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ) {
    const previous = this.objects.get(key)
    if (
      ("ifNoneMatch" in condition && previous) ||
      ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
    ) {
      if (this.negativeReadAfterConflict && key.includes("/records/")) {
        this.negativeReadAfterConflict = false
        this.hideNextRead = true
      }
      return "conflict" as const
    }
    this.writes += 1
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${this.writes}` })
    if (key.includes("/records/")) this.onRecordWrite?.()
    if (this.loseCreateAcknowledgement && key.includes("/records/")) {
      this.loseCreateAcknowledgement = false
      throw new Error("write acknowledged by storage but response lost")
    }
    return "written" as const
  }
}

class Mirror implements AuthorityMirror {
  head: AuthorityHead | null = null
  records = new Map<number, JournalRecord<unknown>>()
  applications = 0
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
    if (JSON.stringify(this.head) !== JSON.stringify(previous)) return "conflict" as const
    this.applications += 1
    this.head = head
    this.records.set(record.sequence, structuredClone(record))
    if (this.loseAcknowledgement) {
      this.loseAcknowledgement = false
      throw new Error("database committed but response was lost")
    }
    return "written" as const
  }
}

async function setup(
  store = new Store(),
  mirror = new Mirror(),
  authorizeEvent = async () => true
) {
  const root = await mkdtemp(join(tmpdir(), "independent-journal-test-"))
  roots.push(root)
  const local = new SignedJournal(join(root, "local.jsonl"), secret, (value) =>
    authorityEventSchema(z.object({ action: z.string() }).strict()).parse(value)
  )
  const journal = new IndependentAuthorityJournal({
    local,
    store,
    mirror,
    epochId: "epoch-2",
    supervisorInstanceId: "supervisor-1",
    signingSecret: "k".repeat(48),
    payloadSchema: z.object({ action: z.string() }).strict(),
    authorize: authorizeEvent,
  })
  return { journal, local, store, mirror, root }
}

describe("independent authority journal", () => {
  it("persists and reads back the same signed intent in all three authorities", async () => {
    const { journal, local, store, mirror } = await setup()
    const first = await journal.appendIntent(event)
    const replay = await journal.appendIntent(event)
    expect(first).toEqual(replay)
    expect(first.sequence).toBe(1)
    expect(await local.load()).toHaveLength(1)
    expect(store.objects.size).toBe(2)
    expect(mirror.head?.recordHash).toBe(first.hash)
    expect(mirror.applications).toBe(1)
  })

  it("replays the same identity after an ambiguous create and never advances on a negative read", async () => {
    const store = new Store()
    const { journal, local } = await setup(store)
    store.loseCreateAcknowledgement = true
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    await expect(journal.appendIntent({ ...event, eventId: "command-2" })).rejects.toMatchObject({
      code: "REPLAY_REQUIRED",
    })
    store.negativeReadAfterConflict = true
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const recovered = await journal.appendIntent(event)
    expect(recovered.sequence).toBe(1)
    expect(await local.load()).toHaveLength(1)
  })

  it("resolves a lost database acknowledgement by reading the same committed head", async () => {
    const mirror = new Mirror()
    mirror.loseAcknowledgement = true
    const { journal, local } = await setup(new Store(), mirror)
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const recovered = await journal.appendIntent(event)
    expect(recovered.sequence).toBe(1)
    expect(mirror.applications).toBe(1)
    expect(await local.load()).toHaveLength(1)
  })

  it("keeps admission closed when the independent head is ahead of local durability", async () => {
    const store = new Store()
    const mirror = new Mirror()
    const first = await setup(store, mirror)
    await first.journal.appendIntent(event)
    const rolledBack = await setup(store, mirror)
    await expect(
      rolledBack.journal.appendIntent({ ...event, eventId: "command-2" })
    ).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(await rolledBack.local.load()).toHaveLength(0)
  })

  it("does not mistake a local-only record for a confirmed intent after initialization fails", async () => {
    const store = new Store()
    const { journal, local, mirror } = await setup(store)
    await local.append(event)
    store.failNextRead = true
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const recovered = await journal.appendIntent(event)
    expect(recovered.sequence).toBe(1)
    expect(store.objects.size).toBe(2)
    expect(mirror.head?.recordHash).toBe(recovered.hash)
  })

  it("rejects a forged remote head and a reused event identity", async () => {
    const { journal, store } = await setup()
    await journal.appendIntent(event)
    await expect(
      journal.appendIntent({ ...event, payload: { action: "STOP" } })
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" })
    const headEntry = [...store.objects.entries()].find(([key]) => key.endsWith("/head"))
    if (!headEntry) throw new Error("missing test head")
    store.objects.set(headEntry[0], { ...headEntry[1], bytes: Buffer.from("{}") })
    await expect(journal.appendIntent({ ...event, eventId: "command-2" })).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
  })

  it("detects tampering in any earlier independent record before issuing another intent", async () => {
    const { journal, store } = await setup()
    await journal.appendIntent(event)
    await journal.appendIntent({ ...event, eventId: "command-2" })
    const oldEntry = [...store.objects.entries()].find(([key]) => key.endsWith("/records/1"))
    if (!oldEntry) throw new Error("missing test record")
    store.objects.set(oldEntry[0], { ...oldEntry[1], bytes: Buffer.from("{}") })
    await expect(journal.appendIntent({ ...event, eventId: "command-3" })).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
  })

  it.each(["missing", "altered"])(
    "rejects a %s database record even when its head still matches",
    async (damage) => {
      const { journal, mirror } = await setup()
      await journal.appendIntent(event)
      await journal.appendIntent({ ...event, eventId: "command-2" })
      if (damage === "missing") mirror.records.delete(1)
      else mirror.records.set(1, { ...mirror.records.get(1)!, payload: { forged: true } })
      await expect(journal.appendIntent({ ...event, eventId: "command-3" })).rejects.toMatchObject({
        code: damage === "missing" ? "AUTHORITY_UNKNOWN" : "AUTHORITY_CONFLICT",
      })
    }
  )

  it("rejects a database record with an extra prototype-named property on replay", async () => {
    const { journal, mirror } = await setup()
    await journal.appendIntent(event)
    const original = mirror.records.get(1)!
    const altered = JSON.parse(JSON.stringify(original)) as JournalRecord<unknown>
    Object.defineProperty(altered, "__proto__", { value: { forged: true }, enumerable: true })
    mirror.records.set(1, altered)
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
  })

  it("revalidates authority after durable writes before returning a receipt", async () => {
    let permitted = true
    const store = new Store()
    store.onRecordWrite = () => {
      permitted = false
    }
    const { journal } = await setup(store, new Mirror(), async () => permitted)
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
  })

  it("does not allow two different writers to advance the same sequence", async () => {
    const store = new Store()
    const mirror = new Mirror()
    const first = await setup(store, mirror)
    const second = await setup(store, mirror)
    const results = await Promise.allSettled([
      first.journal.appendIntent(event),
      second.journal.appendIntent({ ...event, eventId: "command-2" }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(mirror.applications).toBe(1)
  })

  it("does not let a delayed mirror acknowledgement overwrite a newer head", async () => {
    let entered: () => void = () => undefined
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      entered = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    class PausingMirror extends Mirror {
      first = true
      override async compareAndAppend(
        previous: AuthorityHead | null,
        head: AuthorityHead,
        record: JournalRecord<unknown>
      ) {
        if (this.first && head.sequence === 1) {
          this.first = false
          entered()
          await resume
        }
        return super.compareAndAppend(previous, head, record)
      }
    }
    const store = new Store()
    const mirror = new PausingMirror()
    const first = await setup(store, mirror)
    const second = await setup(store, mirror)
    await first.local.append(event)
    await second.local.append(event)
    const delayed = first.journal.appendIntent(event).catch((error: unknown) => error)
    await blocked
    expect((await second.journal.appendIntent(event)).sequence).toBe(1)
    expect((await second.journal.appendIntent({ ...event, eventId: "command-2" })).sequence).toBe(2)
    release()
    expect(await delayed).toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect(mirror.head?.sequence).toBe(2)
    expect(mirror.applications).toBe(2)
  })

  it("does not reopen a journal after the database mirror rolls back", async () => {
    const { journal, mirror, local } = await setup()
    await journal.appendIntent(event)
    mirror.head = null
    await expect(journal.appendIntent({ ...event, eventId: "command-2" })).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
    expect(await local.load()).toHaveLength(1)
  })

  it("does not return a replay after its local durable journal is rolled back", async () => {
    const { journal, root } = await setup()
    await journal.appendIntent(event)
    await writeFile(join(root, "local.jsonl"), "")
    await expect(journal.appendIntent(event)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
  })

  it("does not expose mutable references to its cached journal state", async () => {
    const { journal } = await setup()
    const receipt = await journal.appendIntent(event)
    receipt.payload.payload.action = "STOP"
    const replay = await journal.appendIntent(event)
    expect(replay.payload.payload.action).toBe("START")
  })
})
