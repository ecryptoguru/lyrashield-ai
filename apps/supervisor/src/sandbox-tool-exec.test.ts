import { describe, expect, it, vi } from "vitest"
import type {
  AuthorityAction,
  JournalRecord,
  ResourceOwnership,
  ScanAuthorityFence,
} from "@lyrashield/runtime-control"
import {
  sandboxToolExecChecksum,
  startSandboxToolExec,
  type SandboxToolExecScope,
} from "./sandbox-tool-exec"
import { SandboxToolJournal, type SandboxToolEvent } from "./sandbox-tool-journal"

const toolRequest = {
  binding: {
    attemptId: "attempt-1",
    operationId: "operation-1",
    authorityEpochId: "epoch-1",
    sandboxHandle: `own_${"a".repeat(40)}`,
  },
  requestId: "1d5b3040-b775-43a0-a7fb-ac5965fb91fa",
  commandId: "1d5b3040-b775-43a0-a7fb-ac5965fb91fa",
  argv: ["/bin/sh", "-c", "exit 0"],
  cwd: "/workspace",
  user: "pentester" as const,
  timeoutSeconds: 10,
  maxOutputBytes: 1024,
}
const ownership: ResourceOwnership = {
  kind: "container",
  executorKey: "sandbox",
  ownershipId: `own_${"a".repeat(40)}`,
  containerId: "b".repeat(64),
}
const action: AuthorityAction = {
  phase: "SANDBOX_TOOL",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  authorityChecksum: "c".repeat(64),
  actionChecksum: "d".repeat(64),
  commandId: "prepare-1",
  requestId: toolRequest.requestId,
  executorKey: "sandbox",
}
function scopeFor(resource: ResourceOwnership = ownership): SandboxToolExecScope {
  const scope = {
    action: { ...action },
    workspaceRoot: "/workspace",
    supervisorInstanceId: "supervisor-1.tools",
    ownership: resource,
  }
  scope.action.actionChecksum = sandboxToolExecChecksum(toolRequest, scope)
  return scope
}
function fixture() {
  const events: SandboxToolEvent[] = []
  const order: string[] = []
  const journal = {
    load: vi.fn(async () =>
      events.map((payload, index): JournalRecord<SandboxToolEvent> => ({
        version: 1,
        sequence: index + 1,
        previousHash: "0".repeat(64),
        payload,
        hash: "0".repeat(64),
        signature: "0".repeat(64),
      }))
    ),
    append: vi.fn(async (event: SandboxToolEvent) => {
      order.push(event.type)
      events.push(event)
    }),
  }
  const fence: ScanAuthorityFence = {
    run: async (_binding, effect) => effect(() => undefined, { guardId: "guard-1" }),
  }
  const native = {
    start: vi.fn(async () => {
      order.push("native_start")
      return { execId: "e".repeat(64) }
    }),
  }
  const acknowledgeStarted = vi.fn(async () => {
    order.push("native_ack")
  })
  const executor = {
    inspect: vi.fn(async (resource: ResourceOwnership) => ({
      state: "PRESENT" as const,
      running: true,
      ownership: resource,
    })),
  }
  const deps = {
    fence,
    journal: journal as unknown as SandboxToolJournal,
    native,
    executor,
    acknowledgeStarted,
  }
  return { events, order, journal, native, executor, acknowledgeStarted, deps }
}

describe("root sandbox tool invocation", () => {
  it("records the root-durable identity and authenticates its only start", async () => {
    const f = fixture()
    expect(await startSandboxToolExec(toolRequest, scopeFor(), f.deps)).toEqual({
      execId: "e".repeat(64),
    })
    expect(f.order).toEqual([
      "tool_intent",
      "native_start",
      "tool_created",
      "tool_starting",
      "tool_started",
      "native_ack",
    ])
    expect(f.events[1]?.tool.execId).toBe("e".repeat(64))
    expect(f.events.every((event) => Reflect.get(event.tool, "maxOutputBytes") === 1024)).toBe(true)
    expect(f.native.start).toHaveBeenCalledOnce()
  })

  it("holds fresh request IDs when start acknowledgement is lost", async () => {
    const f = fixture()
    f.native.start.mockRejectedValueOnce(new Error("ack lost"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow("ack lost")
    const next = { ...toolRequest, requestId: "b7f2c35f-82d5-4fd3-80f1-dfa5f9d49f5b" }
    next.commandId = next.requestId
    const scope = scopeFor()
    scope.action.requestId = next.requestId
    scope.action.actionChecksum = sandboxToolExecChecksum(next, scope)
    await expect(startSandboxToolExec(next, scope, f.deps)).rejects.toThrow("unresolved")
    expect(f.native.start).toHaveBeenCalledOnce()
  })

  it("holds a new client until the engine acknowledges the retained response", async () => {
    const f = fixture()
    await startSandboxToolExec(toolRequest, scopeFor(), f.deps)
    const next = { ...toolRequest, requestId: "b7f2c35f-82d5-4fd3-80f1-dfa5f9d49f5b" }
    next.commandId = next.requestId
    const scope = scopeFor()
    scope.action.requestId = next.requestId
    scope.action.actionChecksum = sandboxToolExecChecksum(next, scope)
    await expect(startSandboxToolExec(next, scope, f.deps)).rejects.toThrow("unresolved")
    expect(f.native.start).toHaveBeenCalledOnce()
  })

  it("rejects a changed sandbox handle without invoking the root service", async () => {
    const f = fixture()
    const changed = {
      ...toolRequest,
      binding: { ...toolRequest.binding, sandboxHandle: "sandbox-2" },
    }
    await expect(startSandboxToolExec(changed, scopeFor(), f.deps)).rejects.toThrow("binding")
    expect(f.native.start).not.toHaveBeenCalled()
  })

  it("uses the exact snapshotted ownership if the caller mutates its object during fencing", async () => {
    const f = fixture()
    const scope = scopeFor({ ...ownership })
    f.deps.fence = {
      run: async (_action, effect) => {
        scope.ownership.containerId = "f".repeat(64)
        scope.ownership.ownershipId = `own_${"f".repeat(40)}`
        return effect(() => undefined, { guardId: "guard-1" })
      },
    }
    await startSandboxToolExec(toolRequest, scope, f.deps)
    expect(f.native.start).toHaveBeenCalledWith(
      scope.action,
      expect.objectContaining({ ownership })
    )
    expect(f.events[0]?.tool.containerId).toBe(ownership.containerId)
  })

  it("rejects a foreign retained sandbox before invoking root execution", async () => {
    const f = fixture()
    f.executor.inspect.mockResolvedValueOnce({
      state: "PRESENT",
      running: true,
      ownership: { ...ownership, containerId: "f".repeat(64) },
    })
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "retained sandbox"
    )
    expect(f.native.start).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
  })

  it("does not invoke anything when the current action fence rejects", async () => {
    const f = fixture()
    f.deps.fence = {
      run: async () => {
        throw new Error("authority unavailable")
      },
    }
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "authority unavailable"
    )
    expect(f.journal.load).not.toHaveBeenCalled()
    expect(f.native.start).not.toHaveBeenCalled()
  })

  it("does not invoke if the fence does not supply a committed guard", async () => {
    const f = fixture()
    f.deps.fence = { run: async (_binding, effect) => effect(() => undefined) }
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "durable sandbox invocation guard"
    )
    expect(f.journal.load).not.toHaveBeenCalled()
    expect(f.native.start).not.toHaveBeenCalled()
  })

  it("never creates an exec if the original intent cannot be mirrored", async () => {
    const f = fixture()
    f.journal.append.mockRejectedValueOnce(new Error("mirror unavailable"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "mirror unavailable"
    )
    expect(f.native.start).not.toHaveBeenCalled()
  })

  it("does not publish an ACK when the fence expires after the root start", async () => {
    const f = fixture()
    let active = true
    f.deps.fence = {
      run: async (_action, effect) =>
        effect(
          () => {
            if (!active) throw new Error("fence expired")
          },
          { guardId: "guard-1" }
        ),
    }
    f.native.start.mockImplementationOnce(async () => {
      active = false
      return { execId: "e".repeat(64) }
    })
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "fence expired"
    )
    expect(f.events.map((event) => event.type)).toEqual(["tool_intent"])
    expect(f.acknowledgeStarted).not.toHaveBeenCalled()
  })

  it("does not publish a start ACK if retaining its identity loses mirror acknowledgement", async () => {
    const f = fixture()
    f.journal.append.mockImplementationOnce(async (event) => {
      f.events.push(event)
    })
    f.journal.append.mockRejectedValueOnce(new Error("created record acknowledgement lost"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "acknowledgement lost"
    )
    expect(f.native.start).toHaveBeenCalledOnce()
    expect(f.acknowledgeStarted).not.toHaveBeenCalled()
  })
})
