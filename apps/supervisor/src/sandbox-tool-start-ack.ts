import {
  authorityActionSchema,
  canonicalJson,
  sandboxToolExecDescriptorSchema,
  sha256Hex,
  type AuthorityAction,
  type JournalPort,
  type ResourceInspection,
  type SandboxToolExecDescriptor,
} from "@lyrashield/runtime-control"
import { sandboxInvocationAckSchema } from "@lyrashield/db/src/scan-sandbox-tool-ack"
import { supervisorJournalEventSchema, type SupervisorJournalEvent } from "./journal-events"

/** The signed source records the physical start while the original native gate is held. */
export function createSandboxToolStartAcknowledger(options: {
  journal: Pick<JournalPort<SupervisorJournalEvent>, "append">
  supervisorInstanceId: string
  prepareCommandInputChecksum: string
  inspect: (descriptor: SandboxToolExecDescriptor) => Promise<ResourceInspection>
  assertActive: () => void
}) {
  return async (input: {
    action: AuthorityAction
    descriptor: SandboxToolExecDescriptor
    guardId: string
    execId: string
  }): Promise<void> => {
    options.assertActive()
    const action = authorityActionSchema.parse(input.action)
    const descriptor = sandboxToolExecDescriptorSchema.parse(input.descriptor)
    const request = descriptor.request
    if (
      action.phase !== "SANDBOX_TOOL" ||
      action.executorKey !== "sandbox" ||
      action.actionChecksum !== sha256Hex(canonicalJson(descriptor)) ||
      action.requestId !== request.requestId ||
      action.operationId !== request.binding.operationId ||
      action.attemptId !== request.binding.attemptId ||
      action.authorityEpochId !== request.binding.authorityEpochId ||
      request.binding.sandboxHandle !== descriptor.ownership.ownershipId ||
      !action.commandId
    )
      throw new Error("Sandbox start acknowledgement scope differs")
    const inspection = await options.inspect(descriptor)
    options.assertActive()
    if (
      inspection.state !== "PRESENT" ||
      inspection.running !== true ||
      canonicalJson(inspection.ownership) !== canonicalJson(descriptor.ownership)
    )
      throw new Error("Sandbox start acknowledgement ownership differs")
    const event = sandboxInvocationAckSchema.parse({
      type: "native_invocation_ack",
      supervisorInstanceId: options.supervisorInstanceId,
      observedAt: new Date().toISOString(),
      commandId: action.commandId,
      attemptId: action.attemptId,
      operationId: action.operationId,
      authorityEpochId: action.authorityEpochId,
      executorKey: "sandbox",
      guardId: input.guardId,
      nativeRequestId: input.guardId,
      nativeOperation: "SANDBOX_TOOL_START_ACK",
      requestId: request.requestId,
      execId: input.execId,
      bindingInputChecksum: sha256Hex(canonicalJson(action)),
      actionChecksum: action.actionChecksum,
      commandInputChecksum: options.prepareCommandInputChecksum,
      ownership: descriptor.ownership,
      inspection,
    })
    await options.journal.append(supervisorJournalEventSchema.parse(event))
    options.assertActive()
  }
}
