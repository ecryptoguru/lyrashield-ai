import {
  supervisorCommandSchema,
  IndependentAuthorityError,
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
  type ScanAuthorityFence,
} from "@lyrashield/runtime-control"
import type { JournalPort, JournalRecord } from "@lyrashield/runtime-control"
import type { RuntimeExecutor } from "./executor"
import type { SupervisorPolicy } from "./policy"
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
import { loadServiceState, recoverServiceState, retryInitialization } from "./service-recovery"
import { readSupervisorAttempt, readSupervisorContainers } from "./supervisor-resources"
import { startFencedExecutor } from "./supervisor-start-executor"
import { SupervisorOperations } from "./supervisor-operations"
import {
  RuntimeControlError,
  commandAttemptId,
  commandRequestHash,
  isTerminal,
  matchesOwnership,
  timingSafeStringEqual,
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
  authorityFence?: ScanAuthorityFence
  now?: () => Date
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
      resultFor: (commandId) => this.resultFor(commandId),
    })
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const attempt = (this.initialized = this.load())
      retryInitialization(attempt, () => {
        if (this.initialized === attempt) this.initialized = null
      })
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
        return this.serializedCommand(async () => {
          const state = this.commands.get(command.commandId)
          if (state && isTerminal(state.status)) return this.resultFor(command.commandId)
          return this.operations.stop(command, true, accepted.revocation)
        })
      }
    }
    return this.serializedCommand(async () => {
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
      if (command.type === "PREPARE") return this.operations.prepare(command)
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
    return readSupervisorAttempt(this.attempts, attemptId)
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
    return readSupervisorContainers(this.attempts, this.options.executor, scanId)
  }

  private async start(command: StartCommand) {
    const authorityFence = this.options.authorityFence
    if (!authorityFence)
      throw new RuntimeControlError(
        "AUTHORITY_UNAVAILABLE",
        "Native scan authority is unavailable",
        503
      )
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
    let creationFenceEntered = false
    try {
      await this.appendIntent(command)
      this.abortIfStopAccepted(command.attemptId)
      physicalAttempted = true
      const context = await this.operations.executorContext(attempt, command)
      this.abortIfStopAccepted(command.attemptId)
      const created = await this.operations.createFencedExecutor(
        attempt,
        command,
        plan.spec,
        context,
        () => {
          creationFenceEntered = true
        },
        () => this.abortIfStopAccepted(command.attemptId)
      )
      let { ownership } = created
      if (!matchesOwnership(created.planned, ownership)) {
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
      await this.operations.recordExecutorStartIntent(attempt, command)
      this.abortIfStopAccepted(command.attemptId)
      const started = await startFencedExecutor({
        service: this.options,
        operations: this.operations,
        attempt,
        command,
        spec: plan.spec,
        context,
        ownership,
        checkStop: () => this.abortIfStopAccepted(command.attemptId),
        nowIso: () => this.nowIso(),
        apply: (record) => this.apply(record),
      })
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
      return await this.handleStartFailure(
        error,
        attempt,
        command,
        inFlight,
        physicalAttempted,
        creationFenceEntered
      )
    } finally {
      this.inFlightStarts.delete(command.attemptId)
    }
  }

  private async handleStartFailure(
    error: unknown,
    attempt: AttemptState,
    command: StartCommand,
    inFlight: InFlightStart,
    physicalAttempted: boolean,
    creationFenceEntered: boolean
  ) {
    if (error instanceof IndependentAuthorityError) {
      if (inFlight.stop) await inFlight.stop.persisted.catch(() => undefined)
      throw error
    }
    if (!physicalAttempted && !inFlight.stop) throw error
    if (physicalAttempted && !creationFenceEntered && !inFlight.stop) {
      const rejected = await this.operations.rejectUnstarted(attempt, command, () =>
        Boolean(inFlight.stop)
      )
      if (rejected) return rejected
    }
    if (inFlight.stop) await inFlight.stop.persisted
    const reason =
      error instanceof RuntimeControlError ? error.code : "executor or provider outcome unavailable"
    await this.appendAttemptStatus(attempt, "UNKNOWN", command.commandId)
    await this.appendTerminal(command, "UNKNOWN", reason.slice(0, 512))
    return this.resultFor(command.commandId)
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
    return loadServiceState(
      this.options.journal,
      () => this.inFlightStarts.size > 0 || this.pendingRevocations.size > 0,
      (records) => restoreJournalState(records, this.attempts, this.commands)
    )
  }

  private async serializedCommand<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      try {
        await this.initialize()
        return await operation()
      } catch (error) {
        if (error instanceof IndependentAuthorityError) this.initialized = null
        throw error
      }
    })
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
