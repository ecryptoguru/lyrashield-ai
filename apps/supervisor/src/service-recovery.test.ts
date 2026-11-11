import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  SignedJournal,
  sha256Hex,
  type AuthorityHead,
  type AuthorityMirror,
  type ConditionalObjectStore,
  type JournalRecord,
  type ResourceOwnership,
  type StoredObject,
  type SupervisorCommand,
  type SupervisorRecoveryRequest,
} from "@lyrashield/runtime-control"
import { createSupervisorAuthorityJournal } from "./authority-journal"
import { deriveOwnershipId } from "./executor"
import { createSupervisorHandler } from "./http"
import { SupervisorService } from "./service"

const roots: string[] = []
const closes: (() => Promise<void>)[] = []
const secret = "r".repeat(48)
const control = "c".repeat(48)
const instance = "supervisor-recovery-1"
const binding = {
  attemptId: "attempt-recovery-1",
  scanId: "scan-recovery-1",
  workspaceId: "workspace-recovery-1",
  operationId: "operation-recovery-1",
  authorityEpochId: "epoch-recovery-1",
  authorityRevision: 9,
  workerIdentity: "worker-recovery-1",
  billingMode: "UNMETERED" as const,
  expiresAt: "2026-11-11T20:00:00.000Z",
}
const prepare: Extract<SupervisorCommand, { type: "PREPARE" }> = {
  type: "PREPARE",
  commandId: "prepare-recovery-1",
  attempt: binding,
  executors: [
    {
      key: "scanner",
      spec: {
        kind: "container",
        image: "fixture@sha256:" + "a".repeat(64),
        argv: [],
        env: {},
        network: "fixture",
        cpus: 1,
        memoryMb: 64,
        pidsLimit: 16,
        readOnly: true,
        grantEnvName: "LLM_API_KEY",
      },
    },
  ],
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(closes.splice(0).map((close) => close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class Store implements ConditionalObjectStore {
  objects = new Map<string, StoredObject>()
  writes = 0
  loseOn: string | null = null
  loseHead = false
  unavailable = false
  onRecordWrite?: (type: string) => Promise<void>
  async read(key: string) {
    if (this.unavailable) throw new Error("independent store unavailable")
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
    )
      return "conflict" as const
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.writes}` })
    if (key.includes("/records/")) {
      const record = JSON.parse(Buffer.from(bytes).toString("utf8"))
      await this.onRecordWrite?.(record.record.payload.payload.payload.type)
      if (record.record.payload.payload.payload.type === this.loseOn) {
        this.loseOn = null
        throw new Error("record applied but response lost")
      }
    }
    if (key.endsWith("/head") && this.loseHead) {
      this.loseHead = false
      throw new Error("head applied but response lost")
    }
    return "written" as const
  }
}

class Mirror implements AuthorityMirror {
  head: AuthorityHead | null = null
  records = new Map<number, JournalRecord<unknown>>()
  writes = 0
  loseNext = false
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
    if (canonicalJson(previous) !== canonicalJson(this.head)) return "conflict" as const
    this.head = structuredClone(head)
    this.records.set(record.sequence, structuredClone(record))
    this.writes += 1
    if (this.loseNext) {
      this.loseNext = false
      throw new Error("database commit reply lost")
    }
    return "written" as const
  }
}

function selector(command: SupervisorCommand): SupervisorRecoveryRequest {
  return {
    epochId: binding.authorityEpochId,
    supervisorInstanceId: instance,
    workspaceId: binding.workspaceId,
    scanId: binding.scanId,
    operationId: binding.operationId,
    attemptId: binding.attemptId,
    commandId: command.commandId,
    expectedCommandHash: sha256Hex(canonicalJson(command)),
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "supervisor-service-recovery-"))
  roots.push(root)
  const store = new Store()
  const mirror = new Mirror()
  const authority = {
    stream: true,
    attempt: true,
    recovery: true,
    unavailable: false,
    calls: 0,
    revokeAt: 0,
  }
  const effects = { create: 0, start: 0, inspect: 0, stop: 0, provider: 0 }
  let clock = new Date("2026-11-11T10:00:00.000Z")
  const options = {
    originalPath: join(root, "original.jsonl"),
    independentPath: join(root, "wrapper.jsonl"),
    originalSigningSecret: secret,
    signingSecret: secret,
    epochId: binding.authorityEpochId,
    supervisorInstanceId: instance,
    store,
    mirror,
    authorize: async () => authority.attempt,
    authorizeStream: async () => authority.stream,
    authorizeRecovery: async (
      request: SupervisorRecoveryRequest,
      original: JournalRecord<unknown>,
      command: SupervisorCommand
    ) => {
      authority.calls += 1
      expect(request.expectedCommandHash).toBe(sha256Hex(canonicalJson(command)))
      expect(original.sequence).toBeGreaterThan(0)
      if (authority.unavailable) throw new Error("persisted recovery/grant authority unavailable")
      if (authority.calls === authority.revokeAt) {
        authority.attempt = false
        return false
      }
      return authority.recovery
    },
  }
  function create(admission: "closed" | "open" = "closed") {
    const factory = createSupervisorAuthorityJournal(options)
    closes.push(factory.close)
    const service = new SupervisorService({
      journal: factory.journal,
      admission,
      signingSecret: secret,
      supervisorInstanceId: instance,
      now: () => clock,
      providerGatewayUrl: "http://127.0.0.1:1",
      policy: {
        allowedImages: new Set([
          prepare.executors[0]!.spec.kind === "container" ? prepare.executors[0]!.spec.image : "",
        ]),
        allowedNetworks: new Set(["fixture"]),
        allowedProcessCommands: new Set(),
        allowedCwdRoots: [tmpdir()],
        allowedCgroupRoot: tmpdir(),
      },
      executor: {
        create: async (key, _spec, context) => {
          effects.create += 1
          return {
            executorKey: key,
            kind: "container",
            ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
            containerId: "a".repeat(64),
          }
        },
        start: async (ownership: ResourceOwnership) => {
          effects.start += 1
          return ownership
        },
        inspect: async () => {
          effects.inspect += 1
          return { state: "ABSENT" as const }
        },
        stop: async () => {
          effects.stop += 1
          return { state: "ABSENT" as const }
        },
      },
      providerGateway: {
        issueGrant: async () => {
          effects.provider += 1
          throw new Error("unexpected grant")
        },
        findGrantByRequest: async () => {
          effects.provider += 1
          return null
        },
        inspectGrant: async () => {
          effects.provider += 1
          return null
        },
        revokeGrant: async () => {
          effects.provider += 1
          throw new Error("unexpected revocation")
        },
      },
    })
    return { factory, service }
  }
  // Explicit fixture-only admission lets tests create the pre-existing history.
  const active = create("open")
  return {
    options,
    store,
    mirror,
    authority,
    effects,
    create,
    factory: active.factory,
    service: active.service,
    advance: () => {
      clock = new Date(clock.getTime() + 1)
    },
  }
}

describe("explicit supervisor same-operation recovery", () => {
  it.each([
    "workspaceId",
    "operationId",
    "attemptId",
    "commandId",
    "scanId",
    "epochId",
    "supervisorInstanceId",
    "expectedCommandHash",
  ])("preserves confirmed service startup and STOP after wrong %s selection", async (field) => {
    const f = await setup()
    const first = await f.service.execute(prepare)
    await f.service.execute({
      ...prepare,
      commandId: "prepare-mismatch-newer",
      attempt: {
        ...binding,
        attemptId: "attempt-mismatch-newer",
        operationId: "operation-mismatch-newer",
      },
    })
    const records = await f.factory.journal.load()
    expect(records).toHaveLength(4)
    const before = await Promise.all([
      readFile(f.options.originalPath, "utf8"),
      readFile(f.options.independentPath, "utf8"),
    ])
    const writes = [f.store.writes, f.mirror.writes]
    const request = {
      ...selector(prepare),
      [field]: field === "expectedCommandHash" ? "f".repeat(64) : "another-identity",
    }
    await expect(f.service.recover(request)).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" })
    expect(
      await Promise.all([
        readFile(f.options.originalPath, "utf8"),
        readFile(f.options.independentPath, "utf8"),
      ])
    ).toEqual(before)
    expect([f.store.writes, f.mirror.writes]).toEqual(writes)
    expect(await f.factory.journal.load()).toEqual(records)
    await f.service.initialize()
    expect((await f.service.getAttempt(binding.attemptId))?.status).toBe("PREPARED")
    expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    expect(
      (
        await f.service.execute({
          type: "STOP",
          commandId: "stop-after-wrong-selector",
          attemptId: binding.attemptId,
          expectedReceiptHash: first.receipt.hash,
        })
      ).status
    ).toBe("NEVER_DISPATCHED")
  })

  it.each(["pending", "stream", "attempt", "recovery", "unavailable"])(
    "does not restore startup or STOP after %s recovery uncertainty",
    async (failure) => {
      const f = await setup()
      const first = await f.service.execute(prepare)
      if (failure === "pending") {
        f.store.loseOn = "command_intent"
        await expect(
          f.service.execute({
            ...prepare,
            commandId: "prepare-pending-newer",
            attempt: {
              ...binding,
              attemptId: "attempt-pending-newer",
              operationId: "operation-pending-newer",
            },
          })
        ).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
      } else if (failure === "unavailable") f.authority.unavailable = true
      else f.authority[failure as "stream" | "attempt" | "recovery"] = false
      const before = await readFile(f.options.originalPath, "utf8")
      const request =
        failure === "pending"
          ? { ...selector(prepare), workspaceId: "wrong-workspace" }
          : selector(prepare)
      const code =
        failure === "pending"
          ? "RECOVERY_CONFLICT"
          : failure === "unavailable"
            ? "AUTHORITY_UNKNOWN"
            : "AUTHORITY_CONFLICT"
      await expect(f.service.recover(request)).rejects.toMatchObject({ code })
      expect(await readFile(f.options.originalPath, "utf8")).toBe(before)
      await expect(f.service.initialize()).rejects.toMatchObject({ code })
      await expect(
        f.service.execute({
          type: "STOP",
          commandId: "stop-after-uncertain-recovery",
          attemptId: binding.attemptId,
          expectedReceiptHash: first.receipt.hash,
        })
      ).rejects.toMatchObject({ code })
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
    }
  )

  it.each(["adapter", "service"])(
    "rejects stale %s recovery without writes or blocking STOP",
    async (owner) => {
      const f = await setup()
      const first = await f.service.execute(prepare)
      const newer: SupervisorCommand = {
        ...prepare,
        commandId: "prepare-newer",
        attempt: { ...binding, attemptId: "attempt-newer", operationId: "operation-newer" },
      }
      await f.service.execute(newer)
      const records = await f.factory.journal.load()
      expect(records).toHaveLength(4)
      const bytes = await Promise.all([
        readFile(f.options.originalPath, "utf8"),
        readFile(f.options.independentPath, "utf8"),
      ])
      const writes = [f.store.writes, f.mirror.writes]
      const recover =
        owner === "adapter"
          ? f.factory.journal.recoverStored(selector(prepare))
          : f.service.recover(selector(prepare))
      await expect(recover).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" })
      expect(
        await Promise.all([
          readFile(f.options.originalPath, "utf8"),
          readFile(f.options.independentPath, "utf8"),
        ])
      ).toEqual(bytes)
      expect([f.store.writes, f.mirror.writes]).toEqual(writes)
      expect(await f.factory.journal.load()).toEqual(records)
      expect((await f.service.getAttempt(binding.attemptId))?.status).toBe("PREPARED")
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
      const stopped = await f.service.execute({
        type: "STOP",
        commandId: "stop-after-stale-recovery",
        attemptId: binding.attemptId,
        expectedReceiptHash: first.receipt.hash,
      })
      expect(stopped.status).toBe("NEVER_DISPATCHED")
      expect(f.effects.create + f.effects.start).toBe(0)
    }
  )

  it("reuses an existing confirmed hold after newer unrelated confirmed history without writes", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const original = await f.service.recover(selector(prepare))
    await f.service.execute({
      ...prepare,
      commandId: "prepare-after-hold",
      attempt: { ...binding, attemptId: "attempt-after-hold", operationId: "operation-after-hold" },
    })
    const records = await f.factory.journal.load()
    const bytes = await readFile(f.options.originalPath, "utf8")
    const writes = [f.store.writes, f.mirror.writes]
    const recovered = await f.service.recover(selector(prepare))
    expect(recovered.holdRecord).toEqual(original.holdRecord)
    expect(recovered.recoveredRecord).toEqual(original.recoveredRecord)
    expect(recovered.command.status).toBe("UNKNOWN")
    expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
    expect([f.store.writes, f.mirror.writes]).toEqual(writes)
    expect(await f.factory.journal.load()).toEqual(records)
    expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
  })

  it.each(["R2", "database"])(
    "recovers an identical timed retry after a lost %s reply without effects",
    async (storage) => {
      const f = await setup()
      if (storage === "R2") f.store.loseOn = "command_intent"
      else f.mirror.loseNext = true
      await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
      const bytes = await readFile(f.options.originalPath, "utf8")
      const original = JSON.parse(bytes.trim())
      f.advance()
      await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" })
      const recovered = await f.service.recover(selector(prepare))
      expect(recovered.status).toBe("UNKNOWN")
      expect(recovered.recoveredRecord).toEqual(original)
      expect(recovered.holdRecord.payload.type).toBe("command_recovery_hold")
      expect((await f.service.execute(prepare)).status).toBe("UNKNOWN")
      const history = await f.factory.journal.load()
      expect(history).toHaveLength(2)
      expect(history[0]).toEqual(original)
      expect((await readFile(f.options.originalPath, "utf8")).startsWith(bytes)).toBe(true)
      expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
      const again = await f.service.recover(selector(prepare))
      expect(again.holdRecord).toEqual(recovered.holdRecord)
      expect(await f.factory.journal.load()).toHaveLength(2)
      expect(f.authority.calls).toBeGreaterThanOrEqual(6)
    }
  )

  it("recovers through authenticated HTTP while normal startup is rejected", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const bytes = await readFile(f.options.originalPath, "utf8")
    await f.factory.close()
    f.advance()
    const restarted = f.create()
    await expect(restarted.service.initialize()).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    const server = createServer(
      createSupervisorHandler(restarted.service, { controlToken: control, admission: "closed" })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const url = `http://127.0.0.1:${address.port}/v1/recovery`
    const body = JSON.stringify(selector(prepare))
    try {
      expect((await fetch(url, { method: "POST", body })).status).toBe(401)
      expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${control}`, "content-type": "application/json" },
        body,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: "UNKNOWN",
        command: { status: "UNKNOWN" },
      })
      expect((await restarted.service.execute(prepare)).status).toBe("UNKNOWN")
      await restarted.factory.close()
      const third = f.create()
      await third.service.initialize()
      expect((await third.service.execute(prepare)).status).toBe("UNKNOWN")
      expect((await third.service.getAttempt(binding.attemptId))?.status).toBe("UNKNOWN")
      expect((await readFile(f.options.originalPath, "utf8")).startsWith(bytes)).toBe(true)
      expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it("replays a lost recovery-hold acknowledgement with the same signed hold", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    f.store.loseOn = "command_recovery_hold"
    await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    const bytes = await readFile(f.options.originalPath, "utf8")
    const records = bytes
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const repaired = await f.service.recover(selector(prepare))
    expect(repaired.holdRecord).toEqual(records[1])
    expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
    expect((await f.service.execute(prepare)).status).toBe("UNKNOWN")
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })

  it.each(["resource_bound", "resource_started", "attempt_status", "command_terminal"])(
    "does not repeat effects after recovering pending %s",
    async (event) => {
      const f = await setup()
      const prepared = await f.service.execute(prepare)
      const start: SupervisorCommand = {
        type: "START_UNMETERED",
        commandId: "start-recovery-1",
        attemptId: binding.attemptId,
        executorKey: "scanner",
        expectedReceiptHash: prepared.receipt.hash,
      }
      f.store.loseOn = event
      await expect(f.service.execute(start)).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" })
      expect(f.effects.create).toBe(1)
      const counts = { ...f.effects }
      const recovered = await f.service.recover(selector(start))
      expect(recovered.command.status).toBe("UNKNOWN")
      expect((await f.service.execute(start)).status).toBe("UNKNOWN")
      expect(f.effects).toEqual(counts)
      expect((await f.service.getAttempt(binding.attemptId))?.status).toBe("UNKNOWN")
      await f.factory.close()
      const restarted = f.create()
      await restarted.service.initialize()
      expect((await restarted.service.execute(start)).status).toBe("UNKNOWN")
      expect(f.effects).toEqual(counts)
    }
  )

  it.each([
    "operationId",
    "attemptId",
    "workspaceId",
    "scanId",
    "commandId",
    "epochId",
    "supervisorInstanceId",
    "expectedCommandHash",
  ] as const)("rejects another %s without confirming or changing bytes", async (field) => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const bytes = await readFile(f.options.originalPath, "utf8")
    const request = {
      ...selector(prepare),
      [field]: field === "expectedCommandHash" ? "f".repeat(64) : "another-identity",
    }
    const writes = [f.store.writes, f.mirror.writes]
    await expect(f.service.recover(request)).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" })
    expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
    expect([f.store.writes, f.mirror.writes]).toEqual(writes)
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })

  it.each(["stream", "attempt", "recovery"] as const)(
    "holds revoked %s authority",
    async (scope) => {
      const f = await setup()
      f.store.loseOn = "command_intent"
      await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
      const bytes = await readFile(f.options.originalPath, "utf8")
      f.authority[scope] = false
      await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
        code: "AUTHORITY_CONFLICT",
      })
      expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
      expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
    }
  )

  it("keeps unavailable persisted grant/recovery authority UNKNOWN", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const bytes = await readFile(f.options.originalPath, "utf8")
    f.authority.unavailable = true
    await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })

  it("holds authority revoked after exact original confirmation", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const bytes = await readFile(f.options.originalPath, "utf8")
    f.authority.revokeAt = 2
    await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" })
    expect((await readFile(f.options.originalPath, "utf8")).startsWith(bytes)).toBe(true)
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
    await f.factory.close()
    await expect(f.create().service.initialize()).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
  })

  it("survives a lost hold commit reply and another actual journal reopen", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    f.store.onRecordWrite = async (type) => {
      if (type === "command_recovery_hold") f.mirror.loseNext = true
    }
    await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    const bytes = await readFile(f.options.originalPath, "utf8")
    await f.factory.close()
    const restarted = f.create()
    const result = await restarted.service.recover(selector(prepare))
    expect(result.command.status).toBe("UNKNOWN")
    expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
    expect(await restarted.factory.journal.load()).toHaveLength(2)
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })

  it.each(
    [
      "local-hold-before",
      "local-hold-ack",
      "local-original-confirm",
      "local-hold-confirm",
      "original-record",
      "original-head",
      "original-database",
      "hold-record",
      "hold-head",
      "hold-database",
    ].flatMap((boundary) =>
      ["attempt_prepared", "command_terminal"].map((event) => [event, boundary])
    )
  )("keeps a positive %s original closed across interrupted %s", async (event, boundary) => {
    const f = await setup()
    let command: SupervisorCommand = prepare
    if (event === "command_terminal") {
      const prepared = await f.service.execute(command)
      command = {
        type: "START_UNMETERED",
        commandId: "start-positive-recovery",
        attemptId: binding.attemptId,
        executorKey: "scanner",
        expectedReceiptHash: prepared.receipt.hash,
      }
    }
    const append = SignedJournal.prototype.append
    // Lose the wrapper's local append acknowledgement before any independent write.
    const first = vi.spyOn(SignedJournal.prototype, "append").mockImplementation(async function (
      this: SignedJournal<unknown>,
      payload
    ) {
      const record = await append.call(this, payload)
      const wrapper = payload as { payload?: { payload?: { type?: string } } }
      if (wrapper.payload?.payload?.type === event)
        throw new Error("wrapper applied but local acknowledgement lost")
      return record
    })
    await expect(f.service.execute(command)).rejects.toMatchObject({
      code: event === "attempt_prepared" ? "AUTHORITY_UNKNOWN" : "AUTHORITY_CONFLICT",
    })
    const effects = { ...f.effects }
    first.mockRestore()
    const originalBytes = await readFile(f.options.originalPath, "utf8")
    await f.factory.close()
    const recovering = f.create()
    await expect(recovering.service.initialize()).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    if (boundary.startsWith("local-hold-") && boundary !== "local-hold-confirm") {
      vi.spyOn(SignedJournal.prototype, "append").mockImplementation(async function (
        this: SignedJournal<unknown>,
        payload
      ) {
        const isHold = (payload as { type?: string }).type === "command_recovery_hold"
        if (isHold && boundary === "local-hold-before") throw new Error("local write interrupted")
        const record = await append.call(this, payload)
        if (isHold) throw new Error("local hold applied but acknowledgement lost")
        return record
      })
    } else if (boundary.startsWith("local-")) {
      const confirm = SignedJournal.prototype.confirmRecord
      vi.spyOn(SignedJournal.prototype, "confirmRecord").mockImplementation(async function (
        this: SignedJournal<unknown>,
        record
      ) {
        const confirmed = await confirm.call(this, record)
        const type = (record.payload as { type?: string }).type
        if (type === (boundary === "local-original-confirm" ? event : "command_recovery_hold"))
          throw new Error("fsync applied but confirmation interrupted")
        return confirmed
      })
    } else {
      f.store.onRecordWrite = async (type) => {
        const target = boundary.startsWith("original-") ? event : "command_recovery_hold"
        if (type !== target) return
        if (boundary.endsWith("-record")) f.store.loseOn = target
        if (boundary.endsWith("-head")) f.store.loseHead = true
        if (boundary.endsWith("-database")) f.mirror.loseNext = true
      }
    }
    await expect(recovering.service.recover(selector(command))).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    vi.restoreAllMocks()
    const interruptedBytes = await readFile(f.options.originalPath, "utf8")
    expect(interruptedBytes.startsWith(originalBytes)).toBe(true)
    if (boundary !== "local-hold-before")
      expect(interruptedBytes).toContain("command_recovery_hold")
    f.store.onRecordWrite = undefined
    await recovering.factory.close()
    const restarted = f.create()
    if (boundary === "hold-database") {
      // The commit is independently visible despite its lost reply; the durable hold is UNKNOWN.
      await restarted.service.initialize()
      expect((await restarted.service.execute(command)).status).toBe("UNKNOWN")
    } else {
      await expect(restarted.service.initialize()).rejects.toMatchObject({
        code: "REPLAY_REQUIRED",
      })
    }
    const result = await restarted.service.recover(selector(command))
    expect(result.command.status).toBe("UNKNOWN")
    expect(result.recoveredRecord.payload.type).toBe(event)
    const repairedBytes = await readFile(f.options.originalPath, "utf8")
    if (boundary !== "local-hold-before") expect(repairedBytes).toBe(interruptedBytes)
    await restarted.factory.close()
    const final = f.create()
    await final.service.initialize()
    expect((await final.service.execute(command)).status).toBe("UNKNOWN")
    expect((await final.service.getAttempt(binding.attemptId))?.status).toBe("UNKNOWN")
    expect(f.effects).toEqual(effects)
  })

  it("recovers only the linked two-record suffix after original and guard local reply loss", async () => {
    const f = await setup()
    const append = SignedJournal.prototype.append
    const first = vi.spyOn(SignedJournal.prototype, "append").mockImplementation(async function (
      this: SignedJournal<unknown>,
      payload
    ) {
      const record = await append.call(this, payload)
      if ((payload as { type?: string }).type === "attempt_prepared")
        throw new Error("original applied but local reply lost")
      return record
    })
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    first.mockRestore()
    await f.factory.close()
    const recovering = f.create()
    const confirm = SignedJournal.prototype.confirmRecord
    vi.spyOn(SignedJournal.prototype, "confirmRecord").mockImplementation(async function (
      this: SignedJournal<unknown>,
      record
    ) {
      const confirmed = await confirm.call(this, record)
      if ((record.payload as { type?: string }).type === "attempt_prepared")
        throw new Error("confirmation interrupted before wrapper append")
      return confirmed
    })
    await expect(recovering.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    vi.restoreAllMocks()
    const bytes = await readFile(f.options.originalPath, "utf8")
    expect(bytes.trim().split("\n")).toHaveLength(3)
    expect((await readFile(f.options.independentPath, "utf8")).trim().split("\n")).toHaveLength(1)
    await recovering.factory.close()
    const restarted = f.create()
    await expect(restarted.service.initialize()).rejects.toMatchObject({ code: "REPLAY_REQUIRED" })
    const result = await restarted.service.recover(selector(prepare))
    expect(result.command.status).toBe("UNKNOWN")
    expect(await readFile(f.options.originalPath, "utf8")).toBe(bytes)
    expect((await restarted.service.execute(prepare)).status).toBe("UNKNOWN")
    expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
  })

  it("rejects tampered originals without repair or effects", async () => {
    const f = await setup()
    f.store.loseOn = "command_intent"
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const bytes = await readFile(f.options.originalPath, "utf8")
    await writeFile(f.options.originalPath, bytes.replace("worker-recovery-1", "worker-recovery-2"))
    const writes = [f.store.writes, f.mirror.writes]
    await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_UNKNOWN",
    })
    expect([f.store.writes, f.mirror.writes]).toEqual(writes)
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })

  it.each([
    "expectedCommandHash",
    "commandId",
    "attemptId",
    "supervisorInstanceId",
    "recoveredHash",
    "recoveredSequence",
    "observedAt",
  ])("rejects an authentically signed but mismatched two-record recovery %s", async (field) => {
    const f = await setup()
    const append = SignedJournal.prototype.append
    const first = vi.spyOn(SignedJournal.prototype, "append").mockImplementation(async function (
      this: SignedJournal<unknown>,
      payload
    ) {
      const record = await append.call(this, payload)
      if ((payload as { type?: string }).type === "attempt_prepared")
        throw new Error("original local reply lost")
      return record
    })
    await expect(f.service.execute(prepare)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    first.mockRestore()
    await f.factory.close()
    const recovering = f.create()
    vi.spyOn(SignedJournal.prototype, "append").mockImplementation(async function (
      this: SignedJournal<unknown>,
      payload
    ) {
      const event = payload as { type?: string; recoveredSequence?: number }
      const changed =
        event.type === "command_recovery_hold"
          ? {
              ...event,
              [field]:
                field === "recoveredSequence"
                  ? event.recoveredSequence! + 1
                  : field === "observedAt"
                    ? "2026-11-11T10:00:00.001Z"
                    : field.endsWith("Hash")
                      ? "f".repeat(64)
                      : "another-identity",
            }
          : payload
      return append.call(this, changed)
    })
    await expect(recovering.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
    vi.restoreAllMocks()
    await recovering.factory.close()
    await expect(f.create().service.initialize()).rejects.toMatchObject({
      code: "AUTHORITY_CONFLICT",
    })
    expect(f.effects).toEqual({ create: 0, start: 0, inspect: 0, stop: 0, provider: 0 })
  })

  it("rejects recovery while an executor command is still in flight", async () => {
    const f = await setup()
    const prepared = await f.service.execute(prepare)
    const start: SupervisorCommand = {
      type: "START_UNMETERED",
      commandId: "start-recovery-busy",
      attemptId: binding.attemptId,
      executorKey: "scanner",
      expectedReceiptHash: prepared.receipt.hash,
    }
    let entered!: () => void
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    f.store.onRecordWrite = async (type) => {
      if (type === "resource_create_planned") {
        entered()
        await held
      }
    }
    const running = f.service.execute(start)
    await writing
    try {
      await expect(f.service.recover(selector(start))).rejects.toMatchObject({
        code: "RECOVERY_BUSY",
      })
      expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
    } finally {
      release()
    }
    expect((await running).status).toBe("STARTED")
    expect(f.effects.create).toBe(1)
    expect(f.effects.start).toBe(1)
  })

  it("rejects caller content and legacy unbound pending status", async () => {
    const f = await setup()
    const prepared = await f.service.execute(prepare)
    await expect(
      f.service.recover({ ...selector(prepare), observedAt: "2026-11-11T11:00:00.000Z" })
    ).rejects.toMatchObject({ code: "INVALID_RECOVERY" })
    f.store.loseOn = "attempt_status"
    await expect(
      f.factory.journal.append({
        type: "attempt_status",
        supervisorInstanceId: instance,
        observedAt: "2026-11-11T10:00:00.000Z",
        attemptId: binding.attemptId,
        status: "UNKNOWN",
      })
    ).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    await expect(f.service.recover(selector(prepare))).rejects.toMatchObject({
      code: "RECOVERY_CONFLICT",
    })
    expect(prepared.status).toBe("PREPARED")
    expect(f.effects.create + f.effects.start + f.effects.provider).toBe(0)
  })
})
