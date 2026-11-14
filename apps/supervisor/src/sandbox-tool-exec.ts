import { createHash } from "node:crypto"
import { posix } from "node:path"
import {
  authorityActionSchema,
  canonicalJson,
  sandboxToolExecDescriptorSchema,
  sandboxToolRequestSchema,
  type AuthorityAction,
  type ResourceOwnership,
  type ScanAuthorityFence,
  type SandboxToolRequest,
  type SandboxToolExecDescriptor,
} from "@lyrashield/runtime-control"
import type { RuntimeExecutor } from "./executor"
import type { SandboxToolNative } from "./sandbox-tool-native"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import { SandboxToolJournal, type SandboxToolEvent } from "./sandbox-tool-journal"

export interface SandboxToolExecScope {
  pty?: SandboxToolExecDescriptor["pty"]
  action: AuthorityAction
  supervisorInstanceId: string
  workspaceRoot: string
  ownership: ResourceOwnership
  resultKind?: SandboxToolExecDescriptor["resultKind"]
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

// The protected producer persists this exact commitment; handle and physical
// ownership are included, while the caller never selects the ownership.
export function sandboxToolExecChecksum(
  request: SandboxToolRequest,
  scope: SandboxToolExecScope
): string {
  return digest(
    sandboxToolExecDescriptorSchema.parse({
      schema: "lyrashield-sandbox-tool-exec/1",
      request,
      workspaceRoot: scope.workspaceRoot,
      ownership: scope.ownership,
      ...(scope.resultKind ? { resultKind: scope.resultKind } : {}),
      ...(scope.pty ? { pty: scope.pty } : {}),
    })
  )
}

function ensureHistory(events: SandboxToolEvent[], request: SandboxToolRequest): Set<string> {
  const states = projectSandboxToolHistory(events)
  if (
    states.has(request.requestId) ||
    [...states.values()].some((entries) => entries[0]?.tool.commandId === request.commandId)
  )
    throw new Error("sandbox tool request already recorded")
  // Docker's acknowledgement does not establish that the engine received its
  // response. Only the mirrored acknowledgement for retained terminal bytes
  // can release a fresh request ID.
  if (
    [...states.values()].some(
      (eventsForRequest) =>
        eventsForRequest[0]?.binding.attemptId === request.binding.attemptId &&
        eventsForRequest.at(-1)?.type !== "tool_ack"
    )
  )
    throw new Error("sandbox tool outcome unresolved")
  return new Set(
    events.flatMap((event) =>
      event.type === "tool_created" && event.tool.execId ? [event.tool.execId] : []
    )
  )
}

/**
 * The root service durably retains exec identity before starting. A lost ACK
 * remains unresolved; this layer never replays physical work.
 */
export async function startSandboxToolExec(
  input: unknown,
  scope: SandboxToolExecScope,
  dependencies: {
    fence: ScanAuthorityFence
    journal: SandboxToolJournal
    native: SandboxToolNative
    executor: Pick<RuntimeExecutor, "inspect">
    acknowledgeStarted: (input: {
      action: AuthorityAction
      descriptor: SandboxToolExecDescriptor
      guardId: string
      execId: string
    }) => Promise<void>
  }
): Promise<{ execId: string }> {
  const descriptor = sandboxToolExecDescriptorSchema.parse({
    schema: "lyrashield-sandbox-tool-exec/1",
    request: sandboxToolRequestSchema.parse(input),
    workspaceRoot: scope.workspaceRoot,
    ownership: scope.ownership,
    ...(scope.resultKind ? { resultKind: scope.resultKind } : {}),
    ...(scope.pty ? { pty: scope.pty } : {}),
  })
  const request = sandboxToolRequestSchema.parse(descriptor.request)
  const action = authorityActionSchema.parse(scope.action)
  const root = descriptor.workspaceRoot
  const ownership = descriptor.ownership
  const supervisorInstanceId = scope.supervisorInstanceId
  Object.freeze(request.binding)
  Object.freeze(request.argv)
  Object.freeze(request)
  Object.freeze(action)
  Object.freeze(ownership)
  Object.freeze(descriptor)
  if (
    action.phase !== "SANDBOX_TOOL" ||
    action.executorKey !== "sandbox" ||
    action.attemptId !== request.binding.attemptId ||
    action.operationId !== request.binding.operationId ||
    action.authorityEpochId !== request.binding.authorityEpochId ||
    action.requestId !== request.requestId ||
    !action.commandId ||
    action.actionChecksum !== digest(descriptor) ||
    Buffer.byteLength(canonicalJson(request)) > 1024 * 1024 ||
    !root.startsWith("/") ||
    root !== posix.normalize(root) ||
    root === "/" ||
    request.cwd !== root ||
    ownership.kind !== "container" ||
    ownership.executorKey !== "sandbox" ||
    !ownership.containerId ||
    !/^[a-f0-9]{64}$/.test(ownership.containerId)
  )
    throw new Error("sandbox tool binding unavailable")

  const containerId = ownership.containerId
  const prepareCommandId = action.commandId
  return dependencies.fence.run(action, async (assertActive, invocation) => {
    if (!invocation?.guardId) throw new Error("durable sandbox invocation guard is unavailable")
    const eventBase = {
      supervisorInstanceId,
      binding: {
        authorityEpochId: action.authorityEpochId,
        operationId: action.operationId,
        scanId: action.scanId,
        workspaceId: action.workspaceId,
        attemptId: action.attemptId,
      },
      tool: {
        requestId: request.requestId,
        kind: scope.resultKind ?? ("exec" as const),
        commandId: request.commandId,
        prepareCommandId,
        invocationGuardId: invocation.guardId,
        actionChecksum: action.actionChecksum,
        handleChecksum: digest(request.binding.sandboxHandle),
        containerId,
        maxOutputBytes: request.maxOutputBytes,
        timeoutSeconds: request.timeoutSeconds,
        bindingInputJson: canonicalJson(action),
      },
    }
    const history = await dependencies.journal.load()
    const usedExecIds = ensureHistory(
      history.map((record) => record.payload),
      request
    )
    const inspection = await dependencies.executor.inspect(ownership)
    if (
      inspection.state !== "PRESENT" ||
      inspection.running !== true ||
      inspection.ownership?.containerId !== containerId
    )
      throw new Error("retained sandbox is unavailable")
    assertActive()
    const append = async (type: SandboxToolEvent["type"], execId?: string) => {
      assertActive()
      await dependencies.journal.append({
        ...eventBase,
        type,
        observedAt: new Date().toISOString(),
        tool: { ...eventBase.tool, ...(execId ? { execId } : {}) },
      })
      assertActive()
    }
    await append("tool_intent")
    assertActive()
    const { execId } = await dependencies.native.start(action, descriptor)
    assertActive()
    if (usedExecIds.has(execId)) throw new Error("sandbox tool exec identity was reused")
    await append("tool_created", execId)
    await append("tool_starting", execId)
    await append("tool_started", execId)
    await dependencies.acknowledgeStarted({
      action,
      descriptor,
      guardId: invocation.guardId,
      execId,
    })
    assertActive()
    return { execId }
  })
}
