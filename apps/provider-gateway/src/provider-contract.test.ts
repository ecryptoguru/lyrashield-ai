import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SignedJournal,
  type JournalPort,
  type ProviderGrantRequest,
} from "@lyrashield/runtime-control"
import {
  ProviderGatewayService,
  providerJournalEventSchema,
  type ProviderJournalEvent,
} from "./service"
import { fixturePolicy } from "./test-fixtures"
import { signToken } from "./grant-tokens"
import { policyDigest, type RequestPolicy } from "./request-policy"

const secret = "s".repeat(48)
const encryptionSecret = "e".repeat(48)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const grantRequest: ProviderGrantRequest = {
  grantRequestId: "grant-contract-1",
  attemptId: "attempt-contract-1",
  scanId: "scan-contract-1",
  workspaceId: "workspace-contract-1",
  operationId: "operation-contract-1",
  authorityEpochId: "epoch-contract-1",
  authorityRevision: 1,
  expiresAt: "2026-11-05T11:00:00.000Z",
  providerId: "azure-ai",
  maxRequests: 10,
  costReservationMicros: 0,
  maxReservedCostMicros: 10_000,
}
const terminal = {
  id: "response-contract-1",
  model: "gpt-6-luna",
  status: "completed",
  output: [{ text: "private provider content 🛡" }],
  usage: {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16,
    input_tokens_details: { cached_tokens: 2 },
  },
}
function response(value: unknown = terminal) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
async function setup(
  options: {
    policy?: RequestPolicy
    fetchImpl?: typeof fetch
    journal?: JournalPort<ProviderJournalEvent>
    authorize?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "provider-contract-"))
  roots.push(root)
  const path = join(root, "journal.jsonl")
  const journal = new SignedJournal(path, secret, (value) =>
    providerJournalEventSchema.parse(value)
  )
  const policy = options.policy ?? fixturePolicy
  const fetchImpl = options.fetchImpl ?? vi.fn(async () => response())
  const authorizeGrant = vi.fn(async (_request: ProviderGrantRequest) => policy)
  const serviceOptions = {
    journal: options.journal ?? journal,
    signingSecret: secret,
    responseEncryptionSecret: encryptionSecret,
    admission: "open" as const,
    now: () => new Date("2026-11-05T10:00:00.000Z"),
    providers: new Map([
      [
        "azure-ai",
        {
          id: "azure-ai",
          baseUrl: "https://provider.example.test",
          auth: { kind: "authorization" as const, credential: "private-provider-credential" },
          allowedPathPrefixes: ["/openai/"],
          requestPolicy: policy,
        },
      ],
    ]),
    fetchImpl,
    ...(options.authorize === false ? {} : { authorizeGrant }),
  }
  const service = new ProviderGatewayService(serviceOptions)
  return { service, journal, path, fetchImpl, authorizeGrant, serviceOptions }
}
async function proxyInput(service: ProviderGatewayService, request = grantRequest) {
  const grant = await service.issueGrant(request)
  return {
    providerId: "azure-ai",
    path: fixturePolicy.endpoint,
    method: "POST",
    authorization: `Bearer ${grant.token}`,
    requestId: "provider-contract-1",
    contentType: "application/json",
    accept: "application/json",
    body: Buffer.from(
      JSON.stringify({ model: "gpt-6-luna", input: "private input", max_output_tokens: 64 })
    ),
  }
}
function sseFrame(type: string, fields: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}
function streamResponse(raw: string | Buffer, fragmentBytes = 3) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close()
        controller.enqueue(bytes.subarray(offset, offset + fragmentBytes))
        offset += fragmentBytes
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
}
function streamingInput(input: Awaited<ReturnType<typeof proxyInput>>) {
  return {
    ...input,
    accept: "text/event-stream",
    body: Buffer.from(
      JSON.stringify({ model: "gpt-6-luna", input: "hello", max_output_tokens: 64, stream: true })
    ),
  }
}

describe("server-authorized provider contract", () => {
  it("requires trusted broker policy even with an open synthetic service", async () => {
    const { service, fetchImpl } = await setup({ authorize: false })
    await expect(service.issueGrant(grantRequest)).rejects.toMatchObject({
      code: "BROKER_AUTHORIZATION_REQUIRED",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { scanId: "foreign-scan" },
    { workspaceId: "foreign-workspace" },
    { authorityRevision: 2 },
  ])(
    "rejects a signed token whose persisted scan or authority binding differs (%#)",
    async (changed) => {
      const { service, fetchImpl } = await setup()
      const input = await proxyInput(service)
      const grant = await service.findGrantByRequest(grantRequest.grantRequestId)
      if (!grant) throw new Error("fixture grant missing")
      const token = signToken(
        secret,
        { ...grantRequest, ...changed },
        grant.grantId,
        policyDigest(fixturePolicy)
      )
      await expect(
        service.proxy({ ...input, authorization: `Bearer ${token}` })
      ).rejects.toMatchObject({ code: "GRANT_BINDING_MISMATCH" })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it("rejects request byte caps before provider dispatch", async () => {
    const { service, fetchImpl } = await setup({
      policy: { ...fixturePolicy, maxRequestBytes: 64 },
    })
    const input = await proxyInput(service)
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reserves server-priced input/output caps despite a zero caller reservation", async () => {
    const { service, journal, authorizeGrant } = await setup()
    const input = await proxyInput(service)
    await service.proxy(input)
    const status = await service.inspectRequest(input.requestId)
    expect(status).toMatchObject({
      version: 1,
      scanId: grantRequest.scanId,
      workspaceId: grantRequest.workspaceId,
      reservationMicros: 288,
      outcome: "SUCCEEDED",
      usage: {
        inputTokens: 12,
        cachedInputTokens: 2,
        outputTokens: 4,
        costMicros: 4,
        policyDigest: policyDigest(fixturePolicy),
      },
    })
    expect(status?.receipt?.signature).toMatch(/^[a-f0-9]{64}$/)
    expect(authorizeGrant).toHaveBeenCalledTimes(2)
    expect(authorizeGrant).toHaveBeenLastCalledWith(grantRequest)
    expect(
      (await journal.load()).find((record) => record.payload.type === "request_started")?.payload
    ).toMatchObject({ request: { reservationMicros: 288 } })
  })

  it("rejects an underfunded aggregate reservation before any provider dispatch", async () => {
    const { service, fetchImpl } = await setup()
    const input = await proxyInput(service, { ...grantRequest, maxReservedCostMicros: 287 })
    await expect(service.proxy(input)).rejects.toMatchObject({
      code: "GRANT_COST_BUDGET_EXHAUSTED",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("revalidates broker authority for dispatch and response replay", async () => {
    const { service, authorizeGrant, fetchImpl } = await setup()
    const input = await proxyInput(service)
    await service.proxy(input)
    authorizeGrant.mockRejectedValue(new Error("authority unavailable"))
    await expect(service.proxy(input)).rejects.toThrow("authority unavailable")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    { body: { model: "unapproved", input: "hello", max_output_tokens: 1 }, code: "MODEL_DENIED" },
    { body: { model: "gpt-6-luna", input: "hello" }, code: "INVALID_PROVIDER_REQUEST" },
    {
      body: { model: "gpt-6-luna", input: "hello", max_output_tokens: 65 },
      code: "TOKEN_CAP_EXCEEDED",
    },
    {
      body: { model: "gpt-6-luna", input: "hello", max_output_tokens: 1, tools: [] },
      code: "INVALID_PROVIDER_REQUEST",
    },
    {
      body: {
        model: "gpt-6-luna",
        input: "hello",
        max_output_tokens: 1,
        previous_response_id: "remote",
      },
      code: "INVALID_PROVIDER_REQUEST",
    },
    {
      body: { model: "gpt-6-luna", input: "x".repeat(1025), max_output_tokens: 1 },
      code: "TOKEN_CAP_EXCEEDED",
    },
  ])("rejects request policy violations before dispatch: $code", async ({ body, code }) => {
    const { service, fetchImpl } = await setup()
    const input = await proxyInput(service)
    await expect(
      service.proxy({ ...input, body: Buffer.from(JSON.stringify(body)) })
    ).rejects.toMatchObject({ code })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("enforces an exact server endpoint and query instead of a path prefix", async () => {
    const { service, fetchImpl } = await setup()
    const input = await proxyInput(service)
    for (const path of [
      "/openai/files",
      "/openai/responses?api-version=2",
      "/openai/responses?api-version=1&extra=1",
    ])
      await expect(service.proxy({ ...input, path })).rejects.toMatchObject({
        code: "PROVIDER_PATH_DENIED",
      })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("retains fragmented SSE with exact authenticated replay after restart", async () => {
    const raw =
      sseFrame("response.created", {
        response: { id: terminal.id, model: terminal.model, status: "in_progress" },
      }) +
      sseFrame("response.output_text.delta", {
        response_id: terminal.id,
        delta: "private provider content 🛡",
      }) +
      sseFrame("response.completed", { response: terminal })
    const { service, journal, path, serviceOptions, fetchImpl } = await setup({
      fetchImpl: vi.fn(async () => streamResponse(raw)),
    })
    const input = streamingInput(await proxyInput(service))
    const original = await service.proxy(input)
    expect(original.body).toEqual(Buffer.from(raw))
    const stored = await readFile(path, "utf8")
    expect(stored).not.toContain("private provider content")
    expect(stored).not.toContain("private input")
    expect(stored).not.toContain("private-provider-credential")
    await journal.close()
    const replacementJournal = new SignedJournal(path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const replacement = new ProviderGatewayService({
      ...serviceOptions,
      journal: replacementJournal,
    })
    const replayed = await replacement.proxy(input)
    expect(replayed.body).toEqual(original.body)
    expect(replayed.headers).toEqual({ ...original.headers, "x-lyra-replayed": "true" })
    expect(replayed.replayed).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await replacementJournal.close()
  })

  it("binds usage identity to terminal usage rather than provider output bytes", async () => {
    const first = await setup()
    const second = await setup({
      fetchImpl: vi.fn(async () =>
        response({ ...terminal, output: [{ text: "different output" }] })
      ),
    })
    const a = await first.service.proxy(await proxyInput(first.service))
    const b = await second.service.proxy(await proxyInput(second.service))
    expect(a.body).not.toEqual(b.body)
    expect(a.headers["x-lyra-usage-id"]).toBe(b.headers["x-lyra-usage-id"])
  })

  it.each([
    { ...terminal, usage: undefined },
    { ...terminal, id: undefined },
    { ...terminal, model: "foreign-model" },
    { ...terminal, status: "incomplete" },
    { ...terminal, usage: { ...terminal.usage, input_tokens: -1 } },
    { ...terminal, usage: { ...terminal.usage, output_tokens: 65, total_tokens: 77 } },
    { ...terminal, usage: { ...terminal.usage, total_tokens: 17 } },
    { ...terminal, usage: { ...terminal.usage, input_tokens_details: { cached_tokens: 13 } } },
    { ...terminal, usage: { ...terminal.usage, cache_creation_input_tokens: 1 } },
  ])(
    "keeps malformed or missing terminal usage UNKNOWN and never resubmits (%#)",
    async (value) => {
      const { service, fetchImpl } = await setup({ fetchImpl: vi.fn(async () => response(value)) })
      const input = await proxyInput(service)
      await expect(service.proxy(input)).rejects.toMatchObject({
        code: "PROVIDER_RESPONSE_UNKNOWN",
      })
      expect(await service.inspectRequest(input.requestId)).toMatchObject({
        outcome: "UNKNOWN",
        usage: null,
        usageId: null,
      })
      await expect(service.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    sseFrame("response.created", { response: { id: "foreign-id", model: terminal.model } }) +
      sseFrame("response.completed", { response: terminal }),
    sseFrame("response.completed", { response: terminal }) +
      sseFrame("response.completed", { response: terminal }),
    sseFrame("response.output_text.delta", { delta: "partial" }),
    sseFrame("response.completed", { response: terminal }).trimEnd(),
    "data: {broken}\n\n",
  ])("rejects conflicting, duplicate, partial or malformed SSE (%#)", async (raw) => {
    const { service, fetchImpl } = await setup({
      fetchImpl: vi.fn(async () => streamResponse(raw)),
    })
    const input = streamingInput(await proxyInput(service))
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_UNKNOWN" })
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("does not treat an HTTP error or its response hash as usage", async () => {
    const { service } = await setup({
      fetchImpl: vi.fn(async () => new Response("private upstream error", { status: 500 })),
    })
    const input = await proxyInput(service)
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_UNKNOWN" })
    expect(await service.inspectRequest(input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      usage: null,
    })
  })

  it("rejects a provider response identity reused across requests", async () => {
    const { service, fetchImpl } = await setup()
    const input = await proxyInput(service)
    await service.proxy(input)
    await expect(
      service.proxy({ ...input, requestId: "provider-contract-2" })
    ).rejects.toMatchObject({ code: "PROVIDER_USAGE_UNKNOWN" })
    expect(await service.inspectRequest("provider-contract-2")).toMatchObject({
      outcome: "UNKNOWN",
      usage: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("aborts response byte caps and idle streams without accepting partial usage", async () => {
    const cancel = vi.fn()
    const cap = await setup({
      policy: { ...fixturePolicy, maxResponseBytes: 10 },
      fetchImpl: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from(JSON.stringify(terminal)))
              },
              cancel,
            }),
            { headers: { "content-type": "application/json" } }
          )
      ),
    })
    const capInput = await proxyInput(cap.service)
    await expect(cap.service.proxy(capInput)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_UNKNOWN",
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    const idleCancel = vi.fn()
    const idle = await setup({
      policy: { ...fixturePolicy, idleTimeoutMs: 20 },
      fetchImpl: vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel: idleCancel }), {
            headers: { "content-type": "application/json" },
          })
      ),
    })
    const idleInput = await proxyInput(idle.service)
    await expect(idle.service.proxy(idleInput)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_UNKNOWN",
    })
    expect(idleCancel).toHaveBeenCalledTimes(1)
    expect(await idle.service.inspectRequest(idleInput.requestId)).toMatchObject({
      outcome: "UNKNOWN",
    })
  })

  it("bounds a provider that never acknowledges request headers", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined))
    const { service } = await setup({ policy: { ...fixturePolicy, deadlineMs: 20 }, fetchImpl })
    const input = await proxyInput(service)
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("enforces concurrency without reserving or dispatching excess calls", async () => {
    let started: () => void = () => undefined
    const notified = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetchImpl = vi.fn(() => {
      started()
      return new Promise<Response>(() => undefined)
    })
    const { service } = await setup({
      policy: { ...fixturePolicy, maxConcurrentRequests: 1 },
      fetchImpl,
    })
    const input = await proxyInput(service)
    const pending = service.proxy(input).catch((error: unknown) => error)
    await notified
    await expect(
      service.proxy({ ...input, requestId: "provider-over-concurrency" })
    ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
    expect(await service.inspectRequest("provider-over-concurrency")).toBeNull()
    await service.drain()
    expect(await pending).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("recovers durable response bytes after a lost journal acknowledgement without resubmitting", async () => {
    const original = await setup()
    let lost = false
    const faultJournal: JournalPort<ProviderJournalEvent> = {
      load: () => original.journal.load(),
      append: async (event) => {
        const record = await original.journal.append(event)
        if (event.type === "request_result" && !lost) {
          lost = true
          throw new Error("lost durable acknowledgement")
        }
        return record
      },
    }
    const service = new ProviderGatewayService({
      ...original.serviceOptions,
      journal: faultJournal,
    })
    const input = await proxyInput(service)
    await expect(service.proxy(input)).rejects.toThrow("lost durable acknowledgement")
    await expect(service.proxy(input)).rejects.toMatchObject({ code: "ADMISSION_CLOSED" })
    await original.journal.close()
    const replacementJournal = new SignedJournal(original.path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const replacement = new ProviderGatewayService({
      ...original.serviceOptions,
      journal: replacementJournal,
    })
    expect((await replacement.proxy(input)).body.toString()).toBe(JSON.stringify(terminal))
    expect(original.fetchImpl).toHaveBeenCalledTimes(1)
    await replacementJournal.close()
  })

  it("records unresolved restart recovery as durable UNKNOWN without provider execution", async () => {
    const original = await setup()
    const input = await proxyInput(original.service)
    await original.service.proxy(input)
    const records = await original.journal.load()
    const scratch = await setup()
    for (const record of records.filter((item) => item.payload.type !== "request_result"))
      await scratch.journal.append(record.payload)
    const restarted = new ProviderGatewayService(scratch.serviceOptions)
    await expect(restarted.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
    expect((await scratch.journal.load()).at(-1)?.payload).toMatchObject({
      type: "request_result",
      result: { outcome: "UNKNOWN" },
    })
    expect(scratch.fetchImpl).not.toHaveBeenCalled()
  })

  it("recovers legacy hash-only success as durable UNKNOWN without rewriting old records", async () => {
    const original = await setup()
    const input = await proxyInput(original.service)
    await original.service.proxy(input)
    const records = await original.journal.load()
    const scratch = await setup()
    for (const record of records) {
      const event = structuredClone(record.payload)
      if (event.type === "request_result") {
        delete event.result.usage
        delete event.result.retainedResponse
      }
      await scratch.journal.append(event)
    }
    const restarted = new ProviderGatewayService(scratch.serviceOptions)
    expect(await restarted.inspectRequest(input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      usageId: null,
      usage: null,
    })
    const recovered = await scratch.journal.load()
    expect(recovered.at(-1)?.payload).toMatchObject({
      type: "legacy_request_uncertain",
      requestId: input.requestId,
    })
    expect(
      recovered.find((record) => record.payload.type === "request_result")?.payload
    ).toMatchObject({ result: { outcome: "SUCCEEDED" } })
    await expect(restarted.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
    expect(scratch.fetchImpl).not.toHaveBeenCalled()
    await scratch.journal.close()
    const againJournal = new SignedJournal(scratch.path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const again = new ProviderGatewayService({ ...scratch.serviceOptions, journal: againJournal })
    expect(await again.inspectRequest(input.requestId)).toMatchObject({ outcome: "UNKNOWN" })
    expect((await againJournal.load()).length).toBe(recovered.length)
    await againJournal.close()
  })

  it("authenticates retained ciphertext independently of the journal record signature", async () => {
    const original = await setup()
    const input = await proxyInput(original.service)
    await original.service.proxy(input)
    const scratch = await setup()
    for (const record of await original.journal.load()) {
      const event = structuredClone(record.payload)
      if (event.type === "request_result" && event.result.retainedResponse)
        event.result.retainedResponse.tag = "0".repeat(32)
      await scratch.journal.append(event)
    }
    const restarted = new ProviderGatewayService(scratch.serviceOptions)
    await expect(restarted.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
    expect(scratch.fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects the wrong response encryption key", async () => {
    const original = await setup()
    const input = await proxyInput(original.service)
    await original.service.proxy(input)
    await original.journal.close()
    const replacementJournal = new SignedJournal(original.path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const replacement = new ProviderGatewayService({
      ...original.serviceOptions,
      responseEncryptionSecret: "w".repeat(48),
      journal: replacementJournal,
    })
    await expect(replacement.proxy(input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
    expect(original.fetchImpl).toHaveBeenCalledTimes(1)
    await replacementJournal.close()
  })
})
