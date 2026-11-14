import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  BoundedConditionalObjectStore,
  JournalRecord,
  StoredObject,
} from "@lyrashield/runtime-control"
import { createSupervisorHandler } from "./http"
import { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import { createSandboxToolAckHandler, type SandboxToolRequestAuthority } from "./sandbox-tool-http"
import {
  SandboxToolJournal,
  sandboxToolEventSchema,
  type SandboxToolEvent,
} from "./sandbox-tool-journal"
import { SandboxToolResponses } from "./sandbox-tool-response"
import type { SupervisorService } from "./service"

const binding = {
  attemptId: "attempt-1",
  operationId: "operation-1",
  authorityEpochId: "epoch-1",
  sandboxHandle: "sandbox-1",
}
const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
const token = "t".repeat(48)
const servers: ReturnType<typeof createServer>[] = []

class Store implements BoundedConditionalObjectStore {
  readonly values = new Map<string, StoredObject>()
  async read(key: string) {
    return this.values.get(key) ?? null
  }
  async readBounded(key: string, limit: number) {
    const found = await this.read(key)
    if (found && found.bytes.byteLength > limit) throw new Error("too large")
    return found
  }
  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ) {
    const existing = this.values.get(key)
    if (
      ("ifNoneMatch" in condition && existing) ||
      ("ifMatch" in condition && existing?.etag !== condition.ifMatch)
    )
      return "conflict" as const
    this.values.set(key, { bytes: Buffer.from(bytes), etag: "one" })
    return "written" as const
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function fixture(installed = true) {
  const tool = {
    requestId,
    kind: "exec",
    commandId: requestId,
    prepareCommandId: "prepare-1",
    invocationGuardId: "guard-1",
    actionChecksum: "a".repeat(64),
    handleChecksum: "bc2cc17bf72365e870812896e41b82f5a76bd9dc9484e3dca61952c194563fd4",
    containerId: "c".repeat(64),
    maxOutputBytes: 1024,
  }
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
  }
  const journalBinding = base.binding
  const events: SandboxToolEvent[] = [
    sandboxToolEventSchema.parse({ ...base, binding: journalBinding, tool, type: "tool_intent" }),
    ...(["tool_created", "tool_starting", "tool_started"] as const).map((type) =>
      sandboxToolEventSchema.parse({
        ...base,
        binding: journalBinding,
        tool: { ...tool, execId: "e".repeat(64) },
        type,
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
    append: vi.fn(async (event: SandboxToolEvent) => {
      events.push(sandboxToolEventSchema.parse(event))
    }),
  }
  const responses = new SandboxToolResponses(new Store(), "s".repeat(48))
  const terminalResponse = {
    binding,
    requestId,
    status: "COMPLETED",
    exitCode: 0,
    stdoutBase64: "",
    stderrBase64: "",
  }
  const ack = new SandboxToolAcknowledgements(journal as unknown as SandboxToolJournal, responses, {
    observe: async () => ({
      execId: "e".repeat(64),
      containerId: "c".repeat(64),
      invocationGuardId: "guard-1",
      actionChecksum: "a".repeat(64),
      state: "EXITED",
      exitCode: 0,
      response: terminalResponse,
    }),
  })
  const proof = await ack.complete(binding, requestId)
  const authority: SandboxToolRequestAuthority = {
    run: async (credential, operation) => {
      if (
        credential.token !== token ||
        credential.attemptId !== binding.attemptId ||
        credential.sandboxHandle !== binding.sandboxHandle
      )
        throw new Error("authority unavailable")
      return operation(binding)
    },
  }
  const service = undefined as unknown as SupervisorService
  const server = createServer(
    createSupervisorHandler(service, {
      controlToken: "c".repeat(48),
      admission: "closed",
      ...(installed ? { sandboxToolHandler: createSandboxToolAckHandler(authority, ack) } : {}),
    })
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}/v1/sandbox/${binding.attemptId}/request/${requestId}/ack`
  return { events, proof, url }
}

describe("supervisor sandbox ACK route", () => {
  it("uses scan-bound authority and returns the exact durable acknowledgement", async () => {
    const f = await fixture()
    const response = await fetch(f.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-lyrashield-sandbox-handle": binding.sandboxHandle,
      },
      body: JSON.stringify({ binding, requestId, responseChecksum: f.proof.responseChecksum }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      binding,
      requestId,
      status: "ACKNOWLEDGED",
      responseChecksum: f.proof.responseChecksum,
    })
    expect(f.events.at(-1)?.type).toBe("tool_ack")
  })

  it("does not accept the separate supervisor control token as a scan grant", async () => {
    const f = await fixture()
    const response = await fetch(f.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"c".repeat(48)}`,
        "x-lyrashield-sandbox-handle": binding.sandboxHandle,
      },
      body: JSON.stringify({ binding, requestId, responseChecksum: f.proof.responseChecksum }),
    })
    expect(response.status).toBe(503)
    expect(f.events.at(-1)?.type).toBe("tool_response")
  })

  it("stays unavailable when no protected tool authority is installed", async () => {
    const f = await fixture(false)
    const response = await fetch(f.url, { method: "POST" })
    expect(response.status).toBe(503)
    expect(f.events.at(-1)?.type).toBe("tool_response")
  })

  it("rejects an attempt/handle substitution and other sandbox routes", async () => {
    const f = await fixture()
    const headers = { authorization: `Bearer ${token}`, "x-lyrashield-sandbox-handle": "sandbox-2" }
    expect(
      (
        await fetch(f.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ binding, requestId, responseChecksum: f.proof.responseChecksum }),
        })
      ).status
    ).toBe(503)
    expect(
      (
        await fetch(f.url.replace(`/request/${requestId}/ack`, "/exec"), {
          method: "POST",
          headers,
        })
      ).status
    ).toBe(503)
    expect(f.events.at(-1)?.type).toBe("tool_response")
  })
})
