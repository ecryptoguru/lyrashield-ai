import {
  canonicalJson,
  authorityActionSchema,
  resourceInspectionSchema,
  sha256Hex,
  sandboxToolExecDescriptorSchema,
  type AuthorityAction,
  type SandboxToolExecDescriptor,
  type ScanAuthorityFence,
  type ScanAuthorityContext,
  type JournalPort,
} from "@lyrashield/runtime-control"
import { sandboxMutationAckSchema } from "@lyrashield/db/src/scan-sandbox-tool-ack"
import type { SupervisorJournalEvent } from "./journal-events"
import { supervisorJournalEventSchema } from "./journal-events"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import type { SandboxToolJournal, SandboxToolEvent } from "./sandbox-tool-journal"
import { requestNativeExecutor } from "./native-executor-client"
import { RootSandboxToolNative, inspectNativeSandbox } from "./sandbox-tool-native"

/** A mutation records the original session targets, never a fresh exec identity. */
export async function mutateSandboxTool(
  input: {
    action: AuthorityAction
    descriptor: SandboxToolExecDescriptor
    supervisorInstanceId: string
    prepareChecksum: string
  },
  dependencies: {
    fence: ScanAuthorityFence
    context: ScanAuthorityContext
    journal: SandboxToolJournal
    native: RootSandboxToolNative
    recordNative: JournalPort<SupervisorJournalEvent>["append"]
  }
) {
  const descriptor = sandboxToolExecDescriptorSchema.parse(input.descriptor),
    action = authorityActionSchema.parse(input.action),
    request = descriptor.request
  if (
    (descriptor.resultKind !== "pty/stdin" && descriptor.resultKind !== "pty/terminate") ||
    action.actionChecksum !== sha256Hex(canonicalJson(descriptor)) ||
    !action.commandId ||
    action.requestId !== request.requestId
  )
    throw new Error("Sandbox mutation scope differs")
  const kind = descriptor.resultKind
  return dependencies.fence.run(action, async (assertActive, invocation) => {
    if (!invocation?.guardId) throw new Error("Sandbox mutation guard is unavailable")
    const events = (await dependencies.journal.load()).map((row) => row.payload)
    const history = projectSandboxToolHistory(events)
    if (
      history.has(request.requestId) ||
      events.some(
        (event) =>
          event.binding.attemptId === action.attemptId &&
          event.type === "tool_intent" &&
          history.get(event.tool.requestId)?.at(-1)?.type !== "tool_ack"
      )
    )
      throw new Error("Sandbox mutation conflicts with retained history")
    if (
      descriptor.resultKind === "pty/terminate" &&
      descriptor.pty &&
      "stopSandbox" in descriptor.pty &&
      descriptor.pty.stopSandbox === true
    ) {
      const inspection = resourceInspectionSchema.parse(
        await requestNativeExecutor({
          schema: 1,
          method: "inspect",
          ownership: descriptor.ownership,
        })
      )
      if (
        inspection.state !== "PRESENT" ||
        typeof inspection.running !== "boolean" ||
        canonicalJson(inspection.ownership) !== canonicalJson(descriptor.ownership)
      )
        throw new Error("Owned sandbox stop identity differs")
    } else await inspectNativeSandbox(descriptor)
    assertActive()
    const base: SandboxToolEvent = {
      type: "tool_intent",
      supervisorInstanceId: input.supervisorInstanceId + ".tools",
      observedAt: new Date().toISOString(),
      binding: {
        authorityEpochId: action.authorityEpochId,
        operationId: action.operationId,
        attemptId: action.attemptId,
        scanId: action.scanId,
        workspaceId: action.workspaceId,
      },
      tool: {
        requestId: request.requestId,
        kind,
        commandId: request.commandId,
        prepareCommandId: action.commandId!,
        invocationGuardId: invocation.guardId,
        actionChecksum: action.actionChecksum,
        handleChecksum: sha256Hex(canonicalJson(request.binding.sandboxHandle)),
        containerId: descriptor.ownership.containerId!,
        maxOutputBytes: request.maxOutputBytes,
        timeoutSeconds: request.timeoutSeconds,
        bindingInputJson: canonicalJson(action),
      },
    }
    await dependencies.journal.append(base)
    assertActive()
    const result = await dependencies.native.mutate(action, descriptor)
    assertActive()
    const inspection = resourceInspectionSchema.parse(
      await requestNativeExecutor({ schema: 1, method: "inspect", ownership: descriptor.ownership })
    )
    const ack = sandboxMutationAckSchema.parse({
      type: "native_invocation_ack",
      supervisorInstanceId: input.supervisorInstanceId,
      observedAt: new Date().toISOString(),
      commandId: action.commandId,
      attemptId: action.attemptId,
      operationId: action.operationId,
      authorityEpochId: action.authorityEpochId,
      executorKey: "sandbox",
      guardId: invocation.guardId,
      nativeRequestId: invocation.guardId,
      nativeOperation: "SANDBOX_TOOL_MUTATION_ACK",
      requestId: request.requestId,
      nativeMutationId: result.nativeMutationId,
      nativeTargets: result.targets,
      nativeReceiptSha256: result.nativeReceiptSha256,
      bindingInputChecksum: sha256Hex(canonicalJson(action)),
      actionChecksum: action.actionChecksum,
      commandInputChecksum: input.prepareChecksum,
      ownership: descriptor.ownership,
      inspection,
    })
    await dependencies.recordNative(supervisorJournalEventSchema.parse(ack))
    assertActive()
    await dependencies.journal.append({
      ...base,
      type: "tool_mutated",
      observedAt: new Date().toISOString(),
      tool: {
        ...base.tool,
        nativeMutationId: result.nativeMutationId,
        nativeReceiptSha256: result.nativeReceiptSha256,
        nativeTargets: result.targets,
      },
    })
    assertActive()
    return result
  })
}
