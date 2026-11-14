import { fixtureAuthorityFence } from "./test-fixtures"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EXECUTOR_KEYS,
  SignedJournal,
  toBrokerReceiptType,
  type ExecutorPlan,
  type ProviderGrant,
  type ProviderGrantRequest,
  type ProviderGrantRevocation,
  type JournalPort,
  type ProviderGrantStatus,
  type ResourceInspection,
  type ResourceOwnership,
  type SupervisorPort,
  type ScanAuthorityFence,
} from "@lyrashield/runtime-control"
import { deriveOwnershipId, type ExecutorContext, type RuntimeExecutor } from "./executor"
import {
  SupervisorService,
  supervisorJournalEventSchema,
  type SupervisorJournalEvent,
} from "./service"

const roots: string[] = []
const secret = "s".repeat(48)
const now = new Date("2026-11-05T10:00:00.000Z")
const expiresAt = "2026-11-05T11:00:00.000Z"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function journal() {
  const root = await mkdtemp(join(tmpdir(), "supervisor-service-test-"))
  roots.push(root)
  return new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
    supervisorJournalEventSchema.parse(value)
  )
}

class FakeExecutor implements RuntimeExecutor {
  createCalls = 0
  startCalls = 0
  stopCalls = 0
  state: "ABSENT" | "PRESENT" = "ABSENT"
  ownership: ResourceOwnership | null = null
  createFailureAfterEffect = false
  createFailureBeforeEffect = false

  async create(
    key: ExecutorPlan["key"],
    _spec: ExecutorPlan["spec"],
    context: { attemptId: string; commandId: string }
  ): Promise<ResourceOwnership> {
    this.createCalls += 1
    if (this.createFailureBeforeEffect) throw new Error("create was rejected before any effect")
    this.state = "PRESENT"
    this.ownership = {
      executorKey: key,
      kind: "container",
      ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
      containerId: "a".repeat(64),
      createdAt: now.toISOString(),
    }
    if (this.createFailureAfterEffect) throw new Error("daemon response was lost after create")
    return this.ownership
  }

  async start(ownership: ResourceOwnership): Promise<ResourceOwnership> {
    this.startCalls += 1
    return ownership
  }

  async inspect(_ownership: ResourceOwnership): Promise<ResourceInspection> {
    return this.state === "PRESENT" && this.ownership
      ? { state: "PRESENT", running: true, ownership: this.ownership }
      : { state: "ABSENT" }
  }

  async stop(_ownership: ResourceOwnership): Promise<ResourceInspection> {
    this.stopCalls += 1
    this.state = "ABSENT"
    return { state: "ABSENT" }
  }
}

class FakeProviderGateway implements SupervisorPort {
  issueCalls = 0
  revokeCalls = 0
  revokeUnavailable = false
  lookupUnavailable = false
  grant: ProviderGrant | null = null
  revokedAt: string | null = null
  requestCount = 0

  async issueGrant(request: ProviderGrantRequest): Promise<ProviderGrant> {
    this.issueCalls += 1
    this.grant = {
      grantId: "pg_attempt_grant",
      token: "g".repeat(64),
      attemptId: request.attemptId,
      providerId: request.providerId,
      expiresAt: request.expiresAt,
      receipt: "1".repeat(64),
    }
    return this.grant
  }

  async findGrantByRequest(_requestId: string): Promise<ProviderGrant | null> {
    return this.lookupUnavailable ? null : this.grant
  }

  async revokeGrant(request: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
    this.revokeCalls += 1
    if (this.revokeUnavailable) throw new Error("provider gateway unavailable")
    this.revokedAt = now.toISOString()
    return {
      grantId: request.grantId,
      attemptId: request.attemptId,
      providerId: "azure-ai",
      expiresAt,
      revokedAt: this.revokedAt,
      requestCount: this.requestCount,
      reservedCostMicros: 100,
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
      requestCount: this.requestCount,
      reservedCostMicros: 100,
      receipt: "2".repeat(64),
    }
  }
}

function prepareCommand(executorKey: (typeof EXECUTOR_KEYS)[number] = "engine") {
  return {
    type: "PREPARE" as const,
    commandId: "cmd-prepare-1",
    attempt: {
      attemptId: "attempt-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      operationId: "operation-1",
      authorityEpochId: "epoch-1",
      authorityRevision: 3,
      workerIdentity: "worker-1",
      billingMode: "PAID" as const,
      expiresAt,
    },
    executors: [
      {
        key: executorKey,
        spec: {
          kind: "container" as const,
          image: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)}`,
          argv: ["lyrashield", "--non-interactive"],
          env: { MODE: "test" },
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
      maxRequests: 4,
      costReservationMicros: 100,
      maxReservedCostMicros: 1000,
    },
  }
}

async function serviceWith<G extends SupervisorPort = FakeProviderGateway>(
  journalPort?: JournalPort<SupervisorJournalEvent>,
  executor = new FakeExecutor(),
  gateway: G = new FakeProviderGateway() as unknown as G,
  admission: "open" | "closed" = "open",
  authorityFence: ScanAuthorityFence | null = fixtureAuthorityFence
) {
  const activeJournal = journalPort ?? (await journal())
  return {
    service: new SupervisorService({
      journal: activeJournal,
      executor,
      providerGateway: gateway,
      providerGatewayUrl: "http://127.0.0.1:8791",
      authorityFence: authorityFence ?? undefined,
      signingSecret: secret,
      supervisorInstanceId: "supervisor-test-1",
      admission,
      policy: {
        allowedImages: new Set([`ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)}`]),
        allowedNetworks: new Set(["lyrashield-sandbox"]),
        allowedProcessCommands: new Set(["/usr/bin/true"]),
        allowedCwdRoots: [tmpdir()],
        allowedCgroupRoot: tmpdir(),
      },
      now: () => now,
    }),
    executor,
    gateway,
  }
}

describe("SupervisorService", () => {
  it.each(["EXECUTOR_CREATE", "EXECUTOR_START"] as const)(
    "passes the live fence guard to the executor during %s",
    async (phase) => {
      let expired = false
      const authorityFence: ScanAuthorityFence = {
        run: async (binding, effect) =>
          effect(() => {
            if (binding.phase === phase && expired) throw new Error("authority expired")
          }),
      }
      class ExpiringExecutor extends FakeExecutor {
        override async create(
          key: ExecutorPlan["key"],
          spec: ExecutorPlan["spec"],
          context: { attemptId: string; commandId: string; assertActive?: () => void }
        ): Promise<ResourceOwnership> {
          await Promise.resolve()
          if (phase === "EXECUTOR_CREATE") expired = true
          context.assertActive?.()
          return super.create(key, spec, context)
        }
        override async start(
          ownership: ResourceOwnership,
          _spec?: ExecutorPlan["spec"],
          context?: { assertActive?: () => void }
        ): Promise<ResourceOwnership> {
          await Promise.resolve()
          if (phase === "EXECUTOR_START") expired = true
          context?.assertActive?.()
          return super.start(ownership)
        }
      }
      const executor = new ExpiringExecutor()
      const { service } = await serviceWith(undefined, executor, undefined, "open", authorityFence)
      const prepared = await service.execute(prepareCommand())
      const result = await service.execute({
        type: "START_PAID",
        commandId: "start-expiring-authority",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      expect(result.status).toBe("UNKNOWN")
      expect(executor.createCalls).toBe(phase === "EXECUTOR_CREATE" ? 0 : 1)
      expect(executor.startCalls).toBe(0)
    }
  )
  it("rejects preparation without native authority before retaining a command", async () => {
    const stored = await journal()
    const gateway = new FakeProviderGateway()
    const { service, executor } = await serviceWith(stored, undefined, gateway, "open", null)
    await expect(service.execute(prepareCommand())).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    })
    expect(await stored.load()).toEqual([])
    expect(executor.createCalls).toBe(0)
    expect(gateway.issueCalls).toBe(0)
  })

  it.each(["EXECUTOR_CREATE", "EXECUTOR_START"] as const)(
    "revalidates authority at %s without repeating effects",
    async (deniedPhase) => {
      const phases: string[] = []
      const authorityFence: ScanAuthorityFence = {
        run: async (binding, effect) => {
          phases.push(binding.phase)
          expect(binding).toMatchObject({
            operationId: "operation-1",
            scanId: "scan-1",
            workspaceId: "workspace-1",
            authorityEpochId: "epoch-1",
            authorityRevision: 3,
          })
          expect(binding.authorityChecksum).toMatch(/^[a-f0-9]{64}$/)
          expect(binding.actionChecksum).toMatch(/^[a-f0-9]{64}$/)
          if (binding.phase === deniedPhase) throw new Error("membership revoked")
          return effect(() => undefined)
        },
      }
      const stored = await journal()
      const gateway = new FakeProviderGateway()
      const { service, executor } = await serviceWith(
        stored,
        undefined,
        gateway,
        "open",
        authorityFence
      )
      const prepared = await service.execute(prepareCommand())
      const start = {
        type: "START_PAID" as const,
        commandId: "start-fenced",
        attemptId: "attempt-1",
        executorKey: "engine" as const,
        expectedReceiptHash: prepared.receipt.hash,
      }
      const expected = deniedPhase === "EXECUTOR_CREATE" ? "NEVER_DISPATCHED" : "UNKNOWN"
      expect((await service.execute(start)).status).toBe(expected)
      expect((await service.execute(start)).status).toBe(expected)
      expect(phases).toEqual(
        deniedPhase === "EXECUTOR_CREATE"
          ? ["PREPARE", "EXECUTOR_CREATE"]
          : ["PREPARE", "EXECUTOR_CREATE", "EXECUTOR_START"]
      )
      expect(executor.createCalls).toBe(deniedPhase === "EXECUTOR_CREATE" ? 0 : 1)
      expect(executor.startCalls).toBe(0)
      expect(gateway.revokeCalls).toBe(deniedPhase === "EXECUTOR_CREATE" ? 1 : 0)
      const { service: restarted } = await serviceWith(
        stored,
        executor,
        gateway,
        "open",
        authorityFence
      )
      expect((await restarted.getAttempt("attempt-1")).status).toBe(expected)
      expect((await restarted.execute(start)).status).toBe(expected)
      expect(executor.createCalls).toBe(deniedPhase === "EXECUTOR_CREATE" ? 0 : 1)
    }
  )

  it.each(["revocation", "lookup", "usage"] as const)(
    "keeps pre-create rejection uncertain when provider %s cannot prove a clean stop",
    async (failure) => {
      const authorityFence: ScanAuthorityFence = {
        run: async (binding, effect) => {
          if (binding.phase === "EXECUTOR_CREATE") throw new Error("membership revoked")
          return effect(() => undefined)
        },
      }
      const stored = await journal()
      const gateway = new FakeProviderGateway()
      gateway.revokeUnavailable = failure === "revocation"
      gateway.lookupUnavailable = failure === "lookup"
      gateway.requestCount = failure === "usage" ? 1 : 0
      const { service, executor } = await serviceWith(
        stored,
        undefined,
        gateway,
        "open",
        authorityFence
      )
      const prepared = await service.execute(prepareCommand())
      const start = {
        type: "START_PAID" as const,
        commandId: "start-unsettled",
        attemptId: "attempt-1",
        executorKey: "engine" as const,
        expectedReceiptHash: prepared.receipt.hash,
      }
      expect((await service.execute(start)).status).toBe("UNKNOWN")
      expect((await service.execute(start)).status).toBe("UNKNOWN")
      expect(executor.createCalls).toBe(0)
      const { service: restarted } = await serviceWith(
        stored,
        executor,
        gateway,
        "open",
        authorityFence
      )
      expect((await restarted.getAttempt("attempt-1")).status).toBe("UNKNOWN")
    }
  )

  it("retains uncertainty after a terminal journal write fails before acknowledgement", async () => {
    const stored = await journal()
    const gateway = new FakeProviderGateway()
    const fault: JournalPort<SupervisorJournalEvent> = {
      load: () => stored.load(),
      append: async (event) => {
        if (event.type === "command_terminal" && event.status === "NEVER_DISPATCHED")
          throw new Error("terminal write unavailable")
        return stored.append(event)
      },
    }
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, effect) => {
        if (binding.phase === "EXECUTOR_CREATE") throw new Error("membership revoked")
        return effect(() => undefined)
      },
    }
    const { service, executor } = await serviceWith(
      fault,
      undefined,
      gateway,
      "open",
      authorityFence
    )
    const prepared = await service.execute(prepareCommand())
    const start = {
      type: "START_PAID" as const,
      commandId: "start-terminal-unavailable",
      attemptId: "attempt-1",
      executorKey: "engine" as const,
      expectedReceiptHash: prepared.receipt.hash,
    }
    await expect(service.execute(start)).rejects.toThrow("terminal write unavailable")
    const { service: restarted } = await serviceWith(
      stored,
      executor,
      gateway,
      "open",
      authorityFence
    )
    expect((await restarted.getAttempt("attempt-1")).status).toBe("UNKNOWN")
    expect((await restarted.execute(start)).status).toBe("UNKNOWN")
    expect(executor.createCalls).toBe(0)
    expect(gateway.revokeCalls).toBe(1)
  })

  it("holds an unacknowledged planned creation even when the daemon was not invoked", async () => {
    const stored = await journal()
    const gateway = new FakeProviderGateway()
    const fault: JournalPort<SupervisorJournalEvent> = {
      load: () => stored.load(),
      append: async (event) => {
        const record = await stored.append(event)
        if (event.type === "resource_create_planned")
          throw new Error("planned acknowledgement lost")
        return record
      },
    }
    const { service, executor } = await serviceWith(fault, undefined, gateway)
    const prepared = await service.execute(prepareCommand())
    const start = {
      type: "START_PAID" as const,
      commandId: "start-plan-unavailable",
      attemptId: "attempt-1",
      executorKey: "engine" as const,
      expectedReceiptHash: prepared.receipt.hash,
    }
    expect((await service.execute(start)).status).toBe("UNKNOWN")
    const { service: restarted } = await serviceWith(stored, executor, gateway)
    expect((await restarted.getAttempt("attempt-1")).status).toBe("UNKNOWN")
    expect((await restarted.execute(start)).status).toBe("UNKNOWN")
    expect(executor.createCalls).toBe(0)
    expect(gateway.revokeCalls).toBe(0)
  })

  it.each(["intent", "prepared"] as const)(
    "rejects a signed %s record that changes an existing command on restart",
    async (kind) => {
      const stored = await journal()
      const { service, executor, gateway } = await serviceWith(stored)
      const command = prepareCommand()
      await service.execute(command)
      const changed = prepareCommand("scanner")
      const envelope = {
        supervisorInstanceId: "supervisor-test-1",
        observedAt: now.toISOString(),
      }
      if (kind === "intent") {
        await stored.append({ ...envelope, type: "command_intent", command: changed })
      } else {
        await stored.append({
          ...envelope,
          type: "attempt_prepared",
          commandId: changed.commandId,
          binding: changed.attempt,
          executors: changed.executors,
          provider: changed.provider,
        })
      }
      const { service: restarted } = await serviceWith(stored, executor, gateway)
      await expect(restarted.initialize()).rejects.toMatchObject({ code: "JOURNAL_INTEGRITY" })
      expect(executor.createCalls).toBe(0)
      expect(executor.startCalls).toBe(0)
      expect(gateway.issueCalls).toBe(0)
    }
  )

  it("accepts an exact repeated intent before preparation completes", async () => {
    const stored = await journal()
    const command = prepareCommand()
    const envelope = { supervisorInstanceId: "supervisor-test-1", observedAt: now.toISOString() }
    await stored.append({ ...envelope, type: "command_intent", command })
    await stored.append({ ...envelope, type: "command_intent", command })
    await stored.append({
      ...envelope,
      type: "attempt_prepared",
      commandId: command.commandId,
      binding: command.attempt,
      executors: command.executors,
      provider: command.provider,
    })
    const { service, executor, gateway } = await serviceWith(stored)
    expect((await service.execute(command)).status).toBe("PREPARED")
    expect(executor.createCalls).toBe(0)
    expect(gateway.issueCalls).toBe(0)
  })

  it("rejects an altered paid-start intent on restart without repeating an effect", async () => {
    const stored = await journal()
    const { service, executor, gateway } = await serviceWith(stored)
    const prepared = await service.execute(prepareCommand())
    const command = {
      type: "START_PAID" as const,
      commandId: "cmd-start-identity",
      attemptId: "attempt-1",
      executorKey: "engine" as const,
      expectedReceiptHash: prepared.receipt.hash,
    }
    expect((await service.execute(command)).status).toBe("STARTED")
    await stored.append({
      type: "command_intent",
      supervisorInstanceId: "supervisor-test-1",
      observedAt: now.toISOString(),
      command: { ...command, expectedReceiptHash: "f".repeat(64) },
    })
    const { service: restarted } = await serviceWith(stored, executor, gateway)
    await expect(restarted.initialize()).rejects.toMatchObject({ code: "JOURNAL_INTEGRITY" })
    expect(executor.createCalls).toBe(1)
    expect(executor.startCalls).toBe(1)
    expect(gateway.issueCalls).toBe(1)
  })

  it("records broker command acceptance before PREPARE completion and replays neither", async () => {
    const stored = await journal()
    const { service, executor, gateway } = await serviceWith(stored)
    const command = prepareCommand()
    const result = await service.execute(command)
    const records = await stored.load()
    expect(records.map((record) => record.payload.type)).toEqual([
      "command_intent",
      "attempt_prepared",
    ])
    expect(records.map((record) => toBrokerReceiptType(record.payload))).toEqual([
      "COMMAND_ACCEPTED",
      "PREPARE_COMPLETED",
    ])
    expect(records[0]?.payload).toMatchObject({ type: "command_intent", command })
    expect(records[1]?.previousHash).toBe(records[0]?.hash)
    expect(result.receipt.hash).toBe(records[1]?.hash)
    expect(await service.execute(command)).toEqual(result)
    expect(await stored.load()).toEqual(records)
    expect(executor.createCalls).toBe(0)
    expect(executor.startCalls).toBe(0)
    expect(gateway.grant).toBeNull()
  })

  it("never records PREPARE completion or creates resources without durable acceptance", async () => {
    const stored = await journal()
    const blocked: JournalPort<SupervisorJournalEvent> = {
      load: () => stored.load(),
      append: async (event) => {
        if (event.type === "command_intent") throw new Error("synthetic intent storage unavailable")
        return stored.append(event)
      },
    }
    const { service, executor, gateway } = await serviceWith(blocked)
    await expect(service.execute(prepareCommand())).rejects.toThrow(
      "synthetic intent storage unavailable"
    )
    expect(await stored.load()).toEqual([])
    expect(executor.createCalls).toBe(0)
    expect(executor.startCalls).toBe(0)
    expect(gateway.grant).toBeNull()
  })

  it.each(["STOP", "RECONCILE"] as const)(
    "recovers interrupted PREPARE as UNKNOWN, then converges with %s without replay",
    async (cleanupType) => {
      const stored = await journal()
      const interrupted: JournalPort<SupervisorJournalEvent> = {
        load: () => stored.load(),
        append: async (event) => {
          if (event.type === "attempt_prepared")
            throw new Error("synthetic completion storage unavailable")
          return stored.append(event)
        },
      }
      const command = prepareCommand()
      const { service, executor, gateway } = await serviceWith(interrupted)
      const inspectExecutor = vi.spyOn(executor, "inspect")
      const lookupGrant = vi.spyOn(gateway, "findGrantByRequest")
      const inspectGrant = vi.spyOn(gateway, "inspectGrant")
      await expect(service.execute(command)).rejects.toThrow(
        "synthetic completion storage unavailable"
      )
      const records = await stored.load()
      expect(records.map((record) => record.payload.type)).toEqual(["command_intent"])
      const { service: restarted } = await serviceWith(stored, executor, gateway)
      const result = await restarted.execute(command)
      expect(result.status).toBe("UNKNOWN")
      expect(result.receipt.hash).toBe(records[0]?.hash)
      expect(await stored.load()).toEqual(records)
      for (const type of ["START_PAID", "START_UNMETERED"] as const) {
        await expect(
          restarted.execute({
            type,
            commandId: "cmd-no-prepare-" + type,
            attemptId: command.attempt.attemptId,
            executorKey: "engine",
            expectedReceiptHash: result.receipt.hash,
          })
        ).rejects.toMatchObject({ code: "ATTEMPT_NOT_STARTABLE" })
      }
      const cleanup = await restarted.execute({
        type: cleanupType,
        commandId: "cmd-prepare-reconcile",
        attemptId: command.attempt.attemptId,
        expectedReceiptHash: result.receipt.hash,
      })
      expect(cleanup.status).toBe("NEVER_DISPATCHED")
      const cleanedRecords = await stored.load()
      const { service: afterCleanup } = await serviceWith(stored, executor, gateway)
      await expect(
        afterCleanup.execute({ ...command, commandId: "cmd-fresh-prepare" })
      ).rejects.toMatchObject({ code: "ATTEMPT_CONFLICT" })
      expect(await stored.load()).toEqual(cleanedRecords)
      expect((await afterCleanup.getAttempt(command.attempt.attemptId)).status).toBe(
        "NEVER_DISPATCHED"
      )
      expect(executor.createCalls).toBe(0)
      expect(executor.startCalls).toBe(0)
      expect(executor.stopCalls).toBe(0)
      expect(gateway.issueCalls).toBe(0)
      expect(gateway.revokeCalls).toBe(0)
      expect(inspectExecutor).not.toHaveBeenCalled()
      expect(lookupGrant).not.toHaveBeenCalled()
      expect(inspectGrant).not.toHaveBeenCalled()
    }
  )

  it.each(["available", "missing", "foreign"] as const)(
    "starts distinct paid executors only with the retained provider grant (%s)",
    async (recovery) => {
      class RequestBoundGateway extends FakeProviderGateway {
        requestId: string | undefined
        override async issueGrant(request: ProviderGrantRequest): Promise<ProviderGrant> {
          this.requestId = request.grantRequestId
          return super.issueGrant(request)
        }
        override async findGrantByRequest(requestId: string): Promise<ProviderGrant | null> {
          return requestId === this.requestId ? super.findGrantByRequest(requestId) : null
        }
      }
      const stored = await journal()
      const gateway = new RequestBoundGateway()
      const executor = new FakeExecutor()
      const { service } = await serviceWith(stored, executor, gateway)
      const base = prepareCommand()
      const prepared = await service.execute({
        ...base,
        executors: [{ ...base.executors[0], key: "sandbox" }, base.executors[0]],
      })
      const sandbox = await service.execute({
        type: "START_PAID",
        commandId: "cmd-paid-sandbox",
        attemptId: "attempt-1",
        executorKey: "sandbox",
        expectedReceiptHash: prepared.receipt.hash,
      })
      expect(sandbox.status).toBe("STARTED")
      const { service: restarted } = await serviceWith(stored, executor, gateway)
      if (recovery === "missing") gateway.lookupUnavailable = true
      if (recovery === "foreign") gateway.grant = { ...gateway.grant!, grantId: "foreign-grant" }
      const engine = await restarted.execute({
        type: "START_PAID",
        commandId: "cmd-paid-engine",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: sandbox.receipt.hash,
      })
      if (recovery !== "available") {
        expect(engine.status).toBe("UNKNOWN")
        expect(gateway.issueCalls).toBe(1)
        expect(executor.startCalls).toBe(1)
        return
      }
      expect(engine.status).toBe("STARTED")
      expect(gateway.issueCalls).toBe(1)
      expect(executor.startCalls).toBe(2)
      const duplicate = await restarted.execute({
        type: "START_PAID",
        commandId: "cmd-paid-engine-again",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: engine.receipt.hash,
      })
      expect(duplicate.status).toBe("REJECTED")
      expect(gateway.issueCalls).toBe(1)
      expect(executor.startCalls).toBe(2)
      const stopped = await restarted.execute({
        type: "STOP",
        commandId: "cmd-paid-stop",
        attemptId: "attempt-1",
        expectedReceiptHash: duplicate.receipt.hash,
      })
      expect(stopped.status).toBe("STOPPED")
      expect(gateway.revokeCalls).toBe(1)
      expect(executor.stopCalls).toBe(2)
    }
  )

  it("recovers a durably completed PREPARE after its acknowledgement is lost", async () => {
    const stored = await journal()
    const ambiguous: JournalPort<SupervisorJournalEvent> = {
      load: () => stored.load(),
      append: async (event) => {
        const record = await stored.append(event)
        if (event.type === "attempt_prepared") throw new Error("synthetic acknowledgement lost")
        return record
      },
    }
    const command = prepareCommand()
    const { service, executor } = await serviceWith(ambiguous)
    await expect(service.execute(command)).rejects.toThrow("synthetic acknowledgement lost")
    const records = await stored.load()
    expect(records.map((record) => record.payload.type)).toEqual([
      "command_intent",
      "attempt_prepared",
    ])
    const { service: restarted } = await serviceWith(stored, executor)
    const result = await restarted.execute(command)
    expect(result.status).toBe("PREPARED")
    expect(result.receipt.hash).toBe(records[1]?.hash)
    expect(await stored.load()).toEqual(records)
    expect(executor.createCalls).toBe(0)
    expect(executor.startCalls).toBe(0)
  })

  it.each([false, true])(
    "durably accepts STOP during create (guard before mutation=%s)",
    async (guardBeforeCreate) => {
      let guardedCallbackSeen = false
      let createEntered: () => void = () => undefined
      let finishCreate: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        createEntered = resolve
      })
      const release = new Promise<void>((resolve) => {
        finishCreate = resolve
      })
      class DelayedExecutor extends FakeExecutor {
        override async create(
          ...args: Parameters<FakeExecutor["create"]>
        ): Promise<ResourceOwnership> {
          createEntered()
          await release
          if (guardBeforeCreate) {
            const guard = (args[2] as ExecutorContext).assertActive
            guardedCallbackSeen = typeof guard === "function"
            guard()
          }
          return super.create(...args)
        }
      }
      const storedJournal = await journal()
      let confirmStop: () => void = () => undefined
      const stopPersisted = new Promise<void>((resolve) => {
        confirmStop = resolve
      })
      const observedJournal: JournalPort<SupervisorJournalEvent> = {
        load: () => storedJournal.load(),
        append: async (event) => {
          const record = await storedJournal.append(event)
          if (event.type === "command_intent" && event.command.commandId === "cmd-stop-delayed") {
            confirmStop()
          }
          return record
        },
      }
      const executor = new DelayedExecutor()
      const { service } = await serviceWith(observedJournal, executor)
      const prepared = await service.execute(prepareCommand())
      const starting = service.execute({
        type: "START_PAID",
        commandId: "cmd-start-delayed",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      await entered
      const beforeStop = await service.getAttempt("attempt-1")
      const stopCommand = {
        type: "STOP" as const,
        commandId: "cmd-stop-delayed",
        attemptId: "attempt-1",
        expectedReceiptHash: beforeStop.receipt.hash,
      }
      const stopping = service.execute(stopCommand)
      await stopPersisted
      const beforeRelease = await storedJournal.load()
      expect(
        beforeRelease.some(
          (entry) =>
            entry.payload.type === "command_intent" &&
            entry.payload.command.commandId === stopCommand.commandId
        )
      ).toBe(true)
      finishCreate()
      const [started, stopped] = await Promise.all([starting, stopping])
      expect(started.status).toBe("UNKNOWN")
      expect(stopped.status).toBe(guardBeforeCreate ? "UNKNOWN" : "STOPPED")
      expect(guardedCallbackSeen).toBe(guardBeforeCreate)
      expect(executor.createCalls).toBe(guardBeforeCreate ? 0 : 1)
      expect(executor.startCalls).toBe(0)
      expect(executor.stopCalls).toBe(guardBeforeCreate ? 0 : 1)
      expect(executor.state).toBe("ABSENT")
      await expect(service.execute(stopCommand)).resolves.toEqual(stopped)
    }
  )

  it("begins grant revocation while a start acknowledgement is still pending", async () => {
    let startEntered: () => void = () => undefined
    let finishStart: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      finishStart = resolve
    })
    class DelayedStartExecutor extends FakeExecutor {
      override async start(ownership: ResourceOwnership): Promise<ResourceOwnership> {
        startEntered()
        await release
        return super.start(ownership)
      }
    }
    const gateway = new FakeProviderGateway()
    const executor = new DelayedStartExecutor()
    const { service } = await serviceWith(await journal(), executor, gateway)
    const prepared = await service.execute(prepareCommand())
    const starting = service.execute({
      type: "START_PAID",
      commandId: "cmd-start-ack-pending",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    await entered
    const current = await service.getAttempt("attempt-1")
    const stopping = service.execute({
      type: "STOP",
      commandId: "cmd-stop-ack-pending",
      attemptId: "attempt-1",
      expectedReceiptHash: current.receipt.hash,
    })
    try {
      await vi.waitFor(() => expect(gateway.revokedAt).toBeTruthy(), { timeout: 500 })
    } finally {
      finishStart()
    }
    expect((await starting).status).toBe("UNKNOWN")
    expect((await stopping).status).toBe("STOPPED")
    expect(executor.stopCalls).toBe(1)
  })

  it("does not issue a terminal stop receipt before a delayed revocation finishes", async () => {
    let startEntered: () => void = () => undefined
    let finishStart: () => void = () => undefined
    let revokeEntered: () => void = () => undefined
    let finishRevoke: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve
    })
    const releaseStart = new Promise<void>((resolve) => {
      finishStart = resolve
    })
    const revoking = new Promise<void>((resolve) => {
      revokeEntered = resolve
    })
    const releaseRevoke = new Promise<void>((resolve) => {
      finishRevoke = resolve
    })
    class DelayedStartExecutor extends FakeExecutor {
      override async start(ownership: ResourceOwnership): Promise<ResourceOwnership> {
        startEntered()
        await releaseStart
        return super.start(ownership)
      }
    }
    class DelayedGateway extends FakeProviderGateway {
      override async revokeGrant(input: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
        revokeEntered()
        await releaseRevoke
        return super.revokeGrant(input)
      }
    }
    const executor = new DelayedStartExecutor()
    const gateway = new DelayedGateway()
    const { service } = await serviceWith(await journal(), executor, gateway)
    const prepared = await service.execute(prepareCommand())
    const starting = service.execute({
      type: "START_PAID",
      commandId: "cmd-start-delayed-revoke",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    await entered
    const current = await service.getAttempt("attempt-1")
    const stopCommand = {
      type: "STOP" as const,
      commandId: "cmd-stop-delayed-revoke",
      attemptId: "attempt-1",
      expectedReceiptHash: current.receipt.hash,
    }
    let stopFinished = false
    const stopping = service.execute(stopCommand).then((result) => {
      stopFinished = true
      return result
    })
    await revoking
    finishStart()
    await vi.waitFor(() => expect(executor.stopCalls).toBe(1), { timeout: 1000 })
    expect(stopFinished).toBe(false)
    finishRevoke()
    expect((await starting).status).toBe("UNKNOWN")
    const stopped = await stopping
    expect(stopped.status).toBe("STOPPED")
    await expect(service.execute(stopCommand)).resolves.toEqual(stopped)
  })

  it("persists intent before effects and never starts twice for one command id", async () => {
    const { service, executor, gateway } = await serviceWith()
    const prepared = await service.execute(prepareCommand())
    const start = {
      type: "START_PAID" as const,
      commandId: "cmd-start-1",
      attemptId: "attempt-1",
      executorKey: "engine" as const,
      expectedReceiptHash: prepared.receipt.hash,
    }
    const first = await service.execute(start)
    const repeated = await service.execute(start)
    expect(first.status).toBe("STARTED")
    expect(repeated).toEqual(first)
    expect(executor.createCalls).toBe(1)
    expect(executor.startCalls).toBe(1)
    expect(gateway.issueCalls).toBe(1)
  })

  it("never records an executor-started receipt for a create followed by a failed start", async () => {
    class FailedStartExecutor extends FakeExecutor {
      override async start(): Promise<ResourceOwnership> {
        throw new Error("start acknowledgement unavailable")
      }
    }
    const storedJournal = await journal()
    const { service } = await serviceWith(storedJournal, new FailedStartExecutor())
    const prepared = await service.execute(prepareCommand())
    const result = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-unconfirmed",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(result.status).toBe("UNKNOWN")
    const records = await storedJournal.load()
    expect(records.some((record) => record.payload.type === "resource_bound")).toBe(true)
    expect(records.some((record) => record.payload.type === "resource_started")).toBe(false)
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-unconfirmed",
      attemptId: "attempt-1",
      expectedReceiptHash: result.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
  })

  it("revokes every provider grant before proving teardown", async () => {
    const { service, executor, gateway } = await serviceWith()
    const prepared = await service.execute(prepareCommand())
    const started = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-2",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    const stopCommand = {
      type: "STOP" as const,
      commandId: "cmd-stop-1",
      attemptId: "attempt-1",
      expectedReceiptHash: started.receipt.hash,
    }
    const stopped = await service.execute(stopCommand)
    expect(stopped.status).toBe("STOPPED")
    expect(gateway.revokeCalls).toBe(1)
    expect(executor.stopCalls).toBe(1)
    await expect(service.execute(stopCommand)).resolves.toEqual(stopped)
  })

  it("stops physical work but stays UNKNOWN when provider revocation is unavailable", async () => {
    const gateway = new FakeProviderGateway()
    gateway.revokeUnavailable = true
    const { service, executor } = await serviceWith(await journal(), new FakeExecutor(), gateway)
    const prepared = await service.execute(prepareCommand())
    const started = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-3",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-3",
      attemptId: "attempt-1",
      expectedReceiptHash: started.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
    expect(executor.stopCalls).toBe(1)
    expect(gateway.revokeCalls).toBe(1)
  })

  it("retains UNKNOWN after physical teardown when provider settlement is unresolved", async () => {
    const gateway = new FakeProviderGateway()
    gateway.requestCount = 1
    const { service, executor } = await serviceWith(await journal(), new FakeExecutor(), gateway)
    const prepared = await service.execute(prepareCommand())
    const started = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-provider-unsettled",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-provider-unsettled",
      attemptId: "attempt-1",
      expectedReceiptHash: started.receipt.hash,
    })
    expect(executor.stopCalls).toBe(1)
    expect(gateway.revokedAt).toBeTruthy()
    expect(stopped.status).toBe("UNKNOWN")
    const again = await service.execute({
      type: "RECONCILE",
      commandId: "cmd-reconcile-provider-unsettled",
      attemptId: "attempt-1",
      expectedReceiptHash: stopped.receipt.hash,
    })
    expect(again.status).toBe("UNKNOWN")
  })

  it.each(["invoked", "denied"] as const)(
    "stops a real gateway attempt with provider dispatch %s",
    async (dispatch) => {
      const gatewayModule = "../../provider-gateway/src/service.ts"
      const fixtureModule = "../../provider-gateway/src/test-fixtures.ts"
      const {
        fixturePolicy,
        fixtureActionIntentPublisher,
        fixtureAuthorityFence: gatewayFixtureAuthorityFence,
      } = await import(fixtureModule)
      const { ProviderGatewayService, providerJournalEventSchema } = await import(gatewayModule)
      const root = await mkdtemp(join(tmpdir(), "supervisor-gateway-test-"))
      roots.push(root)
      let notifyStarted: () => void = () => undefined
      const requestStarted = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const gateway = new ProviderGatewayService({
        publishActionIntent: fixtureActionIntentPublisher,
        journal: new SignedJournal(join(root, "provider.jsonl"), secret, (value: unknown) =>
          providerJournalEventSchema.parse(value)
        ),
        authorityFence:
          dispatch === "denied"
            ? {
                run: async () => {
                  throw new Error("dispatch authority revoked")
                },
              }
            : gatewayFixtureAuthorityFence,
        signingSecret: secret,
        responseEncryptionSecret: "e".repeat(48),
        authorizeGrant: async (request: ProviderGrantRequest) => {
          expect(request).toMatchObject({
            attemptId: "attempt-1",
            scanId: "scan-1",
            workspaceId: "workspace-1",
            operationId: "operation-1",
            authorityEpochId: "epoch-1",
            authorityRevision: 3,
            providerId: "azure-ai",
            expiresAt,
          })
          return fixturePolicy
        },
        admission: "open",
        providers: new Map([
          [
            "azure-ai",
            {
              id: "azure-ai",
              baseUrl: "https://provider.example.test/openai",
              auth: { kind: "api-key", credential: "fixture-secret", headerName: "api-key" },
              allowedPathPrefixes: ["/openai/"],
              requestPolicy: fixturePolicy,
            },
          ],
        ]),
        fetchImpl: () => {
          notifyStarted()
          return new Promise<Response>(() => undefined)
        },
        now: () => now,
      })
      const { service, executor } = await serviceWith(await journal(), new FakeExecutor(), gateway)
      const prepared = await service.execute(prepareCommand())
      const started = await service.execute({
        type: "START_PAID",
        commandId: "cmd-start-real-gateway",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      const grant = await gateway.findGrantByRequest("cmd-start-real-gateway")
      expect(grant).not.toBeNull()
      const pending = gateway
        .proxy({
          providerId: "azure-ai",
          path: fixturePolicy.endpoint,
          method: "POST",
          authorization: `Bearer ${grant!.token}`,
          requestId: "unsettled-provider-call",
          contentType: "application/json",
          body: Buffer.from(
            JSON.stringify({ model: "gpt-6-luna", input: "hello", max_output_tokens: 64 })
          ),
        })
        .catch((error: unknown) => error)
      if (dispatch === "invoked") await requestStarted
      else await pending
      const stopped = await service.execute({
        type: "STOP",
        commandId: "cmd-stop-real-gateway",
        attemptId: "attempt-1",
        expectedReceiptHash: started.receipt.hash,
      })
      expect(await pending).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
      expect(executor.stopCalls).toBe(1)
      expect(stopped.status).toBe(dispatch === "invoked" ? "UNKNOWN" : "STOPPED")
    }
  )

  it.each(["STOP", "RECONCILE"] as const)(
    "%s attempts every teardown even when one executor fails",
    async (operation) => {
      class MultiExecutor extends FakeExecutor {
        stopped: string[] = []
        failInspection = false
        override async inspect(ownership: ResourceOwnership): Promise<ResourceInspection> {
          if (this.failInspection && ownership.executorKey === "relay") {
            return { state: "UNKNOWN", detail: "relay inspection failed" }
          }
          return { state: "PRESENT", running: true, ownership }
        }
        override async stop(ownership: ResourceOwnership): Promise<ResourceInspection> {
          this.stopped.push(ownership.executorKey)
          if (ownership.executorKey === "relay") throw new Error("relay unavailable")
          return { state: "ABSENT" }
        }
      }
      const executor = new MultiExecutor()
      const { service } = await serviceWith(await journal(), executor)
      const base = prepareCommand()
      const prepared = await service.execute({
        ...base,
        attempt: { ...base.attempt, billingMode: "UNMETERED" },
        provider: undefined,
        executors:
          operation === "RECONCILE"
            ? [{ ...base.executors[0], key: "relay" }, base.executors[0]]
            : [base.executors[0], { ...base.executors[0], key: "relay" }],
      })
      const first = await service.execute({
        type: "START_UNMETERED",
        commandId: "cmd-start-multi-engine",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      const second = await service.execute({
        type: "START_UNMETERED",
        commandId: "cmd-start-multi-relay",
        attemptId: "attempt-1",
        executorKey: "relay",
        expectedReceiptHash: first.receipt.hash,
      })
      if (operation === "RECONCILE") {
        const failedStop = await service.execute({
          type: "STOP",
          commandId: "cmd-stop-multi-first",
          attemptId: "attempt-1",
          expectedReceiptHash: second.receipt.hash,
        })
        executor.stopped = []
        executor.failInspection = true
        const result = await service.execute({
          type: "RECONCILE",
          commandId: "cmd-reconcile-multi",
          attemptId: "attempt-1",
          expectedReceiptHash: failedStop.receipt.hash,
        })
        expect(result.status).toBe("UNKNOWN")
      } else {
        const result = await service.execute({
          type: "STOP",
          commandId: "cmd-stop-multi",
          attemptId: "attempt-1",
          expectedReceiptHash: second.receipt.hash,
        })
        expect(result.status).toBe("UNKNOWN")
      }
      expect(executor.stopped).toContain("engine")
      if (operation === "STOP") expect(executor.stopped).toContain("relay")
    }
  )

  it("does not claim cleanup when a previously issued grant cannot be located", async () => {
    const gateway = new FakeProviderGateway()
    const { service, executor } = await serviceWith(await journal(), new FakeExecutor(), gateway)
    const prepared = await service.execute(prepareCommand())
    const started = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-grant-lost",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    gateway.lookupUnavailable = true
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-grant-lost",
      attemptId: "attempt-1",
      expectedReceiptHash: started.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
    expect(executor.stopCalls).toBe(1)
  })

  it("rejects stale start/stop receipts", async () => {
    const { service, executor } = await serviceWith()
    const prepared = await service.execute(prepareCommand())
    await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-4",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    await expect(
      service.execute({
        type: "STOP",
        commandId: "cmd-stop-4",
        attemptId: "attempt-1",
        expectedReceiptHash: prepared.receipt.hash,
      })
    ).rejects.toThrow("stale")
    expect(executor.stopCalls).toBe(0)
  })

  it("persists no start effect when the journal append fails", async () => {
    const real = await journal()
    let failIntents = false
    const failing = {
      load: () => real.load(),
      append: async (event: Parameters<typeof real.append>[0]) => {
        if (failIntents && event.type === "command_intent") throw new Error("disk full")
        return real.append(event)
      },
    }
    const { service, executor } = await serviceWith(failing)
    const prepared = await service.execute(prepareCommand())
    failIntents = true
    await expect(
      service.execute({
        type: "START_PAID",
        commandId: "cmd-start-5",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
    ).rejects.toThrow(/disk full|journal/i)
    expect(executor.createCalls).toBe(0)
  })

  it("reconciles a delayed create response without a second start", async () => {
    const executor = new FakeExecutor()
    executor.createFailureAfterEffect = true
    const { service } = await serviceWith(await journal(), executor, new FakeProviderGateway())
    const prepared = await service.execute(prepareCommand())
    const ambiguous = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-6",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(ambiguous.status).toBe("UNKNOWN")
    const reconciled = await service.execute({
      type: "RECONCILE",
      commandId: "cmd-reconcile-6",
      attemptId: "attempt-1",
      expectedReceiptHash: ambiguous.receipt.hash,
    })
    expect(reconciled.status).toBe("UNKNOWN")
    expect(executor.createCalls).toBe(1)
    expect(executor.startCalls).toBe(0)
    expect(executor.stopCalls).toBe(1)
  })

  it("does not start another executor after a stopped attempt", async () => {
    const { service, executor } = await serviceWith()
    const { provider: _provider, ...base } = prepareCommand()
    void _provider
    const prepared = await service.execute({
      ...base,
      attempt: { ...base.attempt, billingMode: "UNMETERED" },
      executors: [base.executors[0], { ...base.executors[0], key: "scanner" }],
    })
    const started = await service.execute({
      type: "START_UNMETERED",
      commandId: "cmd-first-unmetered",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-unmetered",
      attemptId: "attempt-1",
      expectedReceiptHash: started.receipt.hash,
    })
    await expect(
      service.execute({
        type: "START_UNMETERED",
        commandId: "cmd-late-unmetered",
        attemptId: "attempt-1",
        executorKey: "scanner",
        expectedReceiptHash: stopped.receipt.hash,
      })
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_STARTABLE" })
    expect(executor.createCalls).toBe(1)
  })

  it.each(["STOP", "RECONCILE"] as const)(
    "allows %s to revoke and clean an existing attempt after admission closes",
    async (commandType) => {
      const storedJournal = await journal()
      const { service, executor, gateway } = await serviceWith(storedJournal)
      const prepared = await service.execute(prepareCommand())
      const started = await service.execute({
        type: "START_PAID",
        commandId: "cmd-before-close",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      const closed = (await serviceWith(storedJournal, executor, gateway, "closed")).service
      await expect(
        closed.execute({ ...prepareCommand(), commandId: "new-prepare" })
      ).rejects.toMatchObject({
        code: "ADMISSION_CLOSED",
      })
      await expect(
        closed.execute({
          type: "START_PAID",
          commandId: "new-start",
          attemptId: "attempt-1",
          executorKey: "engine",
          expectedReceiptHash: started.receipt.hash,
        })
      ).rejects.toMatchObject({ code: "ADMISSION_CLOSED" })
      const cleaned = await closed.execute({
        type: commandType,
        commandId: `cleanup-${commandType}`,
        attemptId: "attempt-1",
        expectedReceiptHash: started.receipt.hash,
      })
      expect(cleaned.status).toBe("STOPPED")
      expect(gateway.revokeCalls).toBeGreaterThan(0)
      expect(executor.stopCalls).toBe(1)
    }
  )

  it("journals the planned executor identity before any create effect", async () => {
    const real = await journal()
    let failPlanned = true
    const failing = {
      load: () => real.load(),
      append: async (event: Parameters<typeof real.append>[0]) => {
        if (failPlanned && event.type === "resource_create_planned") throw new Error("disk full")
        return real.append(event)
      },
    }
    const { service, executor } = await serviceWith(failing)
    const prepared = await service.execute(prepareCommand())
    await expect(
      service.execute({
        type: "START_PAID",
        commandId: "cmd-start-planned",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
    ).resolves.toMatchObject({ status: "UNKNOWN" })
    expect(executor.createCalls).toBe(0)
  })

  it("direct STOP reconciles a present executor created in the delayed-create window", async () => {
    const executor = new FakeExecutor()
    executor.createFailureAfterEffect = true
    const { service, gateway } = await serviceWith(
      await journal(),
      executor,
      new FakeProviderGateway()
    )
    const prepared = await service.execute(prepareCommand())
    const ambiguous = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-delayed",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(ambiguous.status).toBe("UNKNOWN")
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-delayed",
      attemptId: "attempt-1",
      expectedReceiptHash: ambiguous.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
    expect(executor.createCalls).toBe(1)
    expect(executor.stopCalls).toBe(1)
    expect(gateway.revokeCalls).toBe(1)
  })

  it("keeps an absent planned create UNKNOWN when its outcome is ambiguous", async () => {
    const executor = new FakeExecutor()
    executor.createFailureBeforeEffect = true
    const { service, gateway } = await serviceWith(
      await journal(),
      executor,
      new FakeProviderGateway()
    )
    const prepared = await service.execute(prepareCommand())
    const failed = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-nothing",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(failed.status).toBe("UNKNOWN")
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-nothing",
      attemptId: "attempt-1",
      expectedReceiptHash: failed.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
    expect(executor.stopCalls).toBe(0)
    // The grant issued for the paid start must still be revoked even when the
    // executor effect never ran.
    expect(gateway.revokeCalls).toBe(1)
    executor.ownership = {
      executorKey: "engine",
      kind: "container",
      ownershipId: deriveOwnershipId("attempt-1", "cmd-start-nothing", "engine"),
      containerId: "a".repeat(64),
    }
    executor.state = "PRESENT"
    const reconciled = await service.execute({
      type: "RECONCILE",
      commandId: "cmd-reconcile-late-create",
      attemptId: "attempt-1",
      expectedReceiptHash: stopped.receipt.hash,
    })
    expect(reconciled.status).toBe("UNKNOWN")
    expect(executor.stopCalls).toBe(1)
  })

  it("does not stop a foreign resource returned by executor inspection", async () => {
    const executor = new FakeExecutor()
    executor.createFailureBeforeEffect = true
    const { service } = await serviceWith(await journal(), executor)
    const prepared = await service.execute(prepareCommand())
    const ambiguous = await service.execute({
      type: "START_PAID",
      commandId: "cmd-start-foreign",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    executor.ownership = {
      executorKey: "engine",
      kind: "container",
      ownershipId: `own_${"f".repeat(40)}`,
      containerId: "b".repeat(64),
    }
    executor.state = "PRESENT"
    const stopped = await service.execute({
      type: "STOP",
      commandId: "cmd-stop-foreign",
      attemptId: "attempt-1",
      expectedReceiptHash: ambiguous.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
    expect(executor.stopCalls).toBe(0)
  })

  it("restart replays the planned executor identity from the journal for STOP", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-restart-test-"))
    roots.push(root)
    const path = join(root, "journal.jsonl")
    const firstJournal = new SignedJournal(path, secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    const executor = new FakeExecutor()
    executor.createFailureAfterEffect = true
    const first = await serviceWith(firstJournal, executor, new FakeProviderGateway())
    const prepared = await first.service.execute(prepareCommand())
    const ambiguous = await first.service.execute({
      type: "START_PAID",
      commandId: "cmd-start-restart",
      attemptId: "attempt-1",
      executorKey: "engine",
      expectedReceiptHash: prepared.receipt.hash,
    })
    expect(ambiguous.status).toBe("UNKNOWN")

    await firstJournal.close()
    const secondJournal = new SignedJournal(path, secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    const second = await serviceWith(secondJournal, executor, first.gateway)
    const stopped = await second.service.execute({
      type: "STOP",
      commandId: "cmd-stop-restart",
      attemptId: "attempt-1",
      expectedReceiptHash: ambiguous.receipt.hash,
    })
    expect(stopped.status).toBe("UNKNOWN")
    expect(executor.createCalls).toBe(1)
    expect(executor.stopCalls).toBe(1)
  })
})
