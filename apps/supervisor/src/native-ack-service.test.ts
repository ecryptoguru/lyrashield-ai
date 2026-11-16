import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SignedJournal,
  canonicalJson,
  sha256Hex,
  parseNativeRemovalProof,
  type ExecutorKey,
  type ExecutorSpec,
  type ResourceInspection,
  type ResourceOwnership,
  type ScanAuthorityFence,
  type SupervisorPort,
} from "@lyrashield/runtime-control"
import {
  deriveOwnershipId,
  type ExecutorContext,
  type NativeRetirement,
  type RuntimeExecutor,
} from "./executor"
import { SupervisorService, supervisorJournalEventSchema } from "./service"
import { restoreJournalState } from "./restore-state"
import { encodeSealedAttempts, validateSealedRecoverySnapshot } from "./sealed-recovery"
import { decodeSealedAttempts } from "./sealed-recovery-load"
import { sealedRecoverySchema } from "./sealed-recovery-schema"
import type { AttemptState, CommandState } from "./journal-events"
import { createSandboxToolStartAcknowledger } from "./sandbox-tool-start-ack"
import { sandboxToolExecChecksum, type SandboxToolExecScope } from "./sandbox-tool-exec"
import type { AuthorityAction } from "@lyrashield/runtime-control"

const directories: string[] = []
const secret = "s".repeat(48)
const now = new Date("2026-11-13T00:00:00.000Z")
const image = `fixture@sha256:${"a".repeat(64)}`
const fence: ScanAuthorityFence = {
  run: async (binding, effect) => effect(() => undefined, { guardId: `guard-${binding.phase}` }),
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class Executor implements RuntimeExecutor {
  ownership?: ResourceOwnership
  running = false
  wrongInspection = false
  loseCreateAck = false
  removalProof?: unknown
  loseStartAck = false
  loseRemovalAck = false
  async create(key: ExecutorKey, _spec: ExecutorSpec, context: ExecutorContext) {
    const ownership: ResourceOwnership = {
      executorKey: key,
      kind: "container",
      ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
      containerId: "b".repeat(64),
      createdAt: now.toISOString(),
    }
    this.ownership = ownership
    if (this.loseCreateAck) throw new Error("create acknowledgement was lost")
    await context.nativeInvocation?.acknowledge({
      operation: "CONTAINER_CREATE_ACK",
      nativeRequestId: context.nativeInvocation.requestId,
      inspection: {
        state: "PRESENT",
        running: false,
        ownership: this.wrongInspection
          ? { ...ownership, ownershipId: `own_${"c".repeat(40)}` }
          : ownership,
      },
    })
    return ownership
  }
  async start(ownership: ResourceOwnership, _spec: ExecutorSpec, context: ExecutorContext) {
    this.running = true
    if (this.loseStartAck) throw new Error("start acknowledgement was lost")
    await context.nativeInvocation?.acknowledge({
      operation: "CONTAINER_START_ACK",
      nativeRequestId: context.nativeInvocation.requestId,
      inspection: { state: "PRESENT", running: true, ownership },
    })
    return ownership
  }
  async inspect(): Promise<ResourceInspection> {
    return this.ownership
      ? { state: "PRESENT", running: this.running, ownership: this.ownership }
      : { state: "ABSENT" }
  }
  async stop(
    ownership: ResourceOwnership,
    _graceMs?: number,
    retirement?: NativeRetirement
  ): Promise<ResourceInspection> {
    this.ownership = undefined
    const inspection = { state: "ABSENT" as const }
    if (!this.loseRemovalAck)
      await retirement?.acknowledge({
        ownership: this.removalProof
          ? parseNativeRemovalProof(this.removalProof).ownership
          : ownership,
        inspection,
        ...(this.removalProof ? { nativeRemovalProof: this.removalProof } : {}),
      })
    return inspection
  }
}

async function setup(executor = new Executor(), authorityFence = fence) {
  const directory = await mkdtemp(join(tmpdir(), "native-ack-service-"))
  directories.push(directory)
  const path = join(directory, "source.jsonl")
  const journal = new SignedJournal(path, secret, (value) =>
    supervisorJournalEventSchema.parse(value)
  )
  const gateway = undefined as unknown as SupervisorPort
  const makeService = (
    port: typeof journal,
    cleanupRuntime?: {
      now: () => Date
      authorityFence: ScanAuthorityFence
      admission?: "open" | "closed"
    }
  ) =>
    new SupervisorService({
      journal: port,
      executor,
      providerGateway: gateway,
      providerGatewayUrl: "http://127.0.0.1:8791",
      authorityFence: cleanupRuntime?.authorityFence ?? authorityFence,
      signingSecret: secret,
      supervisorInstanceId: "supervisor-test-1",
      admission: cleanupRuntime ? (cleanupRuntime.admission ?? "closed") : "open",
      policy: {
        allowedImages: new Set([image]),
        allowedNetworks: new Set(["none"]),
        allowedProcessCommands: new Set(),
        allowedCwdRoots: [],
        allowedCgroupRoot: "/sys/fs/cgroup",
      },
      now: cleanupRuntime?.now ?? (() => now),
    })
  return { journal, path, executor, service: makeService(journal), makeService }
}
const prepare = {
  type: "PREPARE" as const,
  commandId: "prepare-1",
  attempt: {
    attemptId: "attempt-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    operationId: "operation-1",
    authorityEpochId: "epoch-1",
    authorityRevision: 1,
    workerIdentity: "worker-1",
    billingMode: "UNMETERED" as const,
    expiresAt: "2026-11-13T01:00:00.000Z",
  },
  executors: [
    {
      key: "engine" as const,
      spec: {
        kind: "container" as const,
        image,
        argv: ["sleep", "60"],
        env: {},
        network: "none",
        cpus: 1,
        memoryMb: 128,
        pidsLimit: 32,
        readOnly: true,
        grantEnvName: "LLM_API_KEY",
      },
    },
  ],
}

describe("main signed native acknowledgement production", () => {
  async function sandboxStarted(twoExecutors = false, authorityFence = fence) {
    const f = await setup(new Executor(), authorityFence)
    const sandboxPrepare = {
      ...prepare,
      executors: [
        { ...prepare.executors[0]!, key: "sandbox" as const },
        ...(twoExecutors ? prepare.executors : []),
      ],
    }
    const prepared = await f.service.execute(sandboxPrepare)
    expect(
      (
        await f.service.execute({
          type: "START_UNMETERED",
          commandId: "sandbox-start-1",
          attemptId: "attempt-1",
          executorKey: "sandbox",
          expectedReceiptHash: prepared.receipt.hash,
        })
      ).status
    ).toBe("STARTED")
    const ownership = f.executor.ownership!
    const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
    const request = {
      binding: {
        attemptId: "attempt-1",
        operationId: "operation-1",
        authorityEpochId: "epoch-1",
        sandboxHandle: ownership.ownershipId,
      },
      requestId,
      commandId: requestId,
      argv: ["true"],
      cwd: "/workspace",
      user: "pentester" as const,
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
    }
    const action: AuthorityAction = {
      phase: "SANDBOX_TOOL",
      operationId: "operation-1",
      attemptId: "attempt-1",
      authorityEpochId: "epoch-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      authorityRevision: 1,
      authorityChecksum: sha256Hex(
        canonicalJson({
          attempt: sandboxPrepare.attempt,
          executors: sandboxPrepare.executors,
          provider: null,
        })
      ),
      actionChecksum: "0".repeat(64),
      commandId: sandboxPrepare.commandId,
      executorKey: "sandbox",
      requestId,
    }
    const scope: SandboxToolExecScope = {
      action,
      ownership,
      workspaceRoot: "/workspace",
      supervisorInstanceId: "supervisor-test-1.tools",
    }
    action.actionChecksum = sandboxToolExecChecksum(request, scope)
    const record = createSandboxToolStartAcknowledger({
      journal: { append: (event) => f.service.recordSandboxNativeStart(event) },
      supervisorInstanceId: "supervisor-test-1",
      prepareCommandInputChecksum: sha256Hex(canonicalJson(sandboxPrepare)),
      inspect: async () => ({ state: "PRESENT", running: true, ownership }),
      assertActive: () => undefined,
    })
    return {
      ...f,
      record,
      input: {
        action,
        descriptor: {
          schema: "lyrashield-sandbox-tool-exec/1" as const,
          request,
          workspaceRoot: "/workspace",
          ownership,
        },
        guardId: "guard-tool-1",
        execId: "e".repeat(64),
      },
    }
  }

  it("applies a durably signed tool start immediately and rejects duplicate guards before appending", async () => {
    const f = await sandboxStarted()
    await f.record(f.input)
    const before = await f.journal.load()
    await expect(f.record(f.input)).rejects.toThrow("sandbox invocation acknowledgement differs")
    expect((await f.journal.load()).length).toBe(before.length)
    expect(before.at(-1)?.payload).toMatchObject({
      nativeOperation: "SANDBOX_TOOL_START_ACK",
      guardId: "guard-tool-1",
    })
  })

  it("records the native tool fact while a queued lifecycle command waits for the held native gate", async () => {
    let block = false,
      unblock: () => void = () => undefined,
      waiting: () => void = () => undefined,
      guards = 0
    const entered = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const released = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const authorityFence: ScanAuthorityFence = {
      run: async (_binding, effect) => {
        if (block) {
          waiting()
          await released
        }
        return effect(() => undefined, { guardId: `native-guard-${++guards}` })
      },
    }
    const f = await sandboxStarted(true, authorityFence)
    block = true
    const expectedReceiptHash = (await f.service.getAttempt("attempt-1")).receipt.hash
    const queued = f.service.execute({
      type: "START_UNMETERED",
      commandId: "engine-start-1",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash,
    })
    await entered
    try {
      await Promise.race([
        f.record(f.input),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("tool ACK joined blocked service queue")), 1000)
        ),
      ])
      expect(
        (await f.journal.load()).some(
          (record) =>
            record.payload.type === "native_invocation_ack" &&
            record.payload.nativeOperation === "SANDBOX_TOOL_START_ACK"
        )
      ).toBe(true)
    } finally {
      unblock()
    }
    await queued
  })
  it("preserves the original create proof and unresolved native start intent in a checkpoint", async () => {
    const executor = new Executor()
    executor.loseStartAck = true
    const f = await setup(executor)
    const prepared = await f.service.execute(prepare)
    await f.service.execute({
      type: "START_UNMETERED",
      commandId: "start-1",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    const records = await f.journal.load()
    const attempts = new Map<string, AttemptState>(),
      commands = new Map<string, CommandState>()
    restoreJournalState(records, attempts, commands)
    const raw = {
      schema: "lyrashield-supervisor-recovery-snapshot/1",
      epochId: "epoch-1",
      supervisorInstanceId: "supervisor-test-1",
      sequence: records.length,
      originalHash: records.at(-1)!.hash,
      wrapperHash: "a".repeat(64),
      attempts: encodeSealedAttempts(attempts),
      commands: [...commands.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, state]) => ({ id, state })),
    }
    const snapshot = sealedRecoverySchema.parse(raw)
    validateSealedRecoverySnapshot(snapshot)
    const prior = attempts.get("attempt-1")!
    const restored = decodeSealedAttempts(snapshot).get("attempt-1")!
    expect(restored.nativeCreateProofs?.get("engine")).toEqual(
      prior.nativeCreateProofs?.get("engine")
    )
    expect(restored.nativeStartIntents?.get("engine")).toEqual(
      prior.nativeStartIntents?.get("engine")
    )
    expect(restored.nativeStartIntents?.get("engine")?.guardId).toBe("guard-EXECUTOR_START")
    expect(restored.nativeAckGuards).toEqual(prior.nativeAckGuards)
    const missing = structuredClone(raw)
    delete (missing.attempts[0]!.state as Partial<(typeof missing.attempts)[0]["state"]>)
      .nativeStartIntents
    expect(() => sealedRecoverySchema.parse(missing)).toThrow()
    await f.journal.close()
  })
  it("removes the created resource after START is denied before its native guard", async () => {
    let startInvocations = 0
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, effect) => {
        if (binding.phase === "EXECUTOR_START") throw new Error("START authority denied")
        return effect(() => undefined, { guardId: `guard-${binding.phase}` })
      },
    }
    const executor = new Executor()
    const start = executor.start.bind(executor)
    executor.start = async (...args) => {
      startInvocations++
      return start(...args)
    }
    const f = await setup(executor, authorityFence)
    const prepared = await f.service.execute(prepare)
    const rejected = await f.service.execute({
      type: "START_UNMETERED",
      commandId: "start-1",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(rejected.status).toBe("UNKNOWN")
    expect(startInvocations).toBe(0)
    const events = (await f.journal.load()).map((record) => record.payload)
    expect(events.some((event) => event.type === "resource_start_planned")).toBe(false)
    expect(
      events.some(
        (event) =>
          event.type === "native_invocation_planned" && event.guardId === "guard-EXECUTOR_START"
      )
    ).toBe(false)
    expect(events.filter((event) => event.type === "native_invocation_ack")).toHaveLength(1)
    const stopped = await f.service.execute({
      type: "STOP",
      commandId: "stop-1",
      attemptId: "attempt-1",
      expectedReceiptHash: rejected.receipt.hash,
    })
    expect(stopped.status).toBe("STOPPED")
    expect(await executor.inspect()).toEqual({ state: "ABSENT" })
    const final = (await f.journal.load()).map((record) => record.payload)
    expect(final.filter((event) => event.type === "native_invocation_ack")).toHaveLength(1)
    expect(final.some((event) => event.type === "native_invocation_retired")).toBe(false)
    await f.journal.close()
  })
  it("records PREPARE and fresh CREATE/START proof with exact independent guard identities", async () => {
    const f = await setup()
    const prepared = await f.service.execute(prepare)
    const started = await f.service.execute({
      type: "START_UNMETERED",
      commandId: "start-1",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(started.status).toBe("STARTED")
    const events = (await f.journal.load()).map((record) => record.payload)
    const prepareProof = events.find((event) => event.type === "prepare_invocation_completed")
    expect(prepareProof).toMatchObject({ guardId: "guard-PREPARE", commandId: "prepare-1" })
    const native = events.filter((event) => event.type === "native_invocation_ack")
    expect(native).toHaveLength(2)
    expect(native[0]).toMatchObject({
      guardId: "guard-EXECUTOR_CREATE",
      nativeOperation: "CONTAINER_CREATE_ACK",
      inspection: { state: "PRESENT", running: false },
    })
    expect(native[1]).toMatchObject({
      guardId: "guard-EXECUTOR_START",
      nativeOperation: "CONTAINER_START_ACK",
      inspection: { state: "PRESENT", running: true },
    })
    await f.journal.close()
    const recovered = new SignedJournal(f.path, secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    expect((await f.makeService(recovered).getAttempt("attempt-1")).status).toBe("RUNNING")
    await recovered.close()
  })

  it("does not sign an ACK for foreign derived ownership", async () => {
    const executor = new Executor()
    executor.wrongInspection = true
    const f = await setup(executor)
    const prepared = await f.service.execute(prepare)
    const result = await f.service.execute({
      type: "START_UNMETERED",
      commandId: "start-1",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(result.status).not.toBe("STARTED")
    expect(
      (await f.journal.load()).filter((record) => record.payload.type === "native_invocation_ack")
    ).toHaveLength(0)
    await f.journal.close()
  })

  it.each([false, true])(
    "retires lost CREATE ACK only with its original root removal receipt (lost=%s)",
    async (lost) => {
      const executor = new Executor()
      executor.loseCreateAck = true
      executor.loseRemovalAck = lost
      const f = await setup(executor)
      const prepared = await f.service.execute(prepare)
      const start = await f.service.execute({
        type: "START_UNMETERED",
        commandId: "start-1",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      expect(start.status).toBe("UNKNOWN")
      const plan = (await f.journal.load())
        .map((record) => record.payload)
        .find(
          (event) => event.type === "native_invocation_planned" && event.phase === "EXECUTOR_CREATE"
        )!
      if (plan.type !== "native_invocation_planned") throw new Error("original create plan missing")
      const body = {
        schema: "lyrashield-native-removal/1",
        phase: "EXECUTOR_CREATE",
        guardId: plan.guardId,
        nativeRequestId: plan.nativeRequestId,
        commandId: plan.commandId,
        stopCommandId: "stop-1",
        operationId: plan.operationId,
        attemptId: plan.attemptId,
        authorityEpochId: plan.authorityEpochId,
        bindingInputChecksum: plan.bindingInputChecksum,
        actionChecksum: plan.actionChecksum,
        ownership: executor.ownership!,
        inspection: { state: "ABSENT" },
      }
      executor.removalProof = { ...body, receiptSha256: sha256Hex(canonicalJson(body)) }
      const stop = await f.service.execute({
        type: "STOP",
        commandId: "stop-1",
        attemptId: "attempt-1",
        expectedReceiptHash: start.receipt.hash,
      })
      expect(stop.status).toBe(lost ? "UNKNOWN" : "STOPPED")
      if (lost) {
        executor.loseRemovalAck = false
        const cleanup = f.makeService(f.journal, {
          now: () => new Date("2026-11-13T02:00:00.000Z"),
          authorityFence: {
            run: async () => {
              throw new Error("Current execution authority revoked")
            },
          },
        })
        const reconciled = await cleanup.execute({
          type: "RECONCILE",
          commandId: "reconcile-1",
          attemptId: "attempt-1",
          expectedReceiptHash: stop.receipt.hash,
        })
        expect(reconciled.status).toBe("STOPPED")
        await expect(
          cleanup.execute({
            type: "START_PAID",
            commandId: "forbidden-paid-replay",
            attemptId: "attempt-1",
            executorKey: "engine",
            expectedReceiptHash: reconciled.receipt.hash,
          })
        ).rejects.toMatchObject({ code: "ADMISSION_CLOSED" })
      }
      const events = (await f.journal.load()).map((record) => record.payload)
      expect(events.filter((event) => event.type === "native_invocation_ack")).toHaveLength(0)
      expect(events.filter((event) => event.type === "native_invocation_retired")).toHaveLength(1)
      const attempts = new Map<string, AttemptState>(),
        commands = new Map<string, CommandState>()
      restoreJournalState(await f.journal.load(), attempts, commands)
      expect(commands.get("start-1")?.status).toBe("UNKNOWN")
      expect(attempts.get("attempt-1")?.createAcknowledged.has("engine")).toBe(false)
      expect(attempts.get("attempt-1")?.nativeRetirements?.has("engine") ?? false).toBe(true)
      await f.journal.close()
    }
  )

  it.each([false, true])(
    "resolves an uncertain original start only with its removal acknowledgement (lost=%s)",
    async (lost) => {
      const executor = new Executor()
      executor.loseStartAck = true
      executor.loseRemovalAck = lost
      const f = await setup(executor)
      const prepared = await f.service.execute(prepare)
      const started = await f.service.execute({
        type: "START_UNMETERED",
        commandId: "start-1",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      expect(started.status).toBe("UNKNOWN")
      const stopped = await f.service.execute({
        type: "STOP",
        commandId: "stop-1",
        attemptId: "attempt-1",
        expectedReceiptHash: started.receipt.hash,
      })
      expect(stopped.status).toBe(lost ? "UNKNOWN" : "STOPPED")
      const events = (await f.journal.load()).map((record) => record.payload)
      expect(events.filter((event) => event.type === "native_invocation_planned")).toHaveLength(2)
      const retired = events.filter((event) => event.type === "native_invocation_retired")
      expect(retired).toHaveLength(lost ? 0 : 1)
      if (!lost)
        expect(retired[0]).toMatchObject({
          commandId: "start-1",
          stopCommandId: "stop-1",
          guardId: "guard-EXECUTOR_START",
          nativeOperation: "CONTAINER_REMOVED",
          inspection: { state: "ABSENT" },
        })
      await f.journal.close()
      const recovered = new SignedJournal(f.path, secret, (value) =>
        supervisorJournalEventSchema.parse(value)
      )
      expect((await f.makeService(recovered).getAttempt("attempt-1")).status).toBe(
        lost ? "UNKNOWN" : "STOPPED"
      )
      await recovered.close()
    }
  )

  it("reconciles an authentic stopped attempt with its retained STOP after authority expires", async () => {
    const executor = new Executor()
    executor.loseStartAck = true
    const f = await setup(executor)
    const prepared = await f.service.execute(prepare)
    const started = await f.service.execute({
      type: "START_UNMETERED",
      commandId: "start-1",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(started.status).toBe("UNKNOWN")
    const stopped = await f.service.execute({
      type: "STOP",
      commandId: "stop-1",
      attemptId: "attempt-1",
      expectedReceiptHash: started.receipt.hash,
    })
    expect(stopped.status).toBe("STOPPED")
    const before = await f.journal.load()
    const cleanup = f.makeService(f.journal, {
      admission: "open",
      now: () => new Date("2026-11-13T02:00:00.000Z"),
      authorityFence: {
        run: async () => {
          throw new Error("Current execution authority revoked")
        },
      },
    })
    const reconcile = {
      type: "RECONCILE",
      commandId: "reconcile-stopped-1",
      attemptId: "attempt-1",
      expectedReceiptHash: stopped.receipt.hash,
    }
    const reconciled = await cleanup.execute(reconcile)
    expect(reconciled.status).toBe("STOPPED")
    expect(await cleanup.execute(reconcile)).toEqual(reconciled)
    await expect(
      cleanup.execute({
        type: "START_UNMETERED",
        commandId: "forbidden-start-after-stop",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: reconciled.receipt.hash,
      })
    ).rejects.toThrow()
    const after = await f.journal.load()
    expect(after.filter(({ payload }) => payload.type === "native_invocation_planned")).toEqual(
      before.filter(({ payload }) => payload.type === "native_invocation_planned")
    )
    expect(after.at(-1)?.payload).toMatchObject({
      type: "command_terminal",
      commandId: reconcile.commandId,
      attemptId: "attempt-1",
      status: "STOPPED",
    })
    await f.journal.close()
  })
})
