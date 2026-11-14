import {
  authorityActionSchema,
  canonicalJson,
  sandboxToolExecDescriptorSchema,
  sandboxToolRequestSchema,
  sha256Hex,
  type JournalPort,
  type SandboxToolRequest,
  type ScanAuthorityContext,
  type ScanAuthorityFence,
  type SandboxToolExecDescriptor,
} from "@lyrashield/runtime-control"
import { createScanSandboxToolIntentProducer } from "@lyrashield/db/src/scan-sandbox-tool-intent"
import { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import { createSandboxToolCapabilityVerifier } from "./sandbox-tool-capability"
import { startSandboxToolExec } from "./sandbox-tool-exec"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import type { SandboxToolExecRunner, SandboxToolRequestAuthority } from "./sandbox-tool-http"
import { SandboxToolJournal } from "./sandbox-tool-journal"
import { inspectNativeSandbox, RootSandboxToolNative } from "./sandbox-tool-native"
import { createSandboxToolStartAcknowledger } from "./sandbox-tool-start-ack"
import type { SupervisorJournalEvent } from "./journal-events"
import { requestNativeExecutor } from "./native-executor-client"
import { mutateSandboxTool } from "./sandbox-tool-mutation"
import { randomUUID } from "node:crypto"
import { sandboxFileCommand } from "./sandbox-file-command"

type Credential = { token: string; attemptId: string; sandboxHandle: string }

/** All caller fields are bound to the installed signed capability before becoming a DB intent. */
export function createSandboxToolRunner(options: {
  verifyCapability: ReturnType<typeof createSandboxToolCapabilityVerifier>
  intents: ReturnType<typeof createScanSandboxToolIntentProducer>
  context: ScanAuthorityContext
  fence: ScanAuthorityFence
  journal: SandboxToolJournal
  recordNativeStart: (
    event: SupervisorJournalEvent
  ) => ReturnType<JournalPort<SupervisorJournalEvent>["append"]>
  supervisorInstanceId: string
  acknowledgements: SandboxToolAcknowledgements
  consumeReceipts: (operationId: string) => Promise<unknown>
}): {
  authority: SandboxToolRequestAuthority
  runner: SandboxToolExecRunner
  operations: {
    readPty: (
      credential: Credential,
      input: {
        sessionId: number
        outputCursor: number
        maxOutputBytes: number
        yieldTimeSeconds: number
      }
    ) => Promise<unknown>
    stop: (
      credential: Credential,
      input: { binding: SandboxToolRequest["binding"]; requestId: string }
    ) => Promise<unknown>
    executePty: (
      credential: Credential,
      request: SandboxToolRequest,
      pty: SandboxToolExecDescriptor["pty"]
    ) => Promise<unknown>
    executeMutation: (
      credential: Credential,
      request: SandboxToolExecDescriptor["request"],
      kind: "pty/stdin" | "pty/terminate",
      pty: SandboxToolExecDescriptor["pty"]
    ) => Promise<unknown>
  }
} {
  const binding = (scope: ReturnType<typeof options.verifyCapability>) => ({
    attemptId: scope.attemptId,
    operationId: scope.operationId,
    authorityEpochId: scope.authorityEpochId,
    sandboxHandle: scope.sandboxHandle,
  })
  const authority: SandboxToolRequestAuthority = {
    async run<T>(
      credential: Credential,
      action: Parameters<SandboxToolRequestAuthority["run"]>[1]
    ) {
      const scope = options.verifyCapability(credential.token, credential, "observe")
      return action(binding(scope)) as Promise<T>
    },
  }
  const native = new RootSandboxToolNative(options.context)
  const execute = async (
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
  const authorizeRead = async (credential: Credential, requireRunning = true) => {
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
  const runner: SandboxToolExecRunner = {
    execute,
    async state(credential) {
      const scope = await authorizeRead(credential, false),
        requestId = randomUUID()
      const { resourceInspectionSchema } = await import("@lyrashield/runtime-control")
      const inspection = resourceInspectionSchema.parse(
        await requestNativeExecutor({ schema: 1, method: "inspect", ownership: scope.ownership })
      )
      if (
        (inspection.state !== "PRESENT" && inspection.state !== "ABSENT") ||
        (inspection.state === "PRESENT" &&
          canonicalJson(inspection.ownership) !== canonicalJson(scope.ownership))
      )
        throw new Error("Exact native sandbox state is unavailable")
      if (inspection.state === "ABSENT" || inspection.running === false)
        return { binding: binding(scope), running: false }
      const result = await execute(
        credential,
        {
          binding: binding(scope),
          requestId,
          commandId: requestId,
          argv: ["/usr/bin/true"],
          cwd: "/workspace",
          user: "pentester",
          timeoutSeconds: 1,
          maxOutputBytes: 128 * 1024,
        },
        "state/renew"
      )
      // SDK state reads have no consumer ACK route. The supervisor acknowledges
      // the exact metadata it consumed before issuing this nonbillable read response.
      const proof = await options.acknowledgements.complete(binding(scope), requestId)
      await options.acknowledgements.acknowledge(binding(scope), requestId, proof.responseChecksum)
      return result
    },
    async port(credential, port) {
      if (port !== 48080) throw new Error("Sandbox port is unavailable")
      const scope = await authorizeRead(credential)
      return {
        host: `lyrashield-supervisor-${scope.ownership.ownershipId.slice(4, 36)}`,
        port: 48080,
        tls: false,
        query: "",
      }
    },
    async executeFile(credential, kind, input) {
      const command = sandboxFileCommand(kind, input)
      return execute(
        credential,
        {
          binding: command.request.binding,
          requestId: command.request.requestId,
          commandId: command.request.commandId,
          argv: command.argv,
          cwd: "/workspace",
          user: "pentester",
          timeoutSeconds: 10,
          maxOutputBytes: 1024 * 1024,
        },
        kind
      )
    },
  }
  return {
    authority,
    runner,
    operations: {
      stop: (credential, input) =>
        execute(
          credential,
          {
            ...input,
            commandId: input.requestId,
            cwd: "/workspace",
            user: "pentester",
            timeoutSeconds: 1,
            maxOutputBytes: 1024,
          },
          "pty/terminate",
          { stopSandbox: true }
        ),
      async readPty(credential, input) {
        if (
          !Number.isSafeInteger(input.sessionId) ||
          input.sessionId < 1 ||
          !Number.isSafeInteger(input.outputCursor) ||
          input.outputCursor < 0 ||
          !Number.isSafeInteger(input.maxOutputBytes) ||
          input.maxOutputBytes < 1 ||
          input.maxOutputBytes > 1024 * 1024 ||
          !Number.isFinite(input.yieldTimeSeconds) ||
          input.yieldTimeSeconds < 0 ||
          input.yieldTimeSeconds > 30
        )
          throw new Error("Sandbox PTY read bounds differ")
        const scope = await authorizeRead(credential)
        if (input.yieldTimeSeconds > 0)
          await new Promise((resolve) => setTimeout(resolve, input.yieldTimeSeconds * 1000))
        await authorizeRead(credential)
        return requestNativeExecutor({
          schema: 1,
          method: "pty-read",
          ownership: scope.ownership,
          sessionId: input.sessionId,
          outputCursor: input.outputCursor,
          maxOutputBytes: input.maxOutputBytes,
        })
      },
      executePty: (credential, request, pty) => execute(credential, request, "pty/start", pty),
      executeMutation: (credential, request, kind, pty) => execute(credential, request, kind, pty),
    },
  }
}
