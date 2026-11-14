import { canonicalJson } from "@lyrashield/runtime-control"
import type { SandboxToolExecRunner, SandboxToolRequestAuthority } from "./sandbox-tool-http"
import { requestNativeExecutor } from "./native-executor-client"
import { randomUUID } from "node:crypto"
import { sandboxFileCommand } from "./sandbox-file-command"
import {
  createSandboxToolExecution,
  createSandboxToolReadAuthorizer,
  sandboxToolBinding as binding,
} from "./sandbox-tool-execution"
import type {
  Credential,
  SandboxToolRunnerOptions,
  SandboxToolRunner,
} from "./sandbox-tool-runner-types"

/** All caller fields are bound to the installed signed capability before becoming a DB intent. */
export function createSandboxToolRunner(options: SandboxToolRunnerOptions): SandboxToolRunner {
  const authority: SandboxToolRequestAuthority = {
    async run<T>(
      credential: Credential,
      action: Parameters<SandboxToolRequestAuthority["run"]>[1]
    ) {
      const scope = options.verifyCapability(credential.token, credential, "observe")
      return action(binding(scope)) as Promise<T>
    },
  }
  const execute = createSandboxToolExecution(options)
  const authorizeRead = createSandboxToolReadAuthorizer(options)
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
