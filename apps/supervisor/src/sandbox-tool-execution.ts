import {
  authorityActionSchema,
  canonicalJson,
  sandboxToolExecDescriptorSchema,
  sandboxToolRequestSchema,
  sha256Hex,
  type SandboxToolExecDescriptor,
} from "@lyrashield/runtime-control"
import { startSandboxToolExec } from "./sandbox-tool-exec"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import { inspectNativeSandbox, RootSandboxToolNative } from "./sandbox-tool-native"
import { createSandboxToolStartAcknowledger } from "./sandbox-tool-start-ack"
import { requestNativeExecutor } from "./native-executor-client"
import { mutateSandboxTool } from "./sandbox-tool-mutation"
import { randomUUID } from "node:crypto"
import type { Credential, SandboxToolRunnerOptions } from "./sandbox-tool-runner-types"

export const sandboxToolBinding = (
  scope: ReturnType<SandboxToolRunnerOptions["verifyCapability"]>
) => ({
  attemptId: scope.attemptId,
  operationId: scope.operationId,
  authorityEpochId: scope.authorityEpochId,
  sandboxHandle: scope.sandboxHandle,
})
const binding = sandboxToolBinding

export function createSandboxToolExecution(options: SandboxToolRunnerOptions) {
  const native = new RootSandboxToolNative(options.context)
  return async (
    credential: Credential,
    request: SandboxToolExecDescriptor["request"],
    resultKind?: SandboxToolExecDescriptor["resultKind"],
    pty?: SandboxToolExecDescriptor["pty"]
  ) => {
    const scope = options.verifyCapability(credential.token, credential, "observe")
    if (canonicalJson(binding(scope)) !== canonicalJson(request.binding))
      throw new Error("Sandbox invocation scope differs")
    const descriptor = sandboxToolExecDescriptorSchema.parse({
      schema: "lyrashield-sandbox-tool-exec/1",
      request,
      workspaceRoot: "/workspace",
      ownership: scope.ownership,
      ...(resultKind ? { resultKind } : {}),
      ...(pty ? { pty } : {}),
    })
    const action = authorityActionSchema.parse({
      phase: "SANDBOX_TOOL",
      authorityEpochId: scope.authorityEpochId,
      operationId: scope.operationId,
      attemptId: scope.attemptId,
      scanId: scope.scanId,
      workspaceId: scope.workspaceId,
      authorityRevision: scope.authorityRevision,
      authorityChecksum: scope.authorityChecksum,
      actionChecksum: sha256Hex(canonicalJson(descriptor)),
      commandId: scope.prepareCommandId,
      requestId: request.requestId,
      executorKey: "sandbox",
    })
    const previous = projectSandboxToolHistory(
      (await options.journal.load()).map((record) => record.payload)
    ).get(request.requestId)
    if (previous) {
      if (previous[0]?.tool.actionChecksum !== action.actionChecksum)
        throw new Error("Sandbox request identity differs")
      await options.acknowledgements.complete(binding(scope), request.requestId)
      return options.acknowledgements.replay(
        binding(scope),
        request.requestId,
        action.actionChecksum
      )
    }
    options.verifyCapability(credential.token, credential, "invoke")
    const intent = await options.intents.publish({
      binding: action,
      descriptor,
      ownershipReceiptId: scope.ownershipReceiptId,
    })
    if (intent.kind !== "committed") throw new Error("Sandbox intent outcome is unknown")
    if (resultKind === "pty/stdin" || resultKind === "pty/terminate")
      await mutateSandboxTool(
        {
          action,
          descriptor,
          supervisorInstanceId: options.supervisorInstanceId,
          prepareChecksum: scope.prepareCommandInputChecksum,
        },
        {
          fence: options.fence,
          context: options.context,
          journal: options.journal,
          native,
          recordNative: options.recordNativeStart,
        }
      )
    else
      await startSandboxToolExec(
        sandboxToolRequestSchema.parse(request),
        {
          action,
          workspaceRoot: descriptor.workspaceRoot,
          ownership: descriptor.ownership,
          supervisorInstanceId: `${options.supervisorInstanceId}.tools`,
          ...(resultKind ? { resultKind } : {}),
          ...(pty ? { pty } : {}),
        },
        {
          fence: options.fence,
          journal: options.journal,
          native,
          executor: {
            inspect: async (ownership) => {
              if (canonicalJson(ownership) !== canonicalJson(descriptor.ownership))
                throw new Error("Sandbox inspection ownership differs")
              return inspectNativeSandbox(descriptor)
            },
          },
          acknowledgeStarted: createSandboxToolStartAcknowledger({
            journal: { append: options.recordNativeStart },
            supervisorInstanceId: options.supervisorInstanceId,
            prepareCommandInputChecksum: scope.prepareCommandInputChecksum,
            inspect: inspectNativeSandbox,
            assertActive: () => {
              const current = options.context.current()
              if (!current || canonicalJson(current.binding) !== canonicalJson(action))
                throw new Error("Sandbox invocation gate is unavailable")
              current.assertActive()
            },
          }),
        }
      )
    // Receipt ingestion uses its separate credential after the original invocation releases its gate.
    await options.consumeReceipts(scope.operationId)
    if (pty && "yieldTimeSeconds" in pty && pty.yieldTimeSeconds > 0)
      await new Promise((resolve) => setTimeout(resolve, pty.yieldTimeSeconds * 1000))
    await options.acknowledgements.complete(binding(scope), request.requestId)
    return options.acknowledgements.replay(binding(scope), request.requestId, action.actionChecksum)
  }
}

export function createSandboxToolReadAuthorizer(options: SandboxToolRunnerOptions) {
  return async (credential: Credential, requireRunning = true) => {
    const scope = options.verifyCapability(credential.token, credential, "invoke")
    const requestId = randomUUID()
    const descriptor = sandboxToolExecDescriptorSchema.parse({
      schema: "lyrashield-sandbox-tool-exec/1",
      workspaceRoot: "/workspace",
      ownership: scope.ownership,
      request: {
        binding: binding(scope),
        requestId,
        commandId: requestId,
        argv: ["true"],
        cwd: "/workspace",
        user: "pentester",
        timeoutSeconds: 1,
        maxOutputBytes: 1,
      },
    })
    // This read-only source check creates no intent, guard or native execution.
    await options.intents.authorizeRead({
      descriptor,
      ownershipReceiptId: scope.ownershipReceiptId,
      binding: authorityActionSchema.parse({
        phase: "SANDBOX_TOOL",
        authorityEpochId: scope.authorityEpochId,
        operationId: scope.operationId,
        attemptId: scope.attemptId,
        scanId: scope.scanId,
        workspaceId: scope.workspaceId,
        authorityRevision: scope.authorityRevision,
        authorityChecksum: scope.authorityChecksum,
        actionChecksum: sha256Hex(canonicalJson(descriptor)),
        commandId: scope.prepareCommandId,
        requestId,
        executorKey: "sandbox",
      }),
    })
    const { resourceInspectionSchema } = await import("@lyrashield/runtime-control")
    const inspection = resourceInspectionSchema.parse(
      await requestNativeExecutor({ schema: 1, method: "inspect", ownership: scope.ownership })
    )
    if (
      (inspection.state !== "PRESENT" && (requireRunning || inspection.state !== "ABSENT")) ||
      (inspection.state === "PRESENT" &&
        canonicalJson(inspection.ownership) !== canonicalJson(scope.ownership)) ||
      (requireRunning && inspection.running !== true)
    )
      throw new Error("Exact native sandbox is unavailable")
    return scope
  }
}
