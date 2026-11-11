import { mkdtemp, rm } from "node:fs/promises"
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

const secret = "s".repeat(48)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const beforeExpiry = new Date("2026-11-05T10:00:00.000Z")
const expiresAt = "2026-11-05T11:00:00.000Z"
const request: ProviderGrantRequest = {
  grantRequestId: "grant-lifecycle-1",
  attemptId: "attempt-lifecycle-1",
  scanId: "scan-lifecycle-1",
  workspaceId: "workspace-lifecycle-1",
  operationId: "operation-lifecycle-1",
  authorityEpochId: "epoch-lifecycle-1",
  authorityRevision: 1,
  expiresAt,
  providerId: "azure-ai",
  maxRequests: 10,
  costReservationMicros: 0,
  maxReservedCostMicros: 10_000,
}
function terminalResponse(id = "response-lifecycle-1") {
  return new Response(
    JSON.stringify({
      id,
      model: "gpt-6-luna",
      status: "completed",
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } }
  )
}
async function setup(deadlineMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), "provider-lifecycle-"))
  roots.push(root)
  const path = join(root, "journal.jsonl")
  const journal = new SignedJournal(path, secret, (value) =>
    providerJournalEventSchema.parse(value)
  )
  const policy = { ...fixturePolicy, maxConcurrentRequests: 1, deadlineMs }
  const fetchImpl = vi.fn(async () => terminalResponse())
  const authorizeGrant = vi.fn(async (_request: ProviderGrantRequest) => policy)
  const options = {
    journal,
    signingSecret: secret,
    responseEncryptionSecret: "e".repeat(48),
    admission: "open" as const,
    now: () => beforeExpiry,
    fetchImpl,
    authorizeGrant,
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
  return { journal, path, policy, fetchImpl, authorizeGrant, options }
}
async function input(service: ProviderGatewayService, number = 1) {
  const grant = await service.issueGrant({
    ...request,
    grantRequestId: `grant-lifecycle-${number}`,
  })
  return {
    providerId: "azure-ai",
    path: fixturePolicy.endpoint,
    method: "POST",
    authorization: `Bearer ${grant.token}`,
    requestId: `provider-lifecycle-${number}`,
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({ model: "gpt-6-luna", input: "hello", max_output_tokens: 64 })
    ),
  }
}

describe("provider lifecycle race boundaries", () => {
  it("never dispatches after the grant expires during awaited broker authorization", async () => {
    const fixture = await setup()
    let clock = beforeExpiry
    const service = new ProviderGatewayService({ ...fixture.options, now: () => clock })
    const proxy = await input(service)
    fixture.authorizeGrant.mockImplementation(async () => {
      await Promise.resolve()
      clock = new Date(expiresAt)
      return fixture.policy
    })
    await expect(service.proxy(proxy)).rejects.toMatchObject({ code: "GRANT_EXPIRED" })
    expect(fixture.fetchImpl).not.toHaveBeenCalled()
    expect(await service.inspectRequest(proxy.requestId)).toBeNull()
  })

  it("rechecks expiration after a real signed journal has appended the dispatch intent", async () => {
    const fixture = await setup()
    let clock = beforeExpiry
    const delayedJournal: JournalPort<ProviderJournalEvent> = {
      load: () => fixture.journal.load(),
      append: async (event) => {
        const record = await fixture.journal.append(event)
        if (event.type === "request_started") clock = new Date(expiresAt)
        return record
      },
    }
    const service = new ProviderGatewayService({
      ...fixture.options,
      journal: delayedJournal,
      now: () => clock,
    })
    const proxy = await input(service)
    await expect(service.proxy(proxy)).rejects.toMatchObject({ code: "GRANT_EXPIRED" })
    expect(fixture.fetchImpl).not.toHaveBeenCalled()
    expect(await service.inspectRequest(proxy.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
  })

  it("never returns retained response bytes after expiration during replay authorization", async () => {
    const fixture = await setup()
    let clock = beforeExpiry
    const service = new ProviderGatewayService({ ...fixture.options, now: () => clock })
    const proxy = await input(service)
    await service.proxy(proxy)
    fixture.authorizeGrant.mockImplementation(async () => {
      await Promise.resolve()
      clock = new Date(expiresAt)
      return fixture.policy
    })
    await expect(service.proxy(proxy)).rejects.toMatchObject({ code: "GRANT_EXPIRED" })
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("does not return completed bytes if expiration crosses the result journal acknowledgement", async () => {
    const fixture = await setup()
    let clock = beforeExpiry
    const delayedJournal: JournalPort<ProviderJournalEvent> = {
      load: () => fixture.journal.load(),
      append: async (event) => {
        const record = await fixture.journal.append(event)
        if (event.type === "request_result") clock = new Date(expiresAt)
        return record
      },
    }
    const service = new ProviderGatewayService({
      ...fixture.options,
      journal: delayedJournal,
      now: () => clock,
    })
    const proxy = await input(service)
    await expect(service.proxy(proxy)).rejects.toMatchObject({ code: "GRANT_EXPIRED" })
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1)
    // Complete authentic terminal evidence exists even though response return
    // was denied. It is the only reason this physical slot can be released.
    expect(await service.inspectRequest(proxy.requestId)).toMatchObject({
      outcome: "SUCCEEDED",
      physicalOutstanding: false,
    })
  })

  it.each(["dispatch", "replay"])(
    "honors revocation queued during awaited %s authorization",
    async (mode) => {
      const fixture = await setup()
      const service = new ProviderGatewayService(fixture.options)
      const proxy = await input(service)
      if (mode === "replay") await service.proxy(proxy)
      let ready: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        ready = resolve
      })
      let authorize: () => void = () => undefined
      const authorized = new Promise<void>((resolve) => {
        authorize = resolve
      })
      fixture.authorizeGrant.mockImplementation(async () => {
        ready()
        await authorized
        return fixture.policy
      })
      const pending = service.proxy(proxy).catch((error: unknown) => error)
      await entered
      const grant = await service.findGrantByRequest(request.grantRequestId)
      if (!grant) throw new Error("fixture grant missing")
      const revoked = service.revokeGrant({
        grantId: grant.grantId,
        attemptId: request.attemptId,
        reason: "stop",
      })
      authorize()
      await revoked
      expect(await pending).toMatchObject({ code: "GRANT_REVOKED" })
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(mode === "replay" ? 1 : 0)
    }
  )
})

describe("durable physical provider concurrency holds", () => {
  it("holds an ignored-abort provider call against new request IDs and restart", async () => {
    const fixture = await setup(100)
    let completeProvider: (response: Response) => void = () => undefined
    const physicalCall = new Promise<Response>((resolve) => {
      completeProvider = resolve
    })
    const fetchImpl = vi.fn(() => physicalCall)
    const options = { ...fixture.options, fetchImpl }
    const service = new ProviderGatewayService(options)
    const proxy = await input(service)
    await expect(service.proxy(proxy)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    expect(await service.inspectRequest(proxy.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
    await expect(
      service.proxy({ ...proxy, requestId: "provider-lifecycle-after-timeout" })
    ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
    await fixture.journal.close()
    const replacementJournal = new SignedJournal(fixture.path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const replacement = new ProviderGatewayService({ ...options, journal: replacementJournal })
    await expect(
      replacement.proxy({ ...proxy, requestId: "provider-lifecycle-after-restart" })
    ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
    expect(await replacement.inspectRequest(proxy.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
    // A late network-promise resolution is not a parsed, retained and durable
    // terminal receipt. It must not silently discard the outstanding hold.
    completeProvider(terminalResponse())
    await physicalCall
    await expect(
      replacement.proxy({ ...proxy, requestId: "provider-lifecycle-after-late-resolution" })
    ).rejects.toMatchObject({ code: "PROVIDER_CONCURRENCY_EXHAUSTED" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await replacementJournal.close()
  })

  it("preserves the global hold cap across grants and restart", async () => {
    const fixture = await setup(100)
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined))
    const options = { ...fixture.options, fetchImpl }
    const service = new ProviderGatewayService(options)
    for (let number = 1; number <= 8; number++) {
      await expect(service.proxy(await input(service, number))).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
      })
    }
    const ninth = await input(service, 9)
    await expect(service.proxy(ninth)).rejects.toMatchObject({
      code: "PROVIDER_CONCURRENCY_EXHAUSTED",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(8)
    await fixture.journal.close()
    const replacementJournal = new SignedJournal(fixture.path, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const replacement = new ProviderGatewayService({ ...options, journal: replacementJournal })
    await expect(replacement.proxy(ninth)).rejects.toMatchObject({
      code: "PROVIDER_CONCURRENCY_EXHAUSTED",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(8)
    await replacementJournal.close()
  })

  it("releases a physical slot only after authentic terminal evidence is durably recorded", async () => {
    const fixture = await setup()
    let responseNumber = 0
    const fetchImpl = vi.fn(async () => terminalResponse(`response-lifecycle-${++responseNumber}`))
    const service = new ProviderGatewayService({ ...fixture.options, fetchImpl })
    const proxy = await input(service)
    await service.proxy(proxy)
    expect(await service.inspectRequest(proxy.requestId)).toMatchObject({
      outcome: "SUCCEEDED",
      physicalOutstanding: false,
    })
    await service.proxy({ ...proxy, requestId: "provider-lifecycle-after-terminal" })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
