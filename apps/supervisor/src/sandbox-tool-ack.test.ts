import { describe, expect, it, vi } from "vitest"
import type {
  BoundedConditionalObjectStore,
  JournalRecord,
  StoredObject,
} from "@lyrashield/runtime-control"
import { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import {
  SandboxToolJournal,
  sandboxToolEventSchema,
  type SandboxToolEvent,
} from "./sandbox-tool-journal"
import { SandboxToolResponses } from "./sandbox-tool-response"
import { observeSandboxToolTerminal } from "./sandbox-tool-terminal"

const binding = {
  attemptId: "attempt-1",
  operationId: "operation-1",
  authorityEpochId: "epoch-1",
  sandboxHandle: "sandbox-1",
}
const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
const handleChecksum = "bc2cc17bf72365e870812896e41b82f5a76bd9dc9484e3dca61952c194563fd4"

class Store implements BoundedConditionalObjectStore {
  readonly objects = new Map<string, StoredObject>()
  loseAck = false
  async read(key: string) {
    return this.objects.get(key) ?? null
  }
  async readBounded(key: string, maximum: number) {
    const result = await this.read(key)
    if (result && result.bytes.byteLength > maximum) throw new Error("too large")
    return result
  }
  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ) {
    const previous = this.objects.get(key)
    if (
      ("ifNoneMatch" in condition && previous) ||
      ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
    )
      return "conflict" as const
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: "first" })
    if (this.loseAck) throw new Error("lost object ack")
    return "written" as const
  }
}

function fixture() {
  const base = {
    supervisorInstanceId: "supervisor-1.tools",
    observedAt: "2026-11-13T00:00:00.000Z",
    binding: {
      attemptId: binding.attemptId,
      operationId: binding.operationId,
      authorityEpochId: binding.authorityEpochId,
      scanId: "scan-1",
      workspaceId: "workspace-1",
    },
    tool: {
      requestId,
      kind: "exec",
      commandId: requestId,
      prepareCommandId: "prepare-1",
      invocationGuardId: "guard-1",
      actionChecksum: "a".repeat(64),
      handleChecksum,
      containerId: "c".repeat(64),
      maxOutputBytes: 1024,
    },
  }
  const events: SandboxToolEvent[] = [
    sandboxToolEventSchema.parse({ ...base, type: "tool_intent" }),
    ...(["tool_created", "tool_starting", "tool_started"] as const).map((type) =>
      sandboxToolEventSchema.parse({
        ...base,
        type,
        tool: { ...base.tool, execId: "e".repeat(64) },
      })
    ),
  ]
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
    append: vi.fn(async (input: SandboxToolEvent) => {
      events.push(sandboxToolEventSchema.parse(input))
    }),
  }
  const store = new Store()
  const responses = new SandboxToolResponses(store, "s".repeat(48))
  const response = {
    binding,
    requestId,
    status: "COMPLETED",
    exitCode: 0,
    stdoutBase64: "YWJj",
    stderrBase64: "",
  }
  const observer = {
    observe: vi.fn(
      async (): Promise<{
        execId: string
        containerId: string
        invocationGuardId: string
        actionChecksum: string
        state: string
        exitCode: number | null
        response: typeof response
      }> => ({
        execId: "e".repeat(64),
        containerId: "c".repeat(64),
        invocationGuardId: "guard-1",
        actionChecksum: "a".repeat(64),
        state: "EXITED",
        exitCode: 0,
        response,
      })
    ),
  }
  const ledger = new SandboxToolAcknowledgements(
    journal as unknown as SandboxToolJournal,
    responses,
    observer
  )
  return { events, journal, store, ledger, response, observer, responses }
}

describe("sandbox terminal receipt acknowledgements", () => {
  it("rejects output exceeding the limit retained with the invocation", async () => {
    const f = fixture()
    for (const event of f.events) Object.assign(event.tool, { maxOutputBytes: 3 })
    f.response.stderrBase64 = "ZA=="
    await expect(f.ledger.complete(binding, requestId)).rejects.toThrow(
      "sandbox output is too large"
    )
    expect(f.store.objects.size).toBe(0)
    expect(f.journal.append).not.toHaveBeenCalled()
  })

  it("rejects a changed or absent retained output limit", async () => {
    const f = fixture()
    for (const event of f.events) Object.assign(event.tool, { maxOutputBytes: 3 })
    Object.assign(f.events.at(-1)!.tool, { maxOutputBytes: 4 })
    await expect(f.ledger.complete(binding, requestId)).rejects.toThrow("history conflicts")
    expect(f.observer.observe).not.toHaveBeenCalled()

    const legacy = fixture()
    for (const event of legacy.events) delete event.tool.maxOutputBytes
    await expect(legacy.ledger.complete(binding, requestId)).rejects.toThrow("output limit")
    expect(legacy.observer.observe).not.toHaveBeenCalled()
  })

  it.each(["complete", "replay", "acknowledge"] as const)(
    "rejects an authenticated oversized retained response during %s",
    async (method) => {
      const f = fixture()
      for (const event of f.events) Object.assign(event.tool, { maxOutputBytes: 3 })
      f.response.stderrBase64 = "ZA=="
      const proof = await f.responses.retain(binding, requestId, f.response)
      f.events.push(
        sandboxToolEventSchema.parse({
          ...f.events.at(-1),
          type: "tool_response",
          tool: { ...f.events.at(-1)!.tool, ...proof },
        })
      )
      const result =
        method === "complete"
          ? f.ledger.complete(binding, requestId)
          : method === "replay"
            ? f.ledger.replay(binding, requestId, "a".repeat(64))
            : f.ledger.acknowledge(binding, requestId, proof.responseChecksum)
      await expect(result).rejects.toThrow("sandbox output is too large")
      expect(f.journal.append).not.toHaveBeenCalled()
      expect(f.observer.observe).not.toHaveBeenCalled()
    }
  )

  it("fails closed without an installed terminal observer", async () => {
    const f = fixture()
    const closed = new SandboxToolAcknowledgements(
      f.journal as unknown as SandboxToolJournal,
      f.responses
    )
    await expect(closed.complete(binding, requestId)).rejects.toThrow("observer unavailable")
    expect(f.events.at(-1)?.type).toBe("tool_started")
  })

  it("rejects a running sync exec or foreign native exec identity", async () => {
    const f = fixture()
    const observed = await f.observer.observe()
    f.observer.observe.mockResolvedValueOnce({ ...observed, state: "RUNNING", exitCode: null })
    await expect(f.ledger.complete(binding, requestId)).rejects.toThrow()
    f.observer.observe.mockResolvedValueOnce({ ...observed, execId: "f".repeat(64) })
    await expect(f.ledger.complete(binding, requestId)).rejects.toThrow("identity differs")
    expect(f.events.at(-1)?.type).toBe("tool_started")
  })

  it("accepts a proven running PTY start without pretending the process exited", async () => {
    const f = fixture()
    const original = sandboxToolEventSchema.parse({
      ...f.events.at(-1),
      tool: { ...f.events.at(-1)?.tool, kind: "pty/start" },
    })
    const response = {
      binding,
      requestId,
      status: "COMPLETED",
      sessionId: 1,
      outputBase64: "",
      outputCursor: 0,
      exitCode: null,
      originalTokenCount: null,
    }
    const observer = {
      observe: async () => ({
        execId: "e".repeat(64),
        containerId: "c".repeat(64),
        invocationGuardId: "guard-1",
        actionChecksum: "a".repeat(64),
        state: "RUNNING",
        exitCode: null,
        response,
      }),
    }
    expect(await observeSandboxToolTerminal(observer, binding, original)).toEqual(response)
  })

  it("retains terminal bytes and durably acknowledges the exact checksum once", async () => {
    const f = fixture()
    const proof = await f.ledger.complete(binding, requestId)
    const expected = {
      binding,
      requestId,
      status: "ACKNOWLEDGED",
      responseChecksum: proof.responseChecksum,
    }
    expect(await f.ledger.acknowledge(binding, requestId, proof.responseChecksum)).toEqual(expected)
    expect(await f.ledger.acknowledge(binding, requestId, proof.responseChecksum)).toEqual(expected)
    expect(f.events.map((event) => event.type)).toEqual([
      "tool_intent",
      "tool_created",
      "tool_starting",
      "tool_started",
      "tool_response",
      "tool_ack",
    ])
    expect(await f.ledger.replay(binding, requestId, "a".repeat(64))).toEqual(f.response)
    await expect(f.ledger.replay(binding, requestId, "b".repeat(64))).rejects.toThrow()
  })

  it("does not acknowledge a wrong checksum, foreign handle or missing response", async () => {
    const f = fixture()
    await expect(
      f.ledger.acknowledge(binding, requestId, `sha256:${"0".repeat(64)}`)
    ).rejects.toThrow()
    const proof = await f.ledger.complete(binding, requestId)
    await expect(
      f.ledger.acknowledge(binding, requestId, `sha256:${"0".repeat(64)}`)
    ).rejects.toThrow()
    await expect(
      f.ledger.acknowledge(
        { ...binding, sandboxHandle: "sandbox-2" },
        requestId,
        proof.responseChecksum
      )
    ).rejects.toThrow()
    expect(f.events.at(-1)?.type).toBe("tool_response")
  })

  it("recovers a committed response object after its write acknowledgement is lost", async () => {
    const f = fixture()
    f.store.loseAck = true
    await expect(f.ledger.complete(binding, requestId)).rejects.toThrow("lost object ack")
    expect(f.events.at(-1)?.type).toBe("tool_started")
    f.store.loseAck = false
    expect(await f.ledger.recoverRetained(binding, requestId)).toEqual(f.response)
    expect(f.events.at(-1)?.type).toBe("tool_response")
  })

  it("does not acknowledge when stored ciphertext is altered", async () => {
    const f = fixture()
    const proof = await f.ledger.complete(binding, requestId)
    const [key, object] = [...f.store.objects.entries()][0]!
    f.store.objects.set(key, { ...object, bytes: Buffer.from("tampered") })
    await expect(f.ledger.acknowledge(binding, requestId, proof.responseChecksum)).rejects.toThrow()
    expect(f.events.at(-1)?.type).toBe("tool_response")
  })
})
