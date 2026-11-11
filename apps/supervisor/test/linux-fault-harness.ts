import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SignedJournal,
  type JournalPort,
  type ProviderGrant,
  type ProviderGrantRequest,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
  type ResourceInspection,
  type ResourceOwnership,
  type SupervisorPort,
} from "@lyrashield/runtime-control"
import { deriveOwnershipId, LinuxProcessExecutor, type RuntimeExecutor } from "../src/executor"
import {
  SupervisorService,
  supervisorJournalEventSchema,
  type SupervisorJournalEvent,
} from "../src/service"

const secret = "f".repeat(48)
const cgroupRoot = process.argv[2]
if (!cgroupRoot) throw new Error("cgroup root argument is required")

type ContainerState = {
  present: boolean
  createCalls: number
  startCalls: number
  stopCalls: number
}

class FileContainerExecutor implements RuntimeExecutor {
  statePath = ""
  delayMs = 0
  throwAfterCreate = false

  async initialize(root: string): Promise<void> {
    this.statePath = join(root, "container-state.json")
  }

  async create(
    key: Parameters<RuntimeExecutor["create"]>[0],
    _spec: Parameters<RuntimeExecutor["create"]>[1],
    context: Parameters<RuntimeExecutor["create"]>[2]
  ): Promise<ResourceOwnership> {
    const state = await this.state()
    state.createCalls += 1
    await this.save(state)
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    state.present = true
    await this.save(state)
    if (this.throwAfterCreate) throw new Error("daemon response lost after create")
    return {
      executorKey: key,
      kind: "container",
      ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
      containerId: "a".repeat(64),
      createdAt: new Date().toISOString(),
    }
  }

  async start(ownership: ResourceOwnership): Promise<ResourceOwnership> {
    const state = await this.state()
    state.startCalls += 1
    await this.save(state)
    return ownership
  }

  async inspect(ownership: ResourceOwnership): Promise<ResourceInspection> {
    const state = await this.state()
    return state.present
      ? {
          state: "PRESENT",
          running: true,
          ownership: { ...ownership, containerId: "a".repeat(64) },
        }
      : { state: "ABSENT" }
  }

  async stop(): Promise<ResourceInspection> {
    const state = await this.state()
    state.stopCalls += 1
    state.present = false
    await this.save(state)
    return { state: "ABSENT" }
  }

  async read(): Promise<ContainerState> {
    return this.state()
  }

  private async state(): Promise<ContainerState> {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8")) as ContainerState
    } catch {
      return { present: false, createCalls: 0, startCalls: 0, stopCalls: 0 }
    }
  }

  private async save(value: ContainerState): Promise<void> {
    await writeFile(this.statePath, JSON.stringify(value), "utf8")
  }
}

class HarnessGateway implements SupervisorPort {
  revokeCalls = 0
  unavailable = false
  grant: ProviderGrant | null = null
  revokedAt: string | null = null

  async issueGrant(request: ProviderGrantRequest): Promise<ProviderGrant> {
    this.grant = {
      grantId: "pg_harness",
      token: "g".repeat(64),
      attemptId: request.attemptId,
      providerId: request.providerId,
      expiresAt: request.expiresAt,
      receipt: "1".repeat(64),
    }
    return this.grant
  }

  async findGrantByRequest(): Promise<ProviderGrant | null> {
    return this.grant
  }

  async revokeGrant(request: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
    this.revokeCalls += 1
    if (this.unavailable) throw new Error("provider gateway unavailable")
    this.revokedAt = new Date().toISOString()
    return {
      grantId: request.grantId,
      attemptId: request.attemptId,
      providerId: "azure-ai",
      expiresAt: this.grant?.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
      revokedAt: this.revokedAt,
      requestCount: 0,
      reservedCostMicros: 0,
      receipt: "2".repeat(64),
    }
  }

  async inspectGrant(): Promise<ProviderGrantStatus | null> {
    if (!this.grant) return null
    return {
      grantId: this.grant.grantId,
      attemptId: this.grant.attemptId,
      providerId: this.grant.providerId,
      expiresAt: this.grant.expiresAt,
      revokedAt: this.revokedAt,
      requestCount: 0,
      reservedCostMicros: 0,
      receipt: "2".repeat(64),
    }
  }
}

function command(attempt = "attempt-fault", commandId = "prepare-fault") {
  return {
    type: "PREPARE" as const,
    commandId,
    attempt: {
      attemptId: attempt,
      scanId: "scan-fault",
      workspaceId: "workspace-fault",
      operationId: "operation-fault",
      authorityEpochId: "epoch-fault",
      authorityRevision: 1,
      workerIdentity: "linux-harness",
      billingMode: "PAID" as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    executors: [
      {
        key: "engine" as const,
        spec: {
          kind: "container" as const,
          image: "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "a".repeat(64),
          argv: ["lyrashield", "--non-interactive"],
          env: {},
          network: "lyrashield-sandbox",
          cpus: 2,
          memoryMb: 4096,
          pidsLimit: 512,
          readOnly: true,
          grantEnvName: "LLM_API_KEY",
        },
      },
    ],
    provider: {
      providerId: "azure-ai",
      maxRequests: 10,
      costReservationMicros: 1,
      maxReservedCostMicros: 100,
    },
  }
}

function service(
  journal: JournalPort<SupervisorJournalEvent>,
  executor: RuntimeExecutor,
  gateway: HarnessGateway
) {
  return new SupervisorService({
    journal,
    executor,
    providerGateway: gateway,
    providerGatewayUrl: "http://127.0.0.1:8791",
    signingSecret: secret,
    supervisorInstanceId: "supervisor-fault-1",
    admission: "open",
    policy: {
      allowedImages: new Set(["ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "a".repeat(64)]),
      allowedNetworks: new Set(["lyrashield-sandbox"]),
      allowedProcessCommands: new Set(["/bin/sh"]),
      allowedCwdRoots: [tmpdir(), "/tmp"],
      allowedCgroupRoot: cgroupRoot,
    },
  })
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "supervisor-linux-faults-"))
  try {
    const journalPath = join(root, "journal.jsonl")
    const journal = new SignedJournal(journalPath, secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    const executor = new FileContainerExecutor()
    await executor.initialize(root)
    executor.delayMs = 30
    executor.throwAfterCreate = true
    const gateway = new HarnessGateway()
    const first = service(journal, executor, gateway)
    const prepared = await first.execute(command())
    const startCommand = {
      type: "START_PAID" as const,
      commandId: "start-fault",
      attemptId: "attempt-fault",
      executorKey: "engine" as const,
      expectedReceiptHash: prepared.receipt.hash,
    }
    const ambiguous = await first.execute(startCommand)
    assert.equal(ambiguous.status, "UNKNOWN")

    await journal.close()
    const restartedJournal = new SignedJournal(journalPath, secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    const restarted = service(restartedJournal, executor, gateway)
    const reconciled = await restarted.execute({
      type: "RECONCILE",
      commandId: "reconcile-fault",
      attemptId: "attempt-fault",
      expectedReceiptHash: ambiguous.receipt.hash,
    })
    assert.equal(reconciled.status, "UNKNOWN")
    assert.equal((await executor.read()).createCalls, 1)
    assert.equal((await executor.read()).startCalls, 0)
    const duplicate = await restarted.execute(startCommand)
    assert.equal(duplicate.status, "UNKNOWN")
    assert.equal((await executor.read()).createCalls, 1)
    console.log("PASS delayed-create-and-restart")

    const stopCommand = {
      type: "STOP" as const,
      commandId: "stop-fault",
      attemptId: "attempt-fault",
      expectedReceiptHash: reconciled.receipt.hash,
    }
    const stopped = await restarted.execute(stopCommand)
    assert.equal(stopped.status, "UNKNOWN")
    const stopCount = (await executor.read()).stopCalls
    assert.equal((await restarted.execute(stopCommand)).status, "UNKNOWN")
    assert.equal((await executor.read()).stopCalls, stopCount)
    await assert.rejects(
      restarted.execute({
        ...stopCommand,
        commandId: "stop-stale",
        expectedReceiptHash: prepared.receipt.hash,
      }),
      /stale/
    )
    console.log("PASS duplicate-stop-and-stale-receipt")

    const unavailableRoot = join(root, "provider-unavailable")
    await mkdir(unavailableRoot)
    const unavailableJournal = new SignedJournal(
      join(unavailableRoot, "journal.jsonl"),
      secret,
      (value) => supervisorJournalEventSchema.parse(value)
    )
    const unavailableExecutor = new FileContainerExecutor()
    await unavailableExecutor.initialize(unavailableRoot)
    const unavailableGateway = new HarnessGateway()
    unavailableGateway.unavailable = true
    const unavailableService = service(unavailableJournal, unavailableExecutor, unavailableGateway)
    const unavailablePrepared = await unavailableService.execute(
      command("attempt-unavailable", "prepare-unavailable")
    )
    const unavailableStart = await unavailableService.execute({
      type: "START_PAID",
      commandId: "start-unavailable",
      attemptId: "attempt-unavailable",
      executorKey: "engine",
      expectedReceiptHash: unavailablePrepared.receipt.hash,
    })
    assert.equal(unavailableStart.status, "STARTED")
    const beforeStop = (await unavailableExecutor.read()).stopCalls
    const unavailableStop = await unavailableService.execute({
      type: "STOP",
      commandId: "stop-unavailable",
      attemptId: "attempt-unavailable",
      expectedReceiptHash: unavailableStart.receipt.hash,
    })
    assert.equal(unavailableStop.status, "UNKNOWN")
    assert.equal((await unavailableExecutor.read()).stopCalls, beforeStop + 1)
    console.log("PASS provider-unavailable-still-tears-down")

    const diskFailureJournal: JournalPort<SupervisorJournalEvent> = {
      load: async () => [],
      append: async () => {
        await writeFile("/dev/full", "journal-record")
        throw new Error("unreachable")
      },
    }
    await assert.rejects(
      diskFailureJournal.append({
        type: "command_intent",
        command: {
          type: "STOP",
          commandId: "disk",
          attemptId: "disk",
          expectedReceiptHash: "a".repeat(64),
        },
      }),
      /ENOSPC|no space|unreachable/
    )
    console.log("PASS journal-disk-failure-before-effect")

    const processExecutor = new LinuxProcessExecutor(cgroupRoot, 100)
    const processSpec = {
      kind: "process" as const,
      command: "/bin/sh",
      args: ["-c", "exit 0"],
      cwd: root,
      cgroupPath: join(cgroupRoot, "process-owned"),
      env: {},
      grantEnvName: "LLM_API_KEY",
    }
    const processContext = { attemptId: "attempt-process", commandId: "start-process" }
    await assert.rejects(processExecutor.create("engine", processSpec, processContext), /held/)
    const ownership: ResourceOwnership = {
      executorKey: "engine",
      kind: "process",
      ownershipId: deriveOwnershipId(processContext.attemptId, processContext.commandId, "engine"),
      cgroupPath: processSpec.cgroupPath,
    }
    assert.equal((await processExecutor.inspect(ownership)).state, "UNKNOWN")
    assert.equal((await processExecutor.stop(ownership)).state, "UNKNOWN")
    console.log("PASS unqualified-process-execution-held")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
