import { describe, expect, it } from "vitest"
import { nativeExecutorRequestSchema } from "./native-executor-protocol"
import { RootNativeRuntimeExecutor } from "./native-executor-client"
import {
  ScanAuthorityContext,
  type AuthorityAction,
  type ExecutorSpec,
} from "@lyrashield/runtime-control"

const action: AuthorityAction = {
  phase: "EXECUTOR_CREATE",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  commandId: "start-1",
  executorKey: "engine",
  authorityChecksum: "a".repeat(64),
  actionChecksum: "b".repeat(64),
}
const spec: ExecutorSpec = {
  kind: "container",
  image: "fixture@sha256:" + "c".repeat(64),
  argv: ["sleep", "60"],
  env: {},
  network: "none",
  cpus: 1,
  memoryMb: 128,
  pidsLimit: 32,
  readOnly: true,
  grantEnvName: "LLM_API_KEY",
}

describe("protected native request boundary", () => {
  it("accepts action identity and rejects client-selected image, argv, shell and fields", () => {
    const request = { schema: 1, method: "create", guardId: "guard-1", action }
    expect(nativeExecutorRequestSchema.parse(request)).toEqual(request)
    for (const field of ["image", "argv", "dockerHost", "command", "descriptor"])
      expect(
        nativeExecutorRequestSchema.safeParse({ ...request, [field]: "untrusted" }).success
      ).toBe(false)
    expect(
      nativeExecutorRequestSchema.safeParse({ ...request, action: { ...action, workspaceId: "" } })
        .success
    ).toBe(false)
  })

  it("does not turn an opaque caller guard ID into native invocation permission", async () => {
    const executor = new RootNativeRuntimeExecutor(new ScanAuthorityContext())
    await expect(
      executor.create("engine", spec, {
        attemptId: action.attemptId,
        commandId: action.commandId!,
        assertActive: () => undefined,
        nativeInvocation: { requestId: "guard-1", acknowledge: async () => undefined },
      })
    ).rejects.toThrow("Native container identity is unavailable")
  })

  it("rejects cross-instance, mismatched phase and mismatched original guard capabilities", async () => {
    const authority = new ScanAuthorityContext()
    const executor = new RootNativeRuntimeExecutor(authority)
    const context = {
      attemptId: action.attemptId,
      commandId: action.commandId!,
      assertActive: () => undefined,
      nativeInvocation: { requestId: "foreign-guard", acknowledge: async () => undefined },
    }
    await authority.run(
      {
        connection: { query: async () => ({ rows: [] }), release: () => undefined },
        binding: action,
        guardId: "guard-1",
        assertActive: () => undefined,
      },
      async () => {
        await expect(executor.create("engine", spec, context)).rejects.toThrow(
          "Current native invocation capability is unavailable"
        )
        await expect(executor.create("sandbox", spec, context)).rejects.toThrow(
          "Native container identity is unavailable"
        )
        await expect(
          new RootNativeRuntimeExecutor(new ScanAuthorityContext()).create("engine", spec, context)
        ).rejects.toThrow()
      }
    )
  })
})
