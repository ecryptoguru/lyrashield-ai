import type {
  CommandStatus,
  ExecutorKey,
  ExecutorSpec,
  JournalRecord,
  ProviderGrant,
  ProviderGrantRequest,
  ProviderGrantStatus,
  ResourceOwnership,
  StartCommand,
  StopCommand,
  SupervisorCommand,
  SupervisorCommandResult,
} from "@lyrashield/runtime-control"
import { providerGrantSchema, resourceOwnershipSchema } from "@lyrashield/runtime-control"
import { executorActionBinding } from "./executor-action-binding"
import { chainChecks, deriveOwnershipId, type ExecutorContext } from "./executor"
import type {
  AttemptState,
  CommandState,
  GrantBinding,
  SupervisorJournalEvent,
} from "./journal-events"
import { RuntimeControlError, matchesOwnership } from "./service-common"
import { nativeInvocationAcknowledgement } from "./native-ack-producer"
import { nativeRetirementEvidence } from "./native-retirement-producer"
import { prepareSupervisorAttempt } from "./supervisor-prepare"
import type { SupervisorServiceOptions } from "./service"

export interface SupervisorOperationsContext {
  options: SupervisorServiceOptions
  attempts: Map<string, AttemptState>
  commands: Map<string, CommandState>
  nowIso: () => string
  apply: (record: JournalRecord<SupervisorJournalEvent>) => void
  applyResource: (record: JournalRecord<SupervisorJournalEvent>) => void
  assertCurrentReceipt: (attempt: AttemptState, expected: string) => void
  appendIntent: (command: SupervisorCommand) => Promise<void>
  appendAttemptStatus: (
    attempt: AttemptState,
    status: AttemptState["status"],
    commandId: string
  ) => Promise<void>
  appendTerminal: (
    command: SupervisorCommand,
    status: CommandStatus,
    reason?: string
  ) => Promise<SupervisorCommandResult>
  hasUnresolvedExecutorEffect: (attempt: AttemptState) => boolean
  startCommandIdFor: (attemptId: string, executorKey: ExecutorKey) => string | null
  resultFor: (commandId: string) => SupervisorCommandResult
}

export class SupervisorOperations {
  constructor(private readonly ctx: SupervisorOperationsContext) {}

  async rejectUnstarted(
    attempt: AttemptState,
    command: StartCommand,
    stopAccepted: () => boolean
  ): Promise<SupervisorCommandResult | null> {
    if (attempt.planned.size || attempt.resources.size) return null
    try {
      await this.revokeAllKnownOrPotentialGrants(attempt, command.commandId)
    } catch {
      return null
    }
    if (stopAccepted()) return null
    await this.ctx.appendAttemptStatus(attempt, "NEVER_DISPATCHED", command.commandId)
    return this.ctx.appendTerminal(command, "NEVER_DISPATCHED", "executor creation was not invoked")
  }

  async recordExecutorStartIntent(attempt: AttemptState, command: StartCommand): Promise<void> {
    const startPlanned = await this.ctx.options.journal.append({
      type: "resource_start_planned",
      supervisorInstanceId: this.ctx.options.supervisorInstanceId,
      observedAt: this.ctx.nowIso(),
      commandId: command.commandId,
      attemptId: attempt.binding.attemptId,
      executorKey: command.executorKey,
    })
    this.ctx.apply(startPlanned)
  }

  async createFencedExecutor(
    attempt: AttemptState,
    command: StartCommand,
    spec: ExecutorSpec,
    context: Omit<ExecutorContext, "assertActive">,
    entered: () => void,
    checkStop: () => void
  ): Promise<{ planned: ResourceOwnership; ownership: ResourceOwnership }> {
    return this.withExecutorAuthority(
      attempt,
      command,
      "EXECUTOR_CREATE",
      async (assertActive, nativeInvocation) => {
        entered()
        assertActive()
        checkStop()
        const planned = await this.recordExecutorCreationIntent(attempt, command, spec)
        await nativeInvocation?.planCreate?.(planned)
        assertActive()
        checkStop()
        const ownership = await this.ctx.options.executor.create(command.executorKey, spec, {
          ...context,
          assertActive: chainChecks(assertActive, checkStop),
          ...(nativeInvocation ? { nativeInvocation } : {}),
        })
        return { planned, ownership }
      }
    )
  }

  async recordExecutorCreationIntent(
    attempt: AttemptState,
    command: StartCommand,
    spec: ExecutorSpec
  ): Promise<ResourceOwnership> {
    const plannedOwnership = resourceOwnershipSchema.parse({
      executorKey: command.executorKey,
      kind: spec.kind,
      ownershipId: deriveOwnershipId(
        attempt.binding.attemptId,
        command.commandId,
        command.executorKey
      ),
      ...(spec.kind === "process" ? { cgroupPath: spec.cgroupPath } : {}),
    })
    const plannedRecord = await this.ctx.options.journal.append({
      type: "resource_create_planned",
      supervisorInstanceId: this.ctx.options.supervisorInstanceId,
      observedAt: this.ctx.nowIso(),
      commandId: command.commandId,
      attemptId: attempt.binding.attemptId,
      executorKey: plannedOwnership.executorKey,
      kind: plannedOwnership.kind,
      ownershipId: plannedOwnership.ownershipId,
      ...(plannedOwnership.cgroupPath ? { cgroupPath: plannedOwnership.cgroupPath } : {}),
    })
    this.ctx.apply(plannedRecord)
    return plannedOwnership
  }

  async withExecutorAuthority<T>(
    attempt: AttemptState,
    command: StartCommand,
    phase: "EXECUTOR_CREATE" | "EXECUTOR_START",
    effect: (
      assertActive: () => void,
      nativeInvocation?: ExecutorContext["nativeInvocation"]
    ) => T | Promise<T>
  ): Promise<T> {
    const authorityFence = this.ctx.options.authorityFence
    if (!authorityFence)
      throw new RuntimeControlError(
        "AUTHORITY_UNAVAILABLE",
        "Native scan authority is unavailable",
        503
      )
    const binding = executorActionBinding(attempt, command, phase)
    return authorityFence.run(binding, (assertActive, invocation) =>
      effect(
        assertActive,
        invocation
          ? nativeInvocationAcknowledgement({
              journal: this.ctx.options.journal,
              supervisorInstanceId: this.ctx.options.supervisorInstanceId,
              nowIso: this.ctx.nowIso,
              apply: this.ctx.apply,
              attempt,
              command,
              binding,
              guardId: invocation.guardId,
              assertActive,
            })
          : undefined
      )
    )
  }

  async prepare(command: Extract<SupervisorCommand, { type: "PREPARE" }>) {
    return prepareSupervisorAttempt(this.ctx, command)
  }

  async stop(
    command: StopCommand,
    alreadyAccepted = false,
    priorRevocation?: Promise<void>
  ): Promise<SupervisorCommandResult> {
    const attempt = this.ctx.attempts.get(command.attemptId)
    if (!attempt) throw new RuntimeControlError("ATTEMPT_NOT_FOUND", "attempt not found", 404)
    if (!alreadyAccepted) {
      this.ctx.assertCurrentReceipt(attempt, command.expectedReceiptHash)
      await this.ctx.appendIntent(command)
    }
    await this.ctx.appendAttemptStatus(attempt, "STOPPING", command.commandId)
    const revocationOutcome = (async () => {
      await priorRevocation
      await this.revokeAllKnownOrPotentialGrants(attempt, command.commandId)
      return false
    })().catch(() => true)

    const recorded = [...attempt.resources.values()].reverse()
    const plannedOnly = [...attempt.planned.values()].filter(
      (planned) => !attempt.resources.has(planned.executorKey)
    )
    if (recorded.length === 0 && plannedOnly.length === 0) {
      const revocationUnresolved = await revocationOutcome
      if (revocationUnresolved) {
        return this.ctx.appendTerminal(
          command,
          "UNKNOWN",
          "provider grant revocation is unresolved"
        )
      }
      await this.ctx.appendAttemptStatus(attempt, "NEVER_DISPATCHED", command.commandId)
      return this.ctx.appendTerminal(command, "NEVER_DISPATCHED")
    }
    let anyDispatch = recorded.length > 0
    let createUnresolved = this.ctx.hasUnresolvedExecutorEffect(attempt)
    let resourceUnresolved = false
    for (const resource of recorded) {
      const nativeRetirement = nativeRetirementEvidence({
        journal: this.ctx.options.journal,
        supervisorInstanceId: this.ctx.options.supervisorInstanceId,
        nowIso: this.ctx.nowIso,
        apply: this.ctx.apply,
        attempt,
        stop: command,
        ownership: resource,
      })
      const inspection = await this.ctx.options.executor
        .stop(resource, undefined, nativeRetirement)
        .catch(() => ({
          state: "UNKNOWN" as const,
          detail: "owned resource teardown failed",
        }))
      if (inspection.state !== "ABSENT") {
        resourceUnresolved = true
      }
    }
    // Create-intent window: create may have taken effect without a recorded
    // resource_bound event. Inspect the planned ownership identity, but keep
    // the outcome UNKNOWN until a create acknowledgement is established.
    for (const planned of plannedOnly) {
      const inspection = await this.ctx.options.executor.inspect(planned).catch(() => ({
        state: "UNKNOWN" as const,
        detail: "planned executor inspection failed",
      }))
      if (inspection.state === "UNKNOWN") {
        resourceUnresolved = true
        continue
      }
      if (inspection.state !== "PRESENT") {
        if (attempt.nativeStartIntents?.get(planned.executorKey)?.phase === "EXECUTOR_CREATE") {
          const retirement = nativeRetirementEvidence({
            journal: this.ctx.options.journal,
            supervisorInstanceId: this.ctx.options.supervisorInstanceId,
            nowIso: this.ctx.nowIso,
            apply: this.ctx.apply,
            attempt,
            stop: command,
            ownership: planned,
          })
          const stopped = await this.ctx.options.executor
            .stop(planned, undefined, retirement)
            .catch(() => ({ state: "UNKNOWN" as const }))
          if (stopped.state !== "ABSENT") resourceUnresolved = true
          continue
        }
        createUnresolved = true
        continue
      }
      anyDispatch = true
      if (!inspection.ownership || !matchesOwnership(planned, inspection.ownership)) {
        resourceUnresolved = true
        continue
      }
      const owned = inspection.ownership
      if (attempt.nativeStartIntents?.get(planned.executorKey)?.phase === "EXECUTOR_CREATE") {
        const retirement = nativeRetirementEvidence({
          journal: this.ctx.options.journal,
          supervisorInstanceId: this.ctx.options.supervisorInstanceId,
          nowIso: this.ctx.nowIso,
          apply: this.ctx.apply,
          attempt,
          stop: command,
          ownership: owned,
        })
        const stopped = await this.ctx.options.executor
          .stop(owned, undefined, retirement)
          .catch(() => ({ state: "UNKNOWN" as const }))
        if (stopped.state !== "ABSENT") resourceUnresolved = true
        continue
      }
      const boundRecord = await this.ctx.options.journal.append({
        type: "resource_bound",
        supervisorInstanceId: this.ctx.options.supervisorInstanceId,
        observedAt: this.ctx.nowIso(),
        commandId: command.commandId,
        attemptId: attempt.binding.attemptId,
        ownership: owned,
      })
      this.ctx.applyResource(boundRecord)
      const retirement = nativeRetirementEvidence({
        journal: this.ctx.options.journal,
        supervisorInstanceId: this.ctx.options.supervisorInstanceId,
        nowIso: this.ctx.nowIso,
        apply: this.ctx.apply,
        attempt,
        stop: command,
        ownership: owned,
      })
      const stopped = await this.ctx.options.executor
        .stop(owned, undefined, retirement)
        .catch(() => ({
          state: "UNKNOWN" as const,
          detail: "planned executor teardown failed",
        }))
      if (stopped.state !== "ABSENT") {
        resourceUnresolved = true
      }
    }
    createUnresolved = this.ctx.hasUnresolvedExecutorEffect(attempt)
    const revocationUnresolved = await revocationOutcome
    const nativeGuardUnresolved = (attempt.nativeStartIntents?.size ?? 0) > 0
    if (revocationUnresolved || createUnresolved || resourceUnresolved || nativeGuardUnresolved) {
      return this.ctx.appendTerminal(
        command,
        "UNKNOWN",
        revocationUnresolved
          ? "provider grant or settlement is unresolved"
          : "executor cleanup, creation or original invocation is unresolved"
      )
    }
    const status = anyDispatch ? "STOPPED" : "NEVER_DISPATCHED"
    await this.ctx.appendAttemptStatus(attempt, status, command.commandId)
    return this.ctx.appendTerminal(command, status)
  }

  async reconcile(
    command: Extract<SupervisorCommand, { type: "RECONCILE" }>
  ): Promise<SupervisorCommandResult> {
    const attempt = this.ctx.attempts.get(command.attemptId)
    if (!attempt) throw new RuntimeControlError("ATTEMPT_NOT_FOUND", "attempt not found", 404)
    this.ctx.assertCurrentReceipt(attempt, command.expectedReceiptHash)
    await this.ctx.appendIntent(command)
    const stopRequested =
      this.ctx.options.admission !== "open" ||
      attempt.status === "STOPPING" ||
      attempt.status === "UNKNOWN"
    const retainedStop = [...this.ctx.commands.values()]
      .map((state) => state.request)
      .reverse()
      .find(
        (request): request is StopCommand =>
          request?.type === "STOP" && request.attemptId === command.attemptId
      )
    const retirementFor = (ownership: ResourceOwnership) =>
      retainedStop
        ? nativeRetirementEvidence({
            journal: this.ctx.options.journal,
            supervisorInstanceId: this.ctx.options.supervisorInstanceId,
            nowIso: this.ctx.nowIso,
            apply: this.ctx.apply,
            attempt,
            stop: retainedStop,
            ownership,
          })
        : undefined
    const revocationOutcome = stopRequested
      ? this.revokeAllKnownOrPotentialGrants(attempt, command.commandId).then(
          () => false,
          () => true
        )
      : Promise.resolve(false)

    let observedPresent = false
    let createUnresolved = this.ctx.hasUnresolvedExecutorEffect(attempt)
    let resourceUnresolved = false
    for (const plan of attempt.plans.values()) {
      const current = attempt.resources.get(plan.key)
      const planned = attempt.planned.get(plan.key)
      if (!current && !planned) continue
      const startCommandId = this.ctx.startCommandIdFor(attempt.binding.attemptId, plan.key)
      const candidate =
        current ??
        planned ??
        ({
          executorKey: plan.key,
          kind: plan.spec.kind,
          ownershipId: deriveOwnershipId(
            attempt.binding.attemptId,
            startCommandId ?? command.commandId,
            plan.key
          ),
          ...(plan.spec.kind === "process" ? { cgroupPath: plan.spec.cgroupPath } : {}),
        } satisfies ResourceOwnership)
      const inspection = await this.ctx.options.executor.inspect(candidate).catch(() => ({
        state: "UNKNOWN" as const,
        detail: "resource inspection failed",
      }))
      if (inspection.state === "UNKNOWN") {
        if (stopRequested) {
          resourceUnresolved = true
          continue
        }
        return this.ctx.appendTerminal(
          command,
          "UNKNOWN",
          inspection.detail ?? "resource inspection unavailable"
        )
      }
      if (inspection.state === "PRESENT") {
        if (!inspection.ownership || !matchesOwnership(candidate, inspection.ownership)) {
          if (stopRequested) {
            resourceUnresolved = true
            continue
          }
          await this.ctx.appendAttemptStatus(attempt, "UNKNOWN", command.commandId)
          return this.ctx.appendTerminal(command, "UNKNOWN", "executor ownership is unresolved")
        }
        if (!stopRequested && inspection.running !== true) {
          await this.ctx.appendAttemptStatus(attempt, "UNKNOWN", command.commandId)
          return this.ctx.appendTerminal(command, "UNKNOWN", "resource is not confirmed running")
        }
        observedPresent = true
        const owned = current ?? inspection.ownership ?? candidate
        if (!current && inspection.ownership) {
          const record = await this.ctx.options.journal.append({
            type: "resource_bound",
            supervisorInstanceId: this.ctx.options.supervisorInstanceId,
            observedAt: this.ctx.nowIso(),
            commandId: startCommandId ?? command.commandId,
            attemptId: attempt.binding.attemptId,
            ownership: inspection.ownership,
          })
          this.ctx.applyResource(record)
        }
        if (stopRequested) {
          const stopped = await this.ctx.options.executor
            .stop(owned, undefined, retirementFor(owned))
            .catch(() => ({
              state: "UNKNOWN" as const,
              detail: "resource teardown failed",
            }))
          if (stopped.state !== "ABSENT") {
            resourceUnresolved = true
          }
        }
      } else if (stopRequested && retirementFor(candidate)) {
        // A previous STOP may have removed the container before its ACK was
        // received. Reuse only that stored STOP's actual root removal proof.
        const stopped = await this.ctx.options.executor
          .stop(candidate, undefined, retirementFor(candidate))
          .catch(() => ({ state: "UNKNOWN" as const }))
        if (stopped.state !== "ABSENT") resourceUnresolved = true
      } else if (planned && !current) {
        if (!stopRequested) {
          await this.ctx.appendAttemptStatus(attempt, "UNKNOWN", command.commandId)
          return this.ctx.appendTerminal(command, "UNKNOWN", "executor creation is unresolved")
        }
        createUnresolved = true
      }
    }
    if (stopRequested) {
      createUnresolved = this.ctx.hasUnresolvedExecutorEffect(attempt)
      const revocationUnresolved = await revocationOutcome
      if (
        revocationUnresolved ||
        createUnresolved ||
        resourceUnresolved ||
        (attempt.nativeStartIntents?.size ?? 0) > 0
      ) {
        return this.ctx.appendTerminal(
          command,
          "UNKNOWN",
          revocationUnresolved
            ? "provider grant or settlement is unresolved"
            : "executor cleanup or creation is unresolved"
        )
      }
      let activeGrants: GrantBinding[]
      try {
        activeGrants = [...attempt.grants.values(), ...(await this.lookupPotentialGrants(attempt))]
      } catch {
        return this.ctx.appendTerminal(command, "UNKNOWN", "provider grant status is unavailable")
      }
      if (activeGrants.some((grant) => !grant.revoked)) {
        return this.ctx.appendTerminal(command, "UNKNOWN", "provider grants remain active")
      }
      // A create intent alone is not dispatch. NEVER_DISPATCHED stays honest
      // only when no resource was ever bound and every planned executor was
      // inspected ABSENT in this reconcile pass.
      const anyDispatch =
        attempt.resources.size > 0 || observedPresent || (attempt.nativeRetirements?.size ?? 0) > 0
      const status = anyDispatch ? "STOPPED" : "NEVER_DISPATCHED"
      await this.ctx.appendAttemptStatus(attempt, status, command.commandId)
      return this.ctx.appendTerminal(command, status)
    }
    if (observedPresent) {
      await this.ctx.appendAttemptStatus(attempt, "RUNNING", command.commandId)
      return this.ctx.appendTerminal(command, "STARTED")
    }
    await this.ctx.appendAttemptStatus(attempt, "UNKNOWN", command.commandId)
    return this.ctx.appendTerminal(command, "UNKNOWN", "terminal cleanup has not been established")
  }

  async executorContext(attempt: AttemptState, command: StartCommand) {
    const context = { attemptId: attempt.binding.attemptId, commandId: command.commandId }
    if (command.type !== "START_PAID") return context
    const grant = await this.ensureProviderGrant(attempt, command.commandId)
    return {
      ...context,
      provider: {
        token: grant.token,
        providerId: grant.providerId,
        gatewayUrl: this.ctx.options.providerGatewayUrl,
        scanId: attempt.binding.scanId,
      },
    }
  }

  private async ensureProviderGrant(
    attempt: AttemptState,
    grantRequestId: string
  ): Promise<ProviderGrant> {
    const policy = attempt.provider
    if (!policy)
      throw new RuntimeControlError("PROVIDER_POLICY_REQUIRED", "provider policy is missing", 400)
    const request: ProviderGrantRequest = {
      grantRequestId,
      attemptId: attempt.binding.attemptId,
      scanId: attempt.binding.scanId,
      workspaceId: attempt.binding.workspaceId,
      operationId: attempt.binding.operationId,
      authorityEpochId: attempt.binding.authorityEpochId,
      authorityRevision: attempt.binding.authorityRevision,
      expiresAt: attempt.binding.expiresAt,
      providerId: policy.providerId,
      maxRequests: policy.maxRequests,
      costReservationMicros: policy.costReservationMicros,
      maxReservedCostMicros: policy.maxReservedCostMicros,
    }
    const existing = attempt.grants.get(policy.providerId)
    if (existing && !existing.revoked) {
      const origin = existing.grantRequestId
        ? this.ctx.commands.get(existing.grantRequestId)?.request
        : undefined
      if (origin?.type !== "START_PAID" || origin.attemptId !== attempt.binding.attemptId)
        throw new RuntimeControlError("GRANT_BINDING_MISMATCH", "provider grant origin is missing")
      const recovered = providerGrantSchema.safeParse(
        await this.ctx.options.providerGateway.findGrantByRequest(origin.commandId)
      )
      if (
        !recovered.success ||
        recovered.data.grantId !== existing.grantId ||
        recovered.data.attemptId !== attempt.binding.attemptId ||
        recovered.data.providerId !== policy.providerId ||
        recovered.data.expiresAt !== attempt.binding.expiresAt
      )
        throw new RuntimeControlError("GRANT_BINDING_MISMATCH", "provider grant recovery failed")
      return recovered.data
    }
    if (existing)
      throw new RuntimeControlError("GRANT_BINDING_MISMATCH", "provider grant was revoked")
    const received = providerGrantSchema.safeParse(
      await this.ctx.options.providerGateway.issueGrant(request)
    )
    if (
      !received.success ||
      received.data.attemptId !== attempt.binding.attemptId ||
      received.data.providerId !== policy.providerId ||
      received.data.expiresAt !== attempt.binding.expiresAt
    ) {
      throw new RuntimeControlError(
        "GRANT_BINDING_MISMATCH",
        "provider gateway returned a foreign grant"
      )
    }
    const grant = received.data
    const record = await this.ctx.options.journal.append({
      type: "provider_grants_bound",
      supervisorInstanceId: this.ctx.options.supervisorInstanceId,
      observedAt: this.ctx.nowIso(),
      commandId: grantRequestId,
      attemptId: attempt.binding.attemptId,
      grants: [{ providerId: grant.providerId, grantId: grant.grantId, revoked: false }],
    })
    this.ctx.apply(record)
    return grant
  }

  async revokeAllKnownOrPotentialGrants(attempt: AttemptState, commandId: string): Promise<void> {
    const known = [...attempt.grants.values()]
    const discovered = await this.lookupPotentialGrants(attempt)
    if (known.some((grant) => !discovered.some((found) => found.grantId === grant.grantId))) {
      throw new Error("known provider grant could not be independently located")
    }
    const all = new Map<string, GrantBinding>()
    for (const grant of [...known, ...discovered]) all.set(grant.grantId, grant)
    let settlementUnresolved = false
    for (const grant of all.values()) {
      if (grant.unsettled) settlementUnresolved = true
      if (grant.revoked) continue
      const status: ProviderGrantStatus = await this.ctx.options.providerGateway.revokeGrant({
        grantId: grant.grantId,
        attemptId: attempt.binding.attemptId,
        reason: "supervisor-stop",
      })
      if (
        !status.revokedAt ||
        status.grantId !== grant.grantId ||
        status.attemptId !== attempt.binding.attemptId ||
        status.providerId !== grant.providerId
      )
        throw new Error("provider gateway did not acknowledge the bound revocation")
      if (status.requestCount > 0) settlementUnresolved = true
      all.set(grant.grantId, { ...grant, revoked: true })
    }
    if (all.size > 0) {
      const record = await this.ctx.options.journal.append({
        type: "provider_grants_revoked",
        supervisorInstanceId: this.ctx.options.supervisorInstanceId,
        observedAt: this.ctx.nowIso(),
        commandId,
        attemptId: attempt.binding.attemptId,
        grantIds: [...all.keys()],
      })
      this.ctx.apply(record)
    }
    // The prototype has no authoritative provider settlement protocol. A
    // revoked local token cannot prove an upstream request stopped or was free.
    if (settlementUnresolved) throw new Error("provider settlement is unresolved")
  }

  private async lookupPotentialGrants(attempt: AttemptState): Promise<GrantBinding[]> {
    const found: GrantBinding[] = []
    const grantRequestId = attempt.provider
      ? attempt.grants.get(attempt.provider.providerId)?.grantRequestId
      : undefined
    for (const state of this.ctx.commands.values()) {
      const request = state.request
      if (
        !request ||
        request.type !== "START_PAID" ||
        request.attemptId !== attempt.binding.attemptId ||
        (grantRequestId !== undefined && request.commandId !== grantRequestId)
      )
        continue
      const grant = await this.ctx.options.providerGateway.findGrantByRequest(request.commandId)
      if (!grant) {
        if (state.status === "REJECTED" && !attempt.planned.has(request.executorKey)) continue
        throw new Error("provider grant outcome remains unresolved")
      }
      if (grant.attemptId !== attempt.binding.attemptId) {
        throw new RuntimeControlError(
          "GRANT_BINDING_MISMATCH",
          "provider gateway returned a foreign grant"
        )
      }
      const status = await this.ctx.options.providerGateway.inspectGrant(grant.grantId)
      if (
        !status ||
        status.grantId !== grant.grantId ||
        status.attemptId !== attempt.binding.attemptId ||
        status.providerId !== grant.providerId
      )
        throw new Error("provider grant status is unavailable or foreign")
      found.push({
        providerId: grant.providerId,
        grantId: grant.grantId,
        revoked: Boolean(status.revokedAt),
        unsettled: status.requestCount > 0,
      })
    }
    return found
  }
}
