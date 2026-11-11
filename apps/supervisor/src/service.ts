import { timingSafeEqual } from "node:crypto"
import {
  resourceOwnershipSchema,
  supervisorCommandSchema,
  type AttemptBinding,
  type CommandStatus,
  type ExecutorKey,
  type ResourceOwnership,
  type StartCommand,
  type StopCommand,
  type SupervisorCommand,
  type SupervisorCommandResult,
  type SupervisorPort,
  type SupervisorReceipt,
  type SupervisorJournalPage,
  type SupervisorJournalReader,
  type SupervisorJournalRecoveryPort,
  type SupervisorRecoveryResult,
} from "@lyrashield/runtime-control"
import type { JournalPort, JournalRecord } from "@lyrashield/runtime-control"
import { deriveOwnershipId, type ExecutorContext, type RuntimeExecutor } from "./executor"
import { assertExecutorAllowed, type SupervisorPolicy } from "./policy"
import type {
  AttemptState,
  CommandState,
  GrantBinding,
  InFlightStart,
  SupervisorJournalEvent,
} from "./journal-events"
export { supervisorJournalEventSchema } from "./journal-events"
export type { SupervisorJournalEvent } from "./journal-events"
import { applyJournalRecord } from "./journal-state"
import { restoreJournalState } from "./restore-state"
import { recoverServiceState } from "./service-recovery"
import { matchesOwnership, SupervisorOperations } from "./supervisor-operations"
import {
  RuntimeControlError,
  commandAttemptId,
  commandRequestHash,
  isTerminal,
} from "./service-common"
export { RuntimeControlError } from "./service-common"

const START_TYPES = new Set(["START_PAID", "START_UNMETERED"])

export interface SupervisorServiceOptions {
  journal: JournalPort<SupervisorJournalEvent> &
    Partial<
      SupervisorJournalReader<SupervisorJournalEvent> &
        SupervisorJournalRecoveryPort<SupervisorJournalEvent>
    >
  executor: RuntimeExecutor
  providerGateway: SupervisorPort
  providerGatewayUrl: string
  policy: SupervisorPolicy
  signingSecret: string
  admission: "closed" | "open"
  supervisorInstanceId: string
  now?: () => Date
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class SupervisorService {
  private initialized: Promise<void> | null = null
  private serial: Promise<void> = Promise.resolve()
  private readonly commands = new Map<string, CommandState>()
  private readonly attempts = new Map<string, AttemptState>()
  private readonly inFlightStarts = new Map<string, InFlightStart>()
  private readonly pendingRevocations = new Set<Promise<void>>()
  private activeCommands = 0
  private draining = false
  private readonly operations: SupervisorOperations

  constructor(private readonly options: SupervisorServiceOptions) {
    if (Buffer.byteLength(options.signingSecret, "utf8") < 32) {
      throw new Error("supervisor signing secret must be at least 32 bytes")
    }
    if (!options.supervisorInstanceId || options.supervisorInstanceId.length > 192) {
      throw new Error("supervisor instance id is required")
    }
    this.operations = new SupervisorOperations({
      options,
      attempts: this.attempts,
      commands: this.commands,
      nowIso: () => this.nowIso(),
      apply: (record) => this.apply(record),
      applyResource: (record) => this.applyResource(record),
      assertCurrentReceipt: (attempt, expected) => this.assertCurrentReceipt(attempt, expected),
      appendIntent: (command) => this.appendIntent(command),
      appendAttemptStatus: (attempt, status, commandId) =>
        this.appendAttemptStatus(attempt, status, commandId),
      appendTerminal: (command, status, reason) => this.appendTerminal(command, status, reason),
      hasUnresolvedExecutorEffect: (attempt) => this.hasUnresolvedExecutorEffect(attempt),
      startCommandIdFor: (attemptId, executorKey) => this.startCommandIdFor(attemptId, executorKey),
    })
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.load()
    }
    await this.initialized
  }

  async readJournal(input: unknown): Promise<SupervisorJournalPage<SupervisorJournalEvent>> {
    if (!this.options.journal.readCursor) {
      throw new RuntimeControlError(
        "JOURNAL_AUTHORITY_UNAVAILABLE",
        "independent journal readback is unavailable",
        503
      )
    }
    return this.options.journal.readCursor(input)
  }

  async recover(input: unknown): Promise<SupervisorRecoveryResult<SupervisorJournalEvent>> {
    return recoverServiceState(
      {
        journal: this.options.journal,
        busy: () =>
          this.draining ||
          this.activeCommands > 0 ||
          this.inFlightStarts.size > 0 ||
          this.pendingRevocations.size > 0,
        initialization: () => this.initialized,
        restoreInitialization: (prior) => {
          this.initialized = prior
        },
        serialized: (operation) => this.serialized(operation),
        install: (records) => restoreJournalState(records, this.attempts, this.commands),
        resultFor: (commandId) => this.resultFor(commandId),
        enter: (run) => {
          this.activeCommands += 1
          this.initialized = run.then(() => undefined)
          void this.initialized.catch(() => undefined)
        },
        leave: () => {
          this.activeCommands -= 1
        },
      },
      input
    )
  }

  async execute(input: unknown): Promise<SupervisorCommandResult> {
    if (this.draining)
      throw new RuntimeControlError("ADMISSION_CLOSED", "supervisor is shutting down", 503)
    this.activeCommands += 1
    try {
      return await this.executeCommand(input)
    } finally {
      this.activeCommands -= 1
    }
  }

  async drain(): Promise<void> {
    this.draining = true
    await this.serial
    await Promise.all(this.pendingRevocations)
    await this.serial
    if (
      this.activeCommands > 0 ||
      this.inFlightStarts.size > 0 ||
      this.pendingRevocations.size > 0
    ) {
      throw new RuntimeControlError(
        "SHUTDOWN_UNCERTAIN",
        "runtime operations remain unresolved",
        503
      )
    }
  }

  private async executeCommand(input: unknown): Promise<SupervisorCommandResult> {
    await this.initialize()
    const parsed = supervisorCommandSchema.safeParse(input)
    if (!parsed.success)
      throw new RuntimeControlError("INVALID_COMMAND", "invalid supervisor command", 400)
    const command = parsed.data
    if (command.type === "STOP") {
      const inFlight = this.inFlightStarts.get(command.attemptId)
      if (inFlight) {
        const accepted = this.acceptConcurrentStop(command, inFlight)
        await accepted.persisted
        return this.serialized(async () => {
          const state = this.commands.get(command.commandId)
          if (state && isTerminal(state.status)) return this.resultFor(command.commandId)
          return this.operations.stop(command, true, accepted.revocation)
        })
      }
    }
    return this.serialized(async () => {
      const requestHash = commandRequestHash(command)
      const existing = this.commands.get(command.commandId)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new RuntimeControlError(
            "IDEMPOTENCY_CONFLICT",
            "command id was reused with different input"
          )
        }
        return this.resultFor(command.commandId)
      }
      if (
        this.options.admission !== "open" &&
        command.type !== "STOP" &&
        command.type !== "RECONCILE"
      ) {
        throw new RuntimeControlError("ADMISSION_CLOSED", "runtime admission is closed", 403)
      }
      if (command.type === "PREPARE") return this.prepare(command)
      if (command.type === "STOP") return this.operations.stop(command)
      if (command.type === "RECONCILE") return this.operations.reconcile(command)
      return this.start(command)
    })
  }

  private acceptConcurrentStop(command: StopCommand, inFlight: InFlightStart) {
    if (inFlight.stop) {
      if (commandRequestHash(inFlight.stop.command) !== commandRequestHash(command)) {
        throw new RuntimeControlError("STOP_ALREADY_PENDING", "another stop is already pending")
      }
      return inFlight.stop
    }
    const existing = this.commands.get(command.commandId)
    if (existing)
      throw new RuntimeControlError("IDEMPOTENCY_CONFLICT", "command id is already in use")
    const attempt = this.attempts.get(command.attemptId)
    if (!attempt) throw new RuntimeControlError("ATTEMPT_NOT_FOUND", "attempt not found", 404)
    this.assertCurrentReceipt(attempt, command.expectedReceiptHash)
    const accepted: NonNullable<InFlightStart["stop"]> = {
      command,
      persisted: this.appendIntent(command),
    }
    inFlight.stop = accepted
    // STOP is durable before any revocation. Do not wait for a daemon create
    // or start acknowledgement before trying to revoke a bound provider grant.
    // The queued STOP repeats reconciliation and keeps uncertainty on failure.
    const revocation = accepted.persisted
      .then(() => this.operations.revokeAllKnownOrPotentialGrants(attempt, command.commandId))
      .catch(() => undefined)
    accepted.revocation = revocation
    this.pendingRevocations.add(revocation)
    void revocation.finally(() => this.pendingRevocations.delete(revocation))
    return accepted
  }

  private abortIfStopAccepted(attemptId: string): void {
    const stop = this.inFlightStarts.get(attemptId)?.stop
    if (!stop) return
    throw new Error("stop accepted while executor start was in progress")
  }

  async getAttempt(attemptId: string): Promise<{
    binding: AttemptBinding
    status: AttemptState["status"]
    receipt: SupervisorReceipt
    resources: ResourceOwnership[]
    grants: GrantBinding[]
  }> {
    await this.initialize()
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new RuntimeControlError("ATTEMPT_NOT_FOUND", "attempt not found", 404)
    return {
      binding: attempt.binding,
      status: attempt.status,
      receipt: attempt.receipt,
      resources: [...attempt.resources.values()],
      grants: [...attempt.grants.values()],
    }
  }

  async listOwnedContainers(scanId?: string): Promise<
    Array<{
      attemptId: string
      scanId: string
      executorKey: ExecutorKey
      containerId: string
      receiptHash: string
    }>
  > {
    await this.initialize()
    const result: Array<{
      attemptId: string
      scanId: string
      executorKey: ExecutorKey
      containerId: string
      createdAt: string
      running: boolean
      receiptHash: string
    }> = []
    for (const [attemptId, attempt] of this.attempts) {
      if (scanId && attempt.binding.scanId !== scanId) continue
      for (const resource of attempt.resources.values()) {
        if (resource.kind !== "container" || !resource.containerId) continue
        const inspection = await this.options.executor.inspect(resource)
        result.push({
          attemptId,
          scanId: attempt.binding.scanId,
          executorKey: resource.executorKey,
          containerId: resource.containerId,
          createdAt: resource.createdAt ?? attempt.binding.expiresAt,
          running: inspection.state === "PRESENT" && inspection.running === true,
          receiptHash: attempt.receipt.hash,
        })
      }
    }
    return result
  }

  private async prepare(command: Extract<SupervisorCommand, { type: "PREPARE" }>) {
    if (command.attempt.billingMode === "PAID" && !command.provider) {
      throw new RuntimeControlError(
        "PROVIDER_POLICY_REQUIRED",
        "paid execution requires a provider budget policy",
        400
      )
    }
    if (command.attempt.billingMode === "UNMETERED" && command.provider) {
      throw new RuntimeControlError(
        "PROVIDER_POLICY_NOT_ALLOWED",
        "unmetered execution may not hold provider grants",
        400
      )
    }
    const keys = new Set<ExecutorKey>()
    for (const plan of command.executors) {
      if (keys.has(plan.key))
        throw new RuntimeControlError("DUPLICATE_EXECUTOR_KEY", "executor keys must be unique", 400)
      keys.add(plan.key)
      assertExecutorAllowed(plan, this.options.policy)
    }
    if (this.attempts.has(command.attempt.attemptId)) {
      throw new RuntimeControlError(
        "ATTEMPT_CONFLICT",
        "attempt already exists with different input"
      )
    }
    // The broker must observe durable command acceptance before completion.
    // An interrupted intent stays unresolved and is never replayed on restart.
    await this.appendIntent(command)
    const record = await this.options.journal.append({
      type: "attempt_prepared",
      supervisorInstanceId: this.options.supervisorInstanceId,
      observedAt: this.nowIso(),
      commandId: command.commandId,
      binding: command.attempt,
      executors: command.executors,
      ...(command.provider ? { provider: command.provider } : {}),
    })
    this.apply(record)
    return this.resultFor(command.commandId)
  }

  private async start(command: StartCommand) {
    const attempt = this.attempts.get(command.attemptId)
    if (!attempt) throw new RuntimeControlError("ATTEMPT_NOT_FOUND", "attempt not found", 404)
    this.assertCurrentReceipt(attempt, command.expectedReceiptHash)
    if (attempt.status !== "PREPARED" && attempt.status !== "RUNNING") {
      throw new RuntimeControlError(
        "ATTEMPT_NOT_STARTABLE",
        "attempt cannot start another executor"
      )
    }
    const expectedMode = command.type === "START_PAID" ? "PAID" : "UNMETERED"
    if (attempt.binding.billingMode !== expectedMode) {
      return this.terminal(command, "REJECTED", "start command does not match attempt billing mode")
    }
    if (Date.parse(attempt.binding.expiresAt) <= (this.options.now?.() ?? new Date()).getTime()) {
      return this.terminal(command, "REJECTED", "attempt authorization has expired")
    }
    if (
      command.type === "START_PAID" &&
      [...this.commands.values()].some(
        (state) =>
          state.request &&
          state.request.type === "START_PAID" &&
          commandAttemptId(state.request) === command.attemptId
      )
    ) {
      return this.terminal(
        command,
        "REJECTED",
        "a paid start command already exists for this attempt"
      )
    }
    const plan = attempt.plans.get(command.executorKey)
    if (!plan)
      throw new RuntimeControlError("EXECUTOR_NOT_PREPARED", "executor was not prepared", 400)
    if (
      [...this.commands.values()].some(
        (state) =>
          state.request &&
          commandAttemptId(state.request) === command.attemptId &&
          START_TYPES.has(state.request.type) &&
          "executorKey" in state.request &&
          state.request.executorKey === command.executorKey
      )
    ) {
      return this.terminal(command, "REJECTED", "executor already has a start command")
    }

    const inFlight: InFlightStart = {}
    this.inFlightStarts.set(command.attemptId, inFlight)
    let physicalAttempted = false
    try {
      await this.appendIntent(command)
      this.abortIfStopAccepted(command.attemptId)
      // Durable create intent: the ownership identity is journaled before the
      // executor effect so a crash, failed follow-up append or a delayed daemon
      // response can never look like "nothing was ever created".
      const plannedOwnership = resourceOwnershipSchema.parse({
        executorKey: command.executorKey,
        kind: plan.spec.kind,
        ownershipId: deriveOwnershipId(
          attempt.binding.attemptId,
          command.commandId,
          command.executorKey
        ),
        ...(plan.spec.kind === "process" ? { cgroupPath: plan.spec.cgroupPath } : {}),
      })
      const plannedRecord = await this.options.journal.append({
        type: "resource_create_planned",
        supervisorInstanceId: this.options.supervisorInstanceId,
        observedAt: this.nowIso(),
        commandId: command.commandId,
        attemptId: attempt.binding.attemptId,
        executorKey: plannedOwnership.executorKey,
        kind: plannedOwnership.kind,
        ownershipId: plannedOwnership.ownershipId,
        ...(plannedOwnership.cgroupPath ? { cgroupPath: plannedOwnership.cgroupPath } : {}),
      })
      this.apply(plannedRecord)
      this.abortIfStopAccepted(command.attemptId)
      const context: ExecutorContext = {
        attemptId: attempt.binding.attemptId,
        commandId: command.commandId,
      }
      physicalAttempted = true
      if (command.type === "START_PAID") {
        await this.operations.ensureProviderGrant(attempt, command.commandId)
      }
      this.abortIfStopAccepted(command.attemptId)
      let ownership = await this.options.executor.create(command.executorKey, plan.spec, context)
      if (!matchesOwnership(plannedOwnership, ownership)) {
        throw new Error("executor create returned a foreign ownership identity")
      }
      let resourceRecord = await this.options.journal.append({
        type: "resource_bound",
        supervisorInstanceId: this.options.supervisorInstanceId,
        observedAt: this.nowIso(),
        commandId: command.commandId,
        attemptId: attempt.binding.attemptId,
        ownership,
      })
      this.applyResource(resourceRecord)
      const createAcknowledged = await this.options.journal.append({
        type: "resource_create_acknowledged",
        supervisorInstanceId: this.options.supervisorInstanceId,
        observedAt: this.nowIso(),
        commandId: command.commandId,
        attemptId: attempt.binding.attemptId,
        executorKey: command.executorKey,
      })
      this.apply(createAcknowledged)
      this.abortIfStopAccepted(command.attemptId)
      const startPlanned = await this.options.journal.append({
        type: "resource_start_planned",
        supervisorInstanceId: this.options.supervisorInstanceId,
        observedAt: this.nowIso(),
        commandId: command.commandId,
        attemptId: attempt.binding.attemptId,
        executorKey: command.executorKey,
      })
      this.apply(startPlanned)
      this.abortIfStopAccepted(command.attemptId)
      const started = await this.options.executor.start(ownership, plan.spec, context)
      if (!matchesOwnership(ownership, started)) {
        throw new Error("executor start returned a foreign ownership identity")
      }
      ownership = started
      resourceRecord = await this.options.journal.append({
        type: "resource_started",
        supervisorInstanceId: this.options.supervisorInstanceId,
        observedAt: this.nowIso(),
        commandId: command.commandId,
        attemptId: attempt.binding.attemptId,
        executorKey: command.executorKey,
        ownership,
      })
      this.applyResource(resourceRecord)
      this.abortIfStopAccepted(command.attemptId)
      await this.appendAttemptStatus(attempt, "RUNNING", command.commandId)
      await this.appendTerminal(command, "STARTED")
      return this.resultFor(command.commandId)
    } catch (error) {
      if (!physicalAttempted && !inFlight.stop) throw error
      if (inFlight.stop) await inFlight.stop.persisted
      const reason = error instanceof Error ? error.message : "executor effect is ambiguous"
      await this.appendAttemptStatus(attempt, "UNKNOWN", command.commandId)
      await this.appendTerminal(command, "UNKNOWN", reason.slice(0, 512))
      return this.resultFor(command.commandId)
    } finally {
      this.inFlightStarts.delete(command.attemptId)
    }
  }

  private startCommandIdFor(attemptId: string, executorKey: ExecutorKey): string | null {
    let latest: string | null = null
    for (const state of this.commands.values()) {
      const request = state.request
      if (
        request &&
        commandAttemptId(request) === attemptId &&
        START_TYPES.has(request.type) &&
        "executorKey" in request &&
        request.executorKey === executorKey
      ) {
        latest = request.commandId
      }
    }
    return latest
  }

  private hasUnresolvedExecutorEffect(attempt: AttemptState): boolean {
    return [...attempt.planned.keys()].some(
      (key) =>
        !attempt.createAcknowledged.has(key) ||
        (attempt.startPlanned.has(key) && !attempt.startAcknowledged.has(key))
    )
  }

  private assertCurrentReceipt(attempt: AttemptState, expected: string): void {
    if (!timingSafeStringEqual(attempt.receipt.hash, expected)) {
      throw new RuntimeControlError("STALE_RECEIPT", "expected attempt receipt is stale or invalid")
    }
  }

  private async appendIntent(command: SupervisorCommand): Promise<void> {
    const record = await this.options.journal.append({
      type: "command_intent",
      supervisorInstanceId: this.options.supervisorInstanceId,
      observedAt: this.nowIso(),
      command,
    })
    this.apply(record)
  }

  private async appendAttemptStatus(
    attempt: AttemptState,
    status: AttemptState["status"],
    commandId: string
  ): Promise<void> {
    const record = await this.options.journal.append({
      type: "attempt_status",
      supervisorInstanceId: this.options.supervisorInstanceId,
      observedAt: this.nowIso(),
      attemptId: attempt.binding.attemptId,
      commandId,
      status,
    })
    this.apply(record)
  }

  private async appendTerminal(
    command: SupervisorCommand,
    status: CommandStatus,
    reason?: string
  ): Promise<SupervisorCommandResult> {
    const record = await this.options.journal.append({
      type: "command_terminal",
      supervisorInstanceId: this.options.supervisorInstanceId,
      observedAt: this.nowIso(),
      commandId: command.commandId,
      attemptId: commandAttemptId(command),
      status,
      ...(reason ? { reason } : {}),
    })
    this.apply(record)
    return this.resultFor(command.commandId)
  }

  private async terminal(command: SupervisorCommand, status: CommandStatus, reason?: string) {
    await this.appendIntent(command)
    return this.appendTerminal(command, status, reason)
  }

  private resultFor(commandId: string): SupervisorCommandResult {
    const state = this.commands.get(commandId)
    if (!state) throw new RuntimeControlError("COMMAND_NOT_FOUND", "command not found", 404)
    return {
      commandId,
      attemptId: state.attemptId,
      status: state.status,
      ...(state.reason ? { reason: state.reason } : {}),
      receipt: state.receipt,
    }
  }

  private apply(record: JournalRecord<SupervisorJournalEvent>): void {
    applyJournalRecord(record, this.attempts, this.commands)
  }

  private applyResource(record: JournalRecord<SupervisorJournalEvent>): void {
    this.apply(record)
  }

  private async load(): Promise<void> {
    restoreJournalState(await this.options.journal.load(), this.attempts, this.commands)
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult: (value: T) => void = () => undefined
    let rejectResult: (error: unknown) => void = () => undefined
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
    const run = this.serial.then(async () => {
      try {
        resolveResult(await operation())
      } catch (error) {
        rejectResult(error)
      }
    })
    this.serial = run.catch(() => undefined)
    await run
    return result
  }
}
