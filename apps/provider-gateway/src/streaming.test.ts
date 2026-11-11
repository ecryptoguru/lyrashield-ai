import { performance } from "node:perf_hooks"
import { mkdtemp, rm, copyFile, readFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SignedJournal,
  type ProviderGrantRequest,
  type JournalPort,
} from "@lyrashield/runtime-control"
import {
  ProviderGatewayService,
  providerJournalEventSchema,
  type ProviderJournalEvent,
} from "./service"
import { createProviderGatewayHandler } from "./http"
import { httpStreamSink, type ProviderStreamSink } from "./downstream"
import { fixturePolicy } from "./test-fixtures"
import { readBoundedResponse, MAX_DELIVERY_CHUNK_BYTES } from "./proxy-utils"

const secret = "s".repeat(48)
const control = "c".repeat(48)
const roots: string[] = []
const journals: SignedJournal<ProviderJournalEvent>[] = []
afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const terminal = {
  id: "response-stream-1",
  model: "gpt-6-luna",
  status: "completed",
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
    input_tokens_details: { cached_tokens: 0 },
  },
}
function frame(type: string, fields: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}
const pieces = [
  frame("response.created", { response: { id: terminal.id, model: terminal.model } }),
  frame("response.output_text.delta", {
    response_id: terminal.id,
    delta: "private streamed text 🛡",
  }),
  frame("response.completed", { response: terminal }),
].map((value) => Buffer.from(value))
const grantRequest: ProviderGrantRequest = {
  grantRequestId: "grant-stream-1",
  attemptId: "attempt-stream-1",
  scanId: "scan-stream-1",
  workspaceId: "workspace-stream-1",
  operationId: "operation-stream-1",
  authorityEpochId: "epoch-stream-1",
  authorityRevision: 1,
  expiresAt: "2026-11-05T11:00:00.000Z",
  providerId: "azure-ai",
  maxRequests: 10,
  costReservationMicros: 0,
  maxReservedCostMicros: 10_000,
}
async function fixture(
  fetchImpl: typeof fetch,
  policy = { ...fixturePolicy, maxConcurrentRequests: 1, deadlineMs: 10_000, idleTimeoutMs: 1_000 }
) {
  const root = await mkdtemp(join(tmpdir(), "gateway-stream-"))
  roots.push(root)
  const path = join(root, "journal.jsonl")
  const journal = new SignedJournal(path, secret, (value) =>
    providerJournalEventSchema.parse(value)
  )
  journals.push(journal)
  const options = {
    journal,
    signingSecret: secret,
    responseEncryptionSecret: "e".repeat(48),
    admission: "open" as const,
    now: () => new Date("2026-11-05T10:00:00.000Z"),
    authorizeGrant: async (_request: ProviderGrantRequest) => policy,
    fetchImpl,
    providers: new Map([
      [
        "azure-ai",
        {
          id: "azure-ai",
          baseUrl: "https://provider.example.test",
          auth: { kind: "authorization" as const, credential: "synthetic-provider-secret" },
          allowedPathPrefixes: ["/openai/"],
          requestPolicy: policy,
        },
      ],
    ]),
  }
  const service = new ProviderGatewayService(options)
  const grant = await service.issueGrant(grantRequest)
  const input = {
    scanId: grantRequest.scanId,
    providerId: "azure-ai",
    path: policy.endpoint,
    method: "POST",
    authorization: `Bearer ${grant.token}`,
    requestId: "provider-stream-1",
    contentType: "application/json",
    accept: "text/event-stream",
    body: Buffer.from(
      JSON.stringify({ model: "gpt-6-luna", input: "hello", max_output_tokens: 64, stream: true })
    ),
  }
  return { root, path, journal, service, options, input, grant }
}
function source(chunks = pieces) {
  let offset = 0
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (offset >= chunks.length) controller.close()
    else controller.enqueue(chunks[offset++]!)
  })
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    { headers: { "content-type": "text/event-stream" } }
  )
  return { response, pull, cancel }
}
function sink() {
  const controller = new AbortController()
  const received: Buffer[] = []
  const start = vi.fn((_status: number, _headers: Record<string, string>) => undefined)
  const write = vi.fn(async (chunk: Uint8Array) => {
    received.push(Buffer.from(chunk))
  })
  const complete = vi.fn(async () => undefined)
  const value: ProviderStreamSink = { signal: controller.signal, start, write, complete }
  return { controller, received, start, write, complete, value }
}

describe("bounded scan-bound SSE delivery", () => {
  it("honors the HTTP writable backpressure signal and write acknowledgement", async () => {
    const response = new EventEmitter()
    let acknowledge: () => void = () => undefined
    Object.assign(response, {
      write: vi.fn((_chunk: Uint8Array, callback: () => void) => {
        acknowledge = callback
        return false
      }),
    })
    const destination = httpStreamSink(response as ServerResponse, new AbortController().signal)
    const pending = destination.write(Buffer.from("one bounded chunk"))
    let finished = false
    void pending.then(() => {
      finished = true
    })
    acknowledge()
    await Promise.resolve()
    expect(finished).toBe(false)
    response.emit("drain")
    await pending
    expect(finished).toBe(true)
    expect(response.listenerCount("drain")).toBe(0)
    expect(response.listenerCount("close")).toBe(0)
  })

  it("records actual HTTP downstream disconnect as UNKNOWN without finishing or retrying the stream", async () => {
    let provider: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            provider = controller
          },
          cancel() {
            return new Promise<void>(() => undefined)
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    )
    const fetchImpl = vi.fn(async () => response)
    const f = await fixture(fetchImpl)
    const calls = vi.spyOn(f.service, "proxy")
    const server = createServer(
      createProviderGatewayHandler(f.service, { admission: "open", controlToken: control })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("synthetic server has no port")
    try {
      const incoming = fetch(
        `http://127.0.0.1:${address.port}/v1/provider/azure-ai${f.input.path}`,
        {
          method: "POST",
          body: f.input.body,
          headers: {
            authorization: f.input.authorization,
            "content-type": "application/json",
            accept: "text/event-stream",
            "x-lyra-request-id": f.input.requestId,
            "x-lyra-scan-id": f.input.scanId,
          },
        }
      )
      provider?.enqueue(pieces[0]!)
      const reader = (await incoming).body!.getReader()
      expect(Buffer.from((await reader.read()).value!)).toEqual(pieces[0]!)
      const result = calls.mock.results[0]!.value.catch((error: unknown) => error)
      await reader.cancel()
      expect(await result).toMatchObject({ code: "PROVIDER_RESPONSE_UNKNOWN" })
      expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "UNKNOWN",
        physicalOutstanding: true,
        usage: null,
        reservationMicros: 288,
      })
      await expect(
        f.service.proxy({ ...f.input, requestId: "provider-after-http-disconnect" }, sink().value)
      ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      await f.service.drain()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it("delivers exact bytes incrementally and pauses provider reads while downstream is blocked", async () => {
    const upstream = source()
    const fetchImpl = vi.fn(async () => upstream.response)
    const f = await fixture(fetchImpl)
    const client = sink()
    const written = deferred<void>()
    const resume = deferred<void>()
    client.write.mockImplementationOnce(async (chunk) => {
      client.received.push(Buffer.from(chunk))
      written.resolve()
      await resume.promise
    })
    const pending = f.service.proxy(f.input, client.value)
    await written.promise
    expect(Buffer.concat(client.received)).toEqual(pieces[0]!)
    expect(upstream.pull).toHaveBeenCalledTimes(1)
    expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "PENDING",
      physicalOutstanding: true,
      reservationMicros: 288,
    })
    await Promise.resolve()
    expect(upstream.pull).toHaveBeenCalledTimes(1)
    resume.resolve()
    const result = await pending
    expect(result.streamed).toBe(true)
    expect(Buffer.concat(client.received)).toEqual(Buffer.concat(pieces))
    expect(client.complete).toHaveBeenCalledTimes(1)
    expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "SUCCEEDED",
      physicalOutstanding: false,
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    const rawJournal = await readFile(f.path, "utf8")
    expect(rawJournal).not.toContain("private streamed text")
    expect(rawJournal).not.toContain("synthetic-provider-secret")
    const replay = sink()
    const replayed = await f.service.proxy(f.input, replay.value)
    expect(replayed).toMatchObject({ replayed: true, streamed: true })
    expect(Buffer.concat(replay.received)).toEqual(Buffer.concat(pieces))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("streams real HTTP chunks before provider EOF and replays the encrypted completed response", async () => {
    let provider: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            provider = controller
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    )
    const fetchImpl = vi.fn(async () => response)
    const f = await fixture(fetchImpl)
    const calls = vi.spyOn(f.service, "proxy")
    const server = createServer(
      createProviderGatewayHandler(f.service, { admission: "open", controlToken: control })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("synthetic server has no port")
    const url = `http://127.0.0.1:${address.port}/v1/provider/azure-ai${f.input.path}`
    const headers = {
      authorization: f.input.authorization,
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-lyra-request-id": f.input.requestId,
      "x-lyra-scan-id": f.input.scanId,
    }
    try {
      const request = fetch(url, { method: "POST", headers, body: f.input.body })
      provider?.enqueue(pieces[0]!)
      const incoming = await request
      expect(incoming.status).toBe(200)
      expect(incoming.headers.get("content-length")).toBeNull()
      const reader = incoming.body!.getReader()
      const first = await reader.read()
      expect(Buffer.from(first.value!)).toEqual(pieces[0]!)
      expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "PENDING",
        physicalOutstanding: true,
      })
      const rest = Buffer.concat(pieces.slice(1))
      for (let offset = 0; offset < rest.length; offset += 3)
        provider?.enqueue(rest.subarray(offset, offset + 3))
      provider?.close()
      const received = [Buffer.from(first.value!)]
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        received.push(Buffer.from(chunk.value))
      }
      await calls.mock.results[0]!.value
      expect(Buffer.concat(received)).toEqual(Buffer.concat(pieces))
      expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "SUCCEEDED",
      })
      const replay = await fetch(url, { method: "POST", headers, body: f.input.body })
      expect(Buffer.from(await replay.arrayBuffer())).toEqual(Buffer.concat(pieces))
      await calls.mock.results[1]!.value
      expect(replay.headers.get("x-lyra-replayed")).toBe("true")
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      await f.service.drain()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it.each([undefined, "foreign-scan"])(
    "rejects missing or foreign scan identity before provider effect (%s)",
    async (scanId) => {
      const fetchImpl = vi.fn(async () => source().response)
      const f = await fixture(fetchImpl)
      const client = sink()
      await expect(f.service.proxy({ ...f.input, scanId }, client.value)).rejects.toMatchObject({
        code: scanId ? "GRANT_BINDING_MISMATCH" : "SCAN_ID_REQUIRED",
      })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(client.start).not.toHaveBeenCalled()
    }
  )

  it.each(["disconnect", "revocation", "expiry"])(
    "fences delivery under %s while a write is awaiting backpressure",
    async (reason) => {
      const upstream = source()
      const fetchImpl = vi.fn(async () => upstream.response)
      const f = await fixture(fetchImpl)
      let clock = f.options.now()
      const service = new ProviderGatewayService({ ...f.options, now: () => clock })
      const client = sink()
      const written = deferred<void>()
      const resume = deferred<void>()
      client.write.mockImplementationOnce(async (chunk) => {
        client.received.push(Buffer.from(chunk))
        written.resolve()
        await resume.promise
      })
      const pending = service.proxy(f.input, client.value).catch((error: unknown) => error)
      await written.promise
      if (reason === "disconnect") client.controller.abort()
      if (reason === "revocation")
        await service.revokeGrant({
          grantId: f.grant.grantId,
          attemptId: grantRequest.attemptId,
          reason: "stop",
        })
      if (reason === "expiry") {
        clock = new Date(grantRequest.expiresAt)
        resume.resolve()
      }
      expect(await pending).toMatchObject({ code: "PROVIDER_RESPONSE_UNKNOWN" })
      resume.resolve()
      await Promise.resolve()
      expect(client.write).toHaveBeenCalledTimes(1)
      expect(client.complete).not.toHaveBeenCalled()
      expect(upstream.pull).toHaveBeenCalledTimes(1)
      expect(await service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "UNKNOWN",
        physicalOutstanding: true,
        usage: null,
        reservationMicros: 288,
      })
      if (reason === "disconnect") {
        await expect(
          service.proxy({ ...f.input, requestId: "provider-after-disconnect" }, sink().value)
        ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
        await expect(service.proxy(f.input, sink().value)).rejects.toMatchObject({
          code: "REQUEST_UNKNOWN",
        })
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { chunks: pieces.slice(0, 2) },
    { chunks: [pieces[0]!, Buffer.from("data: {bad}\n\n")] },
    {
      chunks: [
        pieces[0]!,
        frame("response.completed", { response: { ...terminal, usage: undefined } }),
      ].map((value) => Buffer.from(value)),
    },
  ])(
    "keeps partial, malformed or missing-usage streams UNKNOWN after provisional bytes (%#)",
    async ({ chunks }) => {
      const fetchImpl = vi.fn(async () => source(chunks).response)
      const f = await fixture(fetchImpl)
      const client = sink()
      await expect(f.service.proxy(f.input, client.value)).rejects.toMatchObject({
        code: "PROVIDER_RESPONSE_UNKNOWN",
      })
      expect(client.received.length).toBeGreaterThan(0)
      expect(client.complete).not.toHaveBeenCalled()
      expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "UNKNOWN",
        physicalOutstanding: true,
        usage: null,
      })
      await expect(f.service.proxy(f.input, sink().value)).rejects.toMatchObject({
        code: "REQUEST_UNKNOWN",
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each(["idle", "deadline"])(
    "bounds downstream %s stalls and retains the physical hold",
    async (bound) => {
      const upstream = source()
      const fetchImpl = vi.fn(async () => upstream.response)
      const policy = {
        ...fixturePolicy,
        maxConcurrentRequests: 1,
        idleTimeoutMs: bound === "idle" ? 30 : 1_000,
        deadlineMs: bound === "deadline" ? 100 : 1_000,
      }
      const f = await fixture(fetchImpl, policy)
      const client = sink()
      client.write.mockImplementation(async () => new Promise<void>(() => undefined))
      await expect(f.service.proxy(f.input, client.value)).rejects.toMatchObject({
        code: "PROVIDER_RESPONSE_UNKNOWN",
      })
      expect(client.write).toHaveBeenCalledTimes(1)
      expect(upstream.pull).toHaveBeenCalledTimes(1)
      expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "UNKNOWN",
        physicalOutstanding: true,
      })
    }
  )

  it("keeps disconnected unacknowledged provider headers UNKNOWN even if the provider later completes", async () => {
    const completion = deferred<Response>()
    const fetchImpl = vi.fn(() => completion.promise)
    const f = await fixture(fetchImpl)
    const client = sink()
    const started = deferred<void>()
    fetchImpl.mockImplementation(() => {
      started.resolve()
      return completion.promise
    })
    const pending = f.service.proxy(f.input, client.value).catch((error: unknown) => error)
    await started.promise
    client.controller.abort()
    expect(await pending).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    completion.resolve(source().response)
    await completion.promise
    await expect(
      f.service.proxy({ ...f.input, requestId: "provider-late-completion" }, sink().value)
    ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
    expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("recovers a crash image after provisional delivery without repeating provider work", async () => {
    const f = await fixture(vi.fn(async () => source().response))
    const client = sink()
    const written = deferred<void>()
    const resume = deferred<void>()
    client.write.mockImplementationOnce(async () => {
      written.resolve()
      await resume.promise
    })
    const pending = f.service.proxy(f.input, client.value).catch((error: unknown) => error)
    await written.promise
    const crashRoot = await mkdtemp(join(tmpdir(), "gateway-stream-crash-"))
    roots.push(crashRoot)
    const crashPath = join(crashRoot, "journal.jsonl")
    await copyFile(f.path, crashPath)
    const journal = new SignedJournal(crashPath, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    journals.push(journal)
    const replacement = new ProviderGatewayService({ ...f.options, journal })
    await expect(replacement.proxy(f.input, sink().value)).rejects.toMatchObject({
      code: "REQUEST_UNKNOWN",
    })
    expect(await replacement.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
      reservationMicros: 288,
    })
    await expect(
      replacement.proxy({ ...f.input, requestId: "provider-after-crash" }, sink().value)
    ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
    expect(f.options.fetchImpl).toHaveBeenCalledTimes(1)
    client.controller.abort()
    resume.resolve()
    await pending
  })

  it("retains uncertainty when disconnect crosses a real completion journal write", async () => {
    const f = await fixture(vi.fn(async () => source().response))
    const client = sink()
    const fault: JournalPort<ProviderJournalEvent> = {
      load: () => f.journal.load(),
      append: async (event) => {
        const result = await f.journal.append(event)
        if (event.type === "request_result" && event.result.outcome === "SUCCEEDED")
          client.controller.abort()
        return result
      },
    }
    const service = new ProviderGatewayService({ ...f.options, journal: fault })
    await expect(service.proxy(f.input, client.value)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    })
    expect(await service.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
      usage: null,
    })
    expect((await f.journal.load()).at(-1)?.payload).toMatchObject({
      type: "stream_delivery_uncertain",
    })
    await expect(service.proxy(f.input, sink().value)).rejects.toMatchObject({
      code: "REQUEST_UNKNOWN",
    })
  })

  it("bounds total bytes and individual SSE messages while leaving incomplete work held", async () => {
    for (const kind of ["total", "message"]) {
      const payload = Buffer.from(
        frame("response.output_text.delta", { delta: "x".repeat(270 * 1024) })
      )
      const f = await fixture(
        vi.fn(async () => source([payload]).response),
        {
          ...fixturePolicy,
          maxConcurrentRequests: 1,
          maxResponseBytes: kind === "total" ? 64 * 1024 : 512 * 1024,
        }
      )
      const client = sink()
      await expect(f.service.proxy(f.input, client.value)).rejects.toMatchObject({
        code: "PROVIDER_RESPONSE_UNKNOWN",
      })
      expect(
        client.write.mock.calls.every(([chunk]) => chunk.byteLength <= MAX_DELIVERY_CHUNK_BYTES)
      ).toBe(true)
      expect(client.complete).not.toHaveBeenCalled()
      expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
        outcome: "UNKNOWN",
        physicalOutstanding: true,
      })
    }
  })

  it("keeps a lost stream completion acknowledgement durably UNKNOWN on restart", async () => {
    const f = await fixture(vi.fn(async () => source().response))
    let failed = false
    const fault: JournalPort<ProviderJournalEvent> = {
      load: () => f.journal.load(),
      append: async (event) => {
        const record = await f.journal.append(event)
        if (event.type === "request_result" && event.result.outcome === "SUCCEEDED" && !failed) {
          failed = true
          throw new Error("lost stream acknowledgement")
        }
        return record
      },
    }
    const service = new ProviderGatewayService({ ...f.options, journal: fault })
    await expect(service.proxy(f.input, sink().value)).rejects.toThrow(
      "lost stream acknowledgement"
    )
    expect(await service.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
    await f.journal.close()
    const journal = new SignedJournal(f.path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    journals.push(journal)
    const replacement = new ProviderGatewayService({ ...f.options, journal })
    await expect(replacement.proxy(f.input, sink().value)).rejects.toMatchObject({
      code: "REQUEST_UNKNOWN",
    })
    expect(await replacement.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
    expect(f.options.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("bounds concurrent replay deliveries and aborts every stalled replay on revocation", async () => {
    const f = await fixture(vi.fn(async () => source().response))
    await f.service.proxy(f.input, sink().value)
    const deliveries: Promise<unknown>[] = []
    const resumes: ReturnType<typeof deferred<void>>[] = []
    for (let number = 0; number < 8; number++) {
      const client = sink()
      const started = deferred<void>()
      const resume = deferred<void>()
      resumes.push(resume)
      client.write.mockImplementation(async () => {
        started.resolve()
        await resume.promise
      })
      const pending = f.service.proxy(f.input, client.value).catch((error: unknown) => error)
      deliveries.push(pending)
      await started.promise
    }
    await expect(f.service.proxy(f.input, sink().value)).rejects.toMatchObject({
      code: "DELIVERY_CONCURRENCY_EXHAUSTED",
    })
    await f.service.revokeGrant({
      grantId: f.grant.grantId,
      attemptId: grantRequest.attemptId,
      reason: "stop",
    })
    expect((await Promise.all(deliveries)).every((value) => value instanceof Error)).toBe(true)
    for (const resume of resumes) resume.resolve()
    expect(f.options.fetchImpl).toHaveBeenCalledTimes(1)
    // Failed replay delivery never creates new provider work or erases the
    // original authenticated completed provider receipt.
    expect(await f.service.inspectRequest(f.input.requestId)).toMatchObject({
      outcome: "SUCCEEDED",
      physicalOutstanding: false,
    })
  })

  it("enforces elapsed deadlines even when resolved reads starve timer callbacks", async () => {
    const bytes = Buffer.alloc(2 * MAX_DELIVERY_CHUNK_BYTES, 120)
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    )
    const deadlineAt = performance.now() + 5
    let delivered = 0
    await expect(
      readBoundedResponse(response, bytes.length, {
        signal: new AbortController().signal,
        idleTimeoutMs: 1_000,
        deadlineAt,
        onChunk: () => {
          delivered++
          while (performance.now() < deadlineAt + 1) {
            /* model synchronous consumer work */
          }
        },
      })
    ).rejects.toMatchObject({ code: "PROVIDER_DEADLINE_EXCEEDED" })
    expect(delivered).toBeLessThanOrEqual(1)
  })

  it("bounds storage and delivery size independently of provider fragmentation", async () => {
    const bytes = Buffer.alloc(128 * 1024, 120)
    let offset = 0
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset === bytes.length) controller.close()
            else {
              controller.enqueue(bytes.subarray(offset, offset + 1))
              offset++
            }
          },
        },
        { highWaterMark: 0 }
      )
    )
    const received: number[] = []
    const body = await readBoundedResponse(response, bytes.length, {
      signal: new AbortController().signal,
      idleTimeoutMs: 1_000,
      onChunk: (chunk) => {
        received.push(chunk.byteLength)
      },
    })
    expect(body).toEqual(bytes)
    expect(body.buffer.byteLength).toBe(bytes.length)
    expect(received.length).toBe(bytes.length)
    const sizes: number[] = []
    const large = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    )
    await readBoundedResponse(large, bytes.length, {
      signal: new AbortController().signal,
      idleTimeoutMs: 1_000,
      onChunk: (chunk) => {
        sizes.push(chunk.byteLength)
      },
    })
    expect(sizes).toEqual([MAX_DELIVERY_CHUNK_BYTES, MAX_DELIVERY_CHUNK_BYTES])
  })
})
