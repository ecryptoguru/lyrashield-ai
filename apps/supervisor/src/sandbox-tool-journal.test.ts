import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  IndependentAuthorityJournal,
  SignedJournal,
  authorityEventSchema,
  canonicalJson,
  type AuthorityEvent,
  type AuthorityHead,
  type AuthorityMirror,
  type ConditionalObjectStore,
  type JournalRecord,
  type StoredObject,
} from "@lyrashield/runtime-control"
import {
  SandboxToolJournal,
  sandboxToolEventSchema,
  type SandboxToolEvent,
} from "./sandbox-tool-journal"
import { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import { SandboxToolResponses } from "./sandbox-tool-response"

const roots: string[] = []
const secret = "s".repeat(48)
const originalSecret = "o".repeat(48)
const event: SandboxToolEvent = {
  type: "tool_intent",
  supervisorInstanceId: "supervisor-1.tools",
  observedAt: "2026-11-13T00:00:00.000Z",
  binding: {
    authorityEpochId: "epoch-1",
    operationId: "operation-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    attemptId: "attempt-1",
  },
  tool: {
    requestId: "request-1",
    kind: "exec",
    commandId: "tool-command-1",
    prepareCommandId: "prepare-1",
    invocationGuardId: "guard-1",
    actionChecksum: "a".repeat(64),
    handleChecksum: "b".repeat(64),
    containerId: "c".repeat(64),
    maxOutputBytes: 1024,
  },
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class Store implements ConditionalObjectStore {
  readonly objects = new Map<string, StoredObject>()
  async read(key: string) {
    return this.objects.get(key) ?? null
  }
  async readBounded(key: string, maxBytes: number) {
    const value = await this.read(key)
    if (value && value.bytes.byteLength > maxBytes) throw new Error("object too large")
    return value
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
    )
      return "conflict" as const
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: String(this.objects.size + 1) })
    return "written" as const
  }
}

class Mirror implements AuthorityMirror {
  head: AuthorityHead | null = null
  readonly records = new Map<number, JournalRecord<unknown>>()
  loseAck = false
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
    if (canonicalJson(head) === canonicalJson(this.head)) {
      if (this.loseAck) throw new Error("mirror acknowledgement lost")
      return canonicalJson(this.records.get(record.sequence)) === canonicalJson(record)
        ? ("written" as const)
        : ("conflict" as const)
    }
    if (canonicalJson(previous) !== canonicalJson(this.head)) return "conflict" as const
    this.head = structuredClone(head)
    this.records.set(record.sequence, structuredClone(record))
    if (this.loseAck) throw new Error("mirror acknowledgement lost")
    return "written" as const
  }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-tool-journal-"))
  roots.push(directory)
  const source = new SignedJournal(join(directory, "source"), originalSecret, (input) =>
    sandboxToolEventSchema.parse(input)
  )
  const local = new SignedJournal<AuthorityEvent<JournalRecord<SandboxToolEvent>>>(
    join(directory, "independent"),
    secret,
    (input) => authorityEventSchema(z.custom<JournalRecord<SandboxToolEvent>>()).parse(input)
  )
  const store = new Store()
  const mirror = new Mirror()
  const authority = { allowed: true }
  const independent = new IndependentAuthorityJournal({
    local,
    store,
    mirror,
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1.tools",
    signingSecret: secret,
    payloadSchema: z.custom<JournalRecord<SandboxToolEvent>>(),
    authorize: async () => authority.allowed,
  })
  return {
    directory,
    source,
    local,
    store,
    mirror,
    authority,
    independent,
    journal: new SandboxToolJournal(
      source,
      independent,
      originalSecret,
      "epoch-1",
      "supervisor-1.tools",
      "supervisor-1"
    ),
  }
}

describe("independent sandbox tool journal", () => {
  it("retries only the exact authenticated acknowledgement after mirror response loss", async () => {
    const f = await setup()
    const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
    const binding = {
      attemptId: "attempt-1",
      operationId: "operation-1",
      authorityEpochId: "epoch-1",
      sandboxHandle: "sandbox-1",
    }
    const first: SandboxToolEvent = {
      ...event,
      tool: {
        ...event.tool,
        requestId,
        commandId: requestId,
        handleChecksum: "bc2cc17bf72365e870812896e41b82f5a76bd9dc9484e3dca61952c194563fd4",
      },
    }
    await f.journal.append(first)
    for (const type of ["tool_created", "tool_starting", "tool_started"] as const)
      await f.journal.append({ ...first, type, tool: { ...first.tool, execId: "e".repeat(64) } })
    const response = {
      binding,
      requestId,
      status: "COMPLETED",
      exitCode: 0,
      stdoutBase64: "",
      stderrBase64: "",
    }
    const observer = {
      observe: async () => ({
        execId: "e".repeat(64),
        containerId: "c".repeat(64),
        invocationGuardId: "guard-1",
        actionChecksum: "a".repeat(64),
        state: "EXITED",
        exitCode: 0,
        response,
      }),
    }
    const ledger = new SandboxToolAcknowledgements(
      f.journal,
      new SandboxToolResponses(f.store, "r".repeat(48)),
      observer
    )
    const proof = await ledger.complete(binding, requestId)
    f.mirror.loseAck = true
    await expect(ledger.acknowledge(binding, requestId, proof.responseChecksum)).rejects.toThrow()
    f.mirror.loseAck = false
    await expect(
      ledger.acknowledge(binding, requestId, `sha256:${"f".repeat(64)}`)
    ).rejects.toThrow()
    expect(await ledger.acknowledge(binding, requestId, proof.responseChecksum)).toMatchObject({
      status: "ACKNOWLEDGED",
      responseChecksum: proof.responseChecksum,
    })
    expect(
      (await f.journal.load()).filter((record) => record.payload.type === "tool_ack")
    ).toHaveLength(1)
    await f.source.close()
    await f.local.close()
  })

  it("rejects oversized retained output before recovering a pending mirror acknowledgement", async () => {
    const f = await setup()
    const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
    const binding = {
      attemptId: "attempt-1",
      operationId: "operation-1",
      authorityEpochId: "epoch-1",
      sandboxHandle: "sandbox-1",
    }
    const first: SandboxToolEvent = {
      ...event,
      tool: {
        ...event.tool,
        requestId,
        commandId: requestId,
        handleChecksum: "bc2cc17bf72365e870812896e41b82f5a76bd9dc9484e3dca61952c194563fd4",
      },
    }
    await f.journal.append(first)
    for (const type of ["tool_created", "tool_starting", "tool_started"] as const)
      await f.journal.append({ ...first, type, tool: { ...first.tool, execId: "e".repeat(64) } })
    const responses = new SandboxToolResponses(f.store, "r".repeat(48))
    const proof = await responses.retain(binding, requestId, {
      binding,
      requestId,
      status: "COMPLETED",
      exitCode: 0,
      stdoutBase64: Buffer.alloc(1025).toString("base64"),
      stderrBase64: "",
    })
    const responseEvent: SandboxToolEvent = {
      ...first,
      type: "tool_response",
      tool: { ...first.tool, execId: "e".repeat(64), ...proof },
    }
    await f.journal.append(responseEvent)
    f.mirror.loseAck = true
    await expect(f.journal.append({ ...responseEvent, type: "tool_ack" })).rejects.toThrow()
    f.mirror.loseAck = false
    const recoverMirror = vi.spyOn(f.mirror, "compareAndAppend")
    const ledger = new SandboxToolAcknowledgements(f.journal, responses)
    await expect(ledger.acknowledge(binding, requestId, proof.responseChecksum)).rejects.toThrow(
      "sandbox output is too large"
    )
    expect(recoverMirror).not.toHaveBeenCalled()
    await f.source.close()
    await f.local.close()
  })

  it("atomically deduplicates concurrent response and ACK transitions across handlers", async () => {
    const f = await setup()
    const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
    const binding = {
      attemptId: "attempt-1",
      operationId: "operation-1",
      authorityEpochId: "epoch-1",
      sandboxHandle: "sandbox-1",
    }
    const first: SandboxToolEvent = {
      ...event,
      tool: {
        ...event.tool,
        requestId,
        commandId: requestId,
        handleChecksum: "bc2cc17bf72365e870812896e41b82f5a76bd9dc9484e3dca61952c194563fd4",
      },
    }
    await f.journal.append(first)
    for (const type of ["tool_created", "tool_starting", "tool_started"] as const)
      await f.journal.append({ ...first, type, tool: { ...first.tool, execId: "e".repeat(64) } })
    const response = {
      binding,
      requestId,
      status: "COMPLETED",
      exitCode: 0,
      stdoutBase64: "",
      stderrBase64: "",
    }
    const observer = {
      observe: async () => ({
        execId: "e".repeat(64),
        containerId: "c".repeat(64),
        invocationGuardId: "guard-1",
        actionChecksum: "a".repeat(64),
        state: "EXITED",
        exitCode: 0,
        response,
      }),
    }
    const responses = new SandboxToolResponses(f.store, "r".repeat(48))
    const firstHandler = new SandboxToolAcknowledgements(f.journal, responses, observer)
    const secondJournal = new SandboxToolJournal(
      f.source,
      f.independent,
      originalSecret,
      "epoch-1",
      "supervisor-1.tools",
      "supervisor-1"
    )
    const secondHandler = new SandboxToolAcknowledgements(secondJournal, responses, observer)
    const realLoad = f.journal.load.bind(f.journal)
    const secondRealLoad = secondJournal.load.bind(secondJournal)
    const loadSpy = vi.spyOn(f.journal, "load")
    const secondLoadSpy = vi.spyOn(secondJournal, "load")
    const synchronizeTwoReads = () => {
      let count = 0
      let unblock!: () => void
      const gate = new Promise<void>((resolve) => {
        unblock = resolve
      })
      const waitForBoth = async (records: Awaited<ReturnType<typeof realLoad>>) => {
        count += 1
        if (count === 2) unblock()
        if (count <= 2) await gate
        return records
      }
      loadSpy.mockImplementation(async () => waitForBoth(await realLoad()))
      secondLoadSpy.mockImplementation(async () => waitForBoth(await secondRealLoad()))
    }
    synchronizeTwoReads()
    const [proof, duplicate] = await Promise.all([
      firstHandler.complete(binding, requestId),
      secondHandler.complete(binding, requestId),
    ])
    expect(duplicate).toEqual(proof)
    synchronizeTwoReads()
    const [ack, repeated] = await Promise.all([
      firstHandler.acknowledge(binding, requestId, proof.responseChecksum),
      secondHandler.acknowledge(binding, requestId, proof.responseChecksum),
    ])
    expect(repeated).toEqual(ack)
    loadSpy.mockRestore()
    secondLoadSpy.mockRestore()
    expect((await f.journal.load()).map((record) => record.payload.type)).toEqual([
      "tool_intent",
      "tool_created",
      "tool_starting",
      "tool_started",
      "tool_response",
      "tool_ack",
    ])
    await f.source.close()
    await f.local.close()
  })

  it("rejects an independent journal bound to a different stream", async () => {
    const f = await setup()
    expect(
      () =>
        new SandboxToolJournal(
          f.source,
          f.independent,
          originalSecret,
          "epoch-2",
          "supervisor-1.tools",
          "supervisor-1"
        )
    ).toThrow(/foreign tool stream/)
    await f.source.close()
    await f.local.close()
  })

  it("retains and confirms the exact signed original through the independent mirror", async () => {
    const f = await setup()
    const original = await f.journal.append(event)
    expect(await f.journal.load()).toEqual([original])
    expect((await f.mirror.readRecord(1))?.payload).toMatchObject({
      eventId: `supervisor:${original.hash}`,
      payload: original,
    })
    await f.source.close()
    await f.local.close()
  })

  it("recovers the exact original after an ambiguous mirror acknowledgement without executing it again", async () => {
    const f = await setup()
    f.mirror.loseAck = true
    await expect(f.journal.append(event)).rejects.toThrow()
    await expect(
      f.journal.append({ ...event, tool: { ...event.tool, requestId: "request-2" } })
    ).rejects.toThrow()
    const [original] = await f.source.load()
    expect(original).toBeDefined()
    await expect(
      f.journal.recoverExactTail({ sequence: original!.sequence, hash: "f".repeat(64) })
    ).rejects.toThrow(/identity differs/)
    expect(await f.source.load()).toHaveLength(1)
    await expect(
      f.journal.recoverExactTail({ sequence: original!.sequence, hash: original!.hash })
    ).rejects.toThrow()
    f.mirror.loseAck = false
    expect(
      await f.journal.recoverExactTail({ sequence: original!.sequence, hash: original!.hash })
    ).toEqual(original)
    expect(await f.journal.load()).toEqual([original])
    expect(
      await f.journal.recoverExactTail({ sequence: original!.sequence, hash: original!.hash })
    ).toEqual(original)
    expect(await f.source.load()).toHaveLength(1)
    await expect(
      f.journal.append({
        ...event,
        tool: { ...event.tool, requestId: "request-2", commandId: "command-2" },
      })
    ).rejects.toThrow(/unresolved/)
    await f.source.close()
    await f.local.close()
  })

  it("rejects foreign epochs before writing a source record", async () => {
    const f = await setup()
    await expect(
      f.journal.append({ ...event, binding: { ...event.binding, authorityEpochId: "epoch-2" } })
    ).rejects.toThrow()
    expect(await f.source.load()).toHaveLength(0)
    await f.source.close()
    await f.local.close()
  })

  it("does not recover a pending record after its persisted authority is revoked", async () => {
    const f = await setup()
    f.mirror.loseAck = true
    await expect(f.journal.append(event)).rejects.toThrow()
    const [original] = await f.source.load()
    f.mirror.loseAck = false
    f.authority.allowed = false
    await expect(
      f.journal.recoverExactTail({ sequence: original!.sequence, hash: original!.hash })
    ).rejects.toThrow(/authority/)
    expect(await f.source.load()).toEqual([original])
    await f.source.close()
    await f.local.close()
  })

  it("recovers the same mirrored tail after a process restart", async () => {
    const f = await setup()
    f.mirror.loseAck = true
    await expect(f.journal.append(event)).rejects.toThrow()
    const [original] = await f.source.load()
    await f.source.close()
    await f.local.close()
    f.mirror.loseAck = false
    const source = new SignedJournal(join(f.directory, "source"), originalSecret, (input) =>
      sandboxToolEventSchema.parse(input)
    )
    const local = new SignedJournal<AuthorityEvent<JournalRecord<SandboxToolEvent>>>(
      join(f.directory, "independent"),
      secret,
      (input) => authorityEventSchema(z.custom<JournalRecord<SandboxToolEvent>>()).parse(input)
    )
    const independent = new IndependentAuthorityJournal({
      local,
      store: f.store,
      mirror: f.mirror,
      epochId: "epoch-1",
      supervisorInstanceId: "supervisor-1.tools",
      signingSecret: secret,
      payloadSchema: z.custom<JournalRecord<SandboxToolEvent>>(),
      authorize: async () => true,
    })
    const journal = new SandboxToolJournal(
      source,
      independent,
      originalSecret,
      "epoch-1",
      "supervisor-1.tools",
      "supervisor-1"
    )
    expect(
      await journal.recoverExactTail({ sequence: original!.sequence, hash: original!.hash })
    ).toEqual(original)
    expect(await journal.load()).toEqual([original])
    await source.close()
    await local.close()
  })

  it("rejects a fresh request while the same attempt has an unresolved original", async () => {
    const f = await setup()
    await f.journal.append(event)
    await expect(
      f.journal.append({
        ...event,
        tool: { ...event.tool, requestId: "request-2", commandId: "command-2" },
      })
    ).rejects.toThrow(/unresolved/)
    expect(await f.source.load()).toHaveLength(1)
    await f.source.close()
    await f.local.close()
  })
})
