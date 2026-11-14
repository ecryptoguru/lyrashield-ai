import type {
  ExecutorKey,
  ExecutorSpec,
  ResourceOwnership,
  ResourceInspection,
} from "@lyrashield/runtime-control"
import {
  deriveOwnershipId,
  type RuntimeExecutor,
  type ExecutorContext,
  type NativeRetirement,
} from "../../../../apps/supervisor/src/executor"

/** Real durable fence and signed ACK path, simulated native container effects only. */
export class LifecycleFixtureExecutor implements RuntimeExecutor {
  toolRetirements: unknown[] = []
  createCalls = 0
  startCalls = 0
  stopCalls = 0
  private resources = new Map<string, ResourceInspection>()
  async create(
    key: ExecutorKey,
    _spec: ExecutorSpec,
    context: ExecutorContext
  ): Promise<ResourceOwnership> {
    context.assertActive()
    if (!context.nativeInvocation) throw new Error("Real native guard required")
    const ownership: ResourceOwnership = {
      executorKey: key,
      kind: "container",
      ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
      containerId: (++this.createCalls).toString(16).padStart(64, "0"),
      createdAt: new Date().toISOString(),
    }
    const inspection: ResourceInspection = { state: "PRESENT", running: false, ownership }
    this.resources.set(ownership.ownershipId, inspection)
    await context.nativeInvocation.acknowledge({
      operation: "CONTAINER_CREATE_ACK",
      nativeRequestId: context.nativeInvocation.requestId,
      inspection,
    })
    return ownership
  }
  async start(ownership: ResourceOwnership, _spec: ExecutorSpec, context: ExecutorContext) {
    context.assertActive()
    if (!context.nativeInvocation) throw new Error("Real native guard required")
    this.startCalls++
    const inspection: ResourceInspection = { state: "PRESENT", running: true, ownership }
    this.resources.set(ownership.ownershipId, inspection)
    await context.nativeInvocation.acknowledge({
      operation: "CONTAINER_START_ACK",
      nativeRequestId: context.nativeInvocation.requestId,
      inspection,
    })
    return ownership
  }
  async inspect(ownership: ResourceOwnership): Promise<ResourceInspection> {
    return this.resources.get(ownership.ownershipId) ?? { state: "ABSENT" }
  }
  async stop(
    ownership: ResourceOwnership,
    _graceMs?: number,
    retirement?: NativeRetirement
  ): Promise<ResourceInspection> {
    this.stopCalls++
    this.resources.delete(ownership.ownershipId)
    if (ownership.executorKey === "sandbox" && this.toolRetirements.length) {
      if (!retirement?.acknowledgeTools) throw new Error("Tool retirement source is unavailable")
      await retirement.acknowledgeTools(this.toolRetirements)
      this.toolRetirements = []
    }
    return { state: "ABSENT" }
  }
}
