import { describe, it, expect } from "vitest"
import { canonicalJson, sandboxToolExecDescriptorSchema } from "@lyrashield/runtime-control"
import { sandboxToolEventSchema } from "./sandbox-tool-journal"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import { observeSandboxToolTerminal } from "./sandbox-tool-terminal"
const hash = "a".repeat(64)
function fixture() {
  const binding = {
    authorityEpochId: "epoch-1",
    operationId: "operation-1",
    attemptId: "attempt-1",
  }
  const target = { execId: hash, originalGuardId: "original-guard", sessionId: 42 }
  const tool = {
    kind: "pty/stdin",
    requestId: "e9b51e29-1ddc-428d-9517-7bccbdc217dd",
    commandId: "command-1",
    prepareCommandId: "prepare-1",
    invocationGuardId: "guard-1",
    actionChecksum: hash,
    handleChecksum: hash,
    containerId: hash,
    maxOutputBytes: 1024,
    timeoutSeconds: 1,
  }
  const event = sandboxToolEventSchema.parse({
    type: "tool_intent",
    supervisorInstanceId: "supervisor-1.tools",
    observedAt: "2026-11-14T00:00:00.000Z",
    binding: { ...binding, scanId: "scan-1", workspaceId: "workspace-1" },
    tool,
  })
  const mutated = sandboxToolEventSchema.parse({
    ...event,
    type: "tool_mutated",
    tool: {
      ...tool,
      nativeMutationId: "guard-1",
      nativeReceiptSha256: hash,
      nativeTargets: [target],
    },
  })
  return { event, mutated, target, binding }
}
describe("native mutation history", () => {
  it("allows a truthful mutation chain without creating or reusing a fresh exec identity", () => {
    const { event, mutated } = fixture()
    expect(projectSandboxToolHistory([event, mutated]).get(event.tool.requestId)?.length).toBe(2)
    expect(() =>
      sandboxToolEventSchema.parse({ ...mutated, tool: { ...mutated.tool, execId: hash } })
    ).toThrow()
    expect(() => projectSandboxToolHistory([event, { ...mutated, type: "tool_created" }])).toThrow()
    expect(() =>
      projectSandboxToolHistory([
        event,
        mutated,
        {
          ...event,
          tool: { ...event.tool, requestId: "other-request", commandId: "other-command" },
        },
      ])
    ).toThrow("retained history")
  })
  it("authenticates exact root mutation identity and output checksum before response retention", async () => {
    const { mutated, binding, target } = fixture()
    const response = {
      binding: { ...binding, sandboxHandle: "own_" + "a".repeat(40) },
      requestId: mutated.tool.requestId,
      status: "COMPLETED",
      sessionId: target.sessionId,
      outputBase64: Buffer.from("ok").toString("base64"),
      outputCursor: 2,
      exitCode: null,
      originalTokenCount: 1,
    }
    const observation = {
      nativeMutationId: mutated.tool.nativeMutationId,
      nativeReceiptSha256: hash,
      targets: [target],
      response,
    }
    await expect(
      observeSandboxToolTerminal(
        { observe: async () => observation },
        { ...binding, sandboxHandle: "own_" + "a".repeat(40) },
        mutated
      )
    ).resolves.toEqual(response)
    await expect(
      observeSandboxToolTerminal(
        { observe: async () => ({ ...observation, nativeMutationId: "other-guard" }) },
        response.binding,
        mutated
      )
    ).rejects.toThrow("identity")
    await expect(
      observeSandboxToolTerminal(
        { observe: async () => ({ ...observation, response: { ...response, sessionId: 43 } }) },
        response.binding,
        mutated
      )
    ).rejects.toThrow("response")
    const terminal = {
      ...mutated,
      type: "tool_response" as const,
      tool: { ...mutated.tool, responseChecksum: "sha256:" + hash, objectDigest: hash },
    }
    expect(() =>
      projectSandboxToolHistory([
        fixture().event,
        mutated,
        terminal,
        {
          ...terminal,
          type: "tool_ack",
          tool: { ...terminal.tool, nativeTargets: [{ ...target, execId: "b".repeat(64) }] },
        },
      ])
    ).toThrow("conflicts")
  })
  it("keeps caller argv separate from actual stdin mutations", () => {
    const { event, binding } = fixture()
    const descriptor = {
      schema: "lyrashield-sandbox-tool-exec/1",
      request: {
        binding: { ...binding, sandboxHandle: "own_" + "a".repeat(40) },
        requestId: event.tool.requestId,
        commandId: "command-1",
        cwd: "/workspace",
        user: "pentester",
        timeoutSeconds: 1,
        maxOutputBytes: 1024,
      },
      workspaceRoot: "/workspace",
      ownership: {
        kind: "container",
        executorKey: "sandbox",
        ownershipId: "own_" + "a".repeat(40),
        containerId: hash,
      },
      resultKind: "pty/stdin",
      pty: {
        sessionId: 42,
        chars: "input",
        outputCursor: 0,
        yieldTimeSeconds: 0,
        maxOutputTokens: 1024,
      },
    }
    expect(sandboxToolExecDescriptorSchema.parse(descriptor)).toEqual(descriptor)
    expect(() =>
      sandboxToolExecDescriptorSchema.parse({
        ...descriptor,
        request: { ...descriptor.request, argv: ["true"] },
      })
    ).toThrow()
    expect(() =>
      sandboxToolExecDescriptorSchema.parse({
        ...descriptor,
        pty: { ...descriptor.pty, chars: "x".repeat(65537) },
      })
    ).toThrow()
    expect(canonicalJson(descriptor)).not.toContain("argv")
  })
})
