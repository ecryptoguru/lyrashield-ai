import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SignedJournal,
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
    if (!this.loseRemovalAck) await retirement?.acknowledge({ ownership, inspection })
    return inspection
  }
}

async function setup(executor = new Executor()) {
  const directory = await mkdtemp(join(tmpdir(), "native-ack-service-"))
  directories.push(directory)
  const path = join(directory, "source.jsonl")
  const journal = new SignedJournal(path, secret, (value) =>
    supervisorJournalEventSchema.parse(value)
  )
  const gateway = undefined as unknown as SupervisorPort
  const makeService = (port: typeof journal) =>
    new SupervisorService({
      journal: port,
      executor,
      providerGateway: gateway,
      providerGatewayUrl: "http://127.0.0.1:8791",
      authorityFence: fence,
      signingSecret: secret,
      supervisorInstanceId: "supervisor-test-1",
      admission: "open",
      policy: {
        allowedImages: new Set([image]),
        allowedNetworks: new Set(["none"]),
        allowedProcessCommands: new Set(),
        allowedCwdRoots: [],
        allowedCgroupRoot: "/sys/fs/cgroup",
      },
      now: () => now,
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
      expect(stopped.status).toBe("UNKNOWN")
      const events = (await f.journal.load()).map((record) => record.payload)
      expect(events.filter((event) => event.type === "native_invocation_planned")).toHaveLength(1)
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
      expect((await f.makeService(recovered).getAttempt("attempt-1")).status).toBe("UNKNOWN")
      await recovered.close()
    }
  )
})
