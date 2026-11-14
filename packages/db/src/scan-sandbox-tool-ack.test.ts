import { describe, expect, it } from "vitest"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { parseStoredSandboxToolIntent } from "./scan-sandbox-tool-intent"
import {
  verifySandboxInvocationAck,
  verifyOriginalSandboxMutationTargets,
} from "./scan-sandbox-tool-ack"

function fixture() {
  const ownership = {
    kind: "container",
    executorKey: "sandbox",
    ownershipId: `own_${"a".repeat(40)}`,
    containerId: "b".repeat(64),
  }
  const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
  const descriptor = {
    schema: "lyrashield-sandbox-tool-exec/1",
    workspaceRoot: "/workspace",
    ownership,
    request: {
      binding: {
        attemptId: "attempt-1",
        operationId: "operation-1",
        authorityEpochId: "epoch-1",
        sandboxHandle: ownership.ownershipId,
      },
      requestId,
      commandId: requestId,
      argv: ["true"],
      cwd: "/workspace",
      user: "pentester",
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
    },
  }
  const actionInputJson = canonicalJson(descriptor)
  const actionChecksum = sha256Hex(actionInputJson)
  const action = {
    phase: "SANDBOX_TOOL",
    operationId: "operation-1",
    attemptId: "attempt-1",
    authorityEpochId: "epoch-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    authorityRevision: 1,
    authorityChecksum: "c".repeat(64),
    actionChecksum,
    commandId: "prepare-1",
    executorKey: "sandbox",
    requestId,
  }
  const guard = { ...action, id: "guard-1", bindingInputJson: canonicalJson(action) }
  const intent = {
    actionInputJson,
    actionChecksum,
    authorityChecksum: action.authorityChecksum,
    requestId,
    prepareCommandId: action.commandId,
  }
  const prepareChecksum = "d".repeat(64)
  const ack = {
    type: "native_invocation_ack",
    supervisorInstanceId: "supervisor-1",
    observedAt: "2026-11-14T00:00:00.000Z",
    commandId: action.commandId,
    attemptId: action.attemptId,
    operationId: action.operationId,
    authorityEpochId: action.authorityEpochId,
    executorKey: "sandbox",
    guardId: guard.id,
    nativeRequestId: guard.id,
    nativeOperation: "SANDBOX_TOOL_START_ACK",
    requestId,
    execId: "e".repeat(64),
    bindingInputChecksum: sha256Hex(guard.bindingInputJson),
    actionChecksum,
    commandInputChecksum: prepareChecksum,
    ownership,
    inspection: { state: "PRESENT", ownership, running: true },
  }
  return { descriptor, action, guard, intent, prepareChecksum, ack }
}

describe("immutable sandbox tool authority", () => {
  it("accepts exact canonical descriptor bytes and the original attempt-bound native start", () => {
    const f = fixture()
    expect(parseStoredSandboxToolIntent(f.intent)).toEqual(f.descriptor)
    expect(verifySandboxInvocationAck(f.ack, f.guard, f.prepareChecksum, f.intent)).toEqual(f.ack)
  })

  it.each(["actionInputJson", "actionChecksum"] as const)(
    "rejects changed retained %s",
    (field) => {
      const f = fixture()
      const changed = {
        ...f.intent,
        [field]: field === "actionChecksum" ? "f".repeat(64) : `${f.intent.actionInputJson} `,
      }
      expect(() => parseStoredSandboxToolIntent(changed)).toThrow()
    }
  )

  it("rejects noncanonical descriptor bytes even with a matching hash", () => {
    const f = fixture(),
      json = JSON.stringify(f.descriptor)
    expect(() =>
      parseStoredSandboxToolIntent({ actionInputJson: json, actionChecksum: sha256Hex(json) })
    ).toThrow()
  })

  it.each([
    "guardId",
    "requestId",
    "execId",
    "commandInputChecksum",
    "actionChecksum",
    "operationId",
    "attemptId",
    "authorityEpochId",
  ] as const)("rejects changed native %s", (field) => {
    const f = fixture()
    expect(() =>
      verifySandboxInvocationAck(
        { ...f.ack, [field]: "foreign-1" },
        f.guard,
        f.prepareChecksum,
        f.intent
      )
    ).toThrow()
  })

  it("rejects a foreign immutable binding even when its signature input matches", () => {
    const f = fixture(),
      bindingInputJson = canonicalJson({ ...f.action, operationId: "foreign-1" })
    expect(() =>
      verifySandboxInvocationAck(
        { ...f.ack, bindingInputChecksum: sha256Hex(bindingInputJson) },
        { ...f.guard, bindingInputJson },
        f.prepareChecksum,
        f.intent
      )
    ).toThrow()
  })

  it("rejects foreign or stopped native ownership", () => {
    const f = fixture()
    for (const inspection of [
      { ...f.ack.inspection, running: false },
      { ...f.ack.inspection, ownership: { ...f.ack.ownership, containerId: "f".repeat(64) } },
    ]) {
      expect(() =>
        verifySandboxInvocationAck({ ...f.ack, inspection }, f.guard, f.prepareChecksum, f.intent)
      ).toThrow()
    }
  })
})

describe("truthful sandbox native mutation proof", () => {
  function mutation() {
    const f = fixture(),
      { argv: _argv, ...request } = f.descriptor.request
    void _argv
    const target = {
      execId: "e".repeat(64),
      originalGuardId: "original-guard",
      sessionId: parseInt(sha256Hex("original-guard").slice(0, 13), 16) + 1,
    }
    const descriptor = {
      ...f.descriptor,
      request,
      resultKind: "pty/stdin",
      pty: {
        sessionId: target.sessionId,
        chars: "answer\n",
        outputCursor: 0,
        yieldTimeSeconds: 0,
        maxOutputTokens: 1024,
      },
    }
    const intent = {
      ...f.intent,
      actionInputJson: canonicalJson(descriptor),
      actionChecksum: sha256Hex(canonicalJson(descriptor)),
    }
    const action = { ...f.action, actionChecksum: intent.actionChecksum },
      guard = { ...f.guard, ...action, bindingInputJson: canonicalJson(action) }
    const { execId: _execId, ...base } = f.ack
    void _execId
    const ack = {
      ...base,
      nativeOperation: "SANDBOX_TOOL_MUTATION_ACK",
      nativeMutationId: guard.id,
      nativeTargets: [target],
      nativeReceiptSha256: sha256Hex(
        canonicalJson({
          schema: "lyrashield-native-pty-mutation/1",
          guardId: guard.id,
          actionChecksum: intent.actionChecksum,
          kind: "pty/stdin",
          targets: [target],
        })
      ),
      actionChecksum: intent.actionChecksum,
      bindingInputChecksum: sha256Hex(guard.bindingInputJson),
    }
    return { f, descriptor, intent, guard, ack, target }
  }
  it("binds the actual original session targets and immutable root mutation identity", () => {
    const m = mutation()
    expect(verifySandboxInvocationAck(m.ack, m.guard, m.f.prepareChecksum, m.intent)).toEqual(m.ack)
    expect(() =>
      verifySandboxInvocationAck(
        { ...m.ack, execId: m.target.execId },
        m.guard,
        m.f.prepareChecksum,
        m.intent
      )
    ).toThrow()
    expect(() =>
      verifySandboxInvocationAck(
        { ...m.ack, nativeMutationId: "foreign-guard" },
        m.guard,
        m.f.prepareChecksum,
        m.intent
      )
    ).toThrow()
    expect(() =>
      verifySandboxInvocationAck(
        { ...m.ack, nativeTargets: [{ ...m.target, sessionId: 42 }] },
        m.guard,
        m.f.prepareChecksum,
        m.intent
      )
    ).toThrow()
  })
  it("requires each immutable original scoped confirmed PTY START before accepting a mutation", async () => {
    const m = mutation(),
      originalDescriptor = {
        ...m.f.descriptor,
        resultKind: "pty/start",
        pty: { tty: true, yieldTimeSeconds: 0, maxOutputTokens: 1024 },
      }
    const originalChecksum = sha256Hex(canonicalJson(originalDescriptor))
    const originalAction = { ...m.f.action, actionChecksum: originalChecksum }
    const originalAck = {
      ...m.f.ack,
      guardId: m.target.originalGuardId,
      nativeRequestId: m.target.originalGuardId,
      actionChecksum: originalChecksum,
      bindingInputChecksum: sha256Hex(canonicalJson(originalAction)),
    }
    const row = {
      ...m.f.intent,
      ...originalAction,
      id: m.target.originalGuardId,
      bindingInputJson: canonicalJson(originalAction),
      actionInputJson: canonicalJson(originalDescriptor),
      proofInputJson: canonicalJson(originalAck),
      proofChecksum: sha256Hex(canonicalJson(originalAck)),
      prepareCommandId: originalAction.commandId,
    }
    const scope = {
      operationId: m.f.action.operationId,
      attemptId: m.f.action.attemptId,
      authorityEpochId: m.f.action.authorityEpochId,
      workspaceId: m.f.action.workspaceId,
    }
    await expect(
      verifyOriginalSandboxMutationTargets({ query: async () => ({ rows: [row] }) }, m.ack, scope)
    ).resolves.toBeUndefined()
    await expect(
      verifyOriginalSandboxMutationTargets({ query: async () => ({ rows: [] }) }, m.ack, scope)
    ).rejects.toThrow("unavailable")
    await expect(
      verifyOriginalSandboxMutationTargets(
        {
          query: async () => ({
            rows: [
              {
                ...row,
                actionInputJson: m.f.intent.actionInputJson,
                actionChecksum: m.f.intent.actionChecksum,
              },
            ],
          }),
        },
        m.ack,
        scope
      )
    ).rejects.toThrow()
  })
})
