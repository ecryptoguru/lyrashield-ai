import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SignedJournal, type ProviderGrantRequest } from "@lyrashield/runtime-control"
import type { ProviderRoute } from "./config"
import { fixturePolicy } from "./test-fixtures"
import { ProviderGatewayService, providerJournalEventSchema } from "./service"

const roots: string[] = []
const secret = "p".repeat(48)
const expiresAt = "2026-11-05T11:00:00.000Z"
const now = new Date("2026-11-05T10:00:00.000Z")

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function journal() {
  const root = await mkdtemp(join(tmpdir(), "provider-gateway-test-"))
  roots.push(root)
  return new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
    providerJournalEventSchema.parse(value)
  )
}

function request(maxRequests = 2): ProviderGrantRequest {
  return {
    grantRequestId: "grant-request-1",
    attemptId: "attempt-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    operationId: "operation-1",
    authorityEpochId: "epoch-1",
    authorityRevision: 1,
    expiresAt,
    providerId: "azure-ai",
    maxRequests,
    costReservationMicros: 100,
    maxReservedCostMicros: 1_000,
  }
}

function providerBody(id = "response-1") {
  return JSON.stringify({
    id,
    model: "gpt-6-luna",
    status: "completed",
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
    },
  })
}
const inputBody = Buffer.from(
  JSON.stringify({ model: "gpt-6-luna", input: "hello", max_output_tokens: 64 })
)
const route: ProviderRoute = {
  id: "azure-ai",
  baseUrl: "https://provider.example.test/openai",
  auth: { kind: "api-key", credential: "real-provider-secret", headerName: "api-key" },
  allowedPathPrefixes: ["/openai/"],
  requestPolicy: fixturePolicy,
}

async function createService(
  journalPort?: Awaited<ReturnType<typeof journal>>,
  fetchImpl: typeof fetch = vi.fn(
    async () =>
      new Response(providerBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  ),
  admission: "closed" | "open" = "open"
) {
  const activeJournal = journalPort ?? (await journal())
  return new ProviderGatewayService({
    journal: activeJournal,
    signingSecret: secret,
    responseEncryptionSecret: "e".repeat(48),
    authorizeGrant: async () => fixturePolicy,
    admission,
    providers: new Map([[route.id, route]]),
    fetchImpl,
    now: () => now,
  })
}

describe("ProviderGatewayService", () => {
  it("revokes and aborts an in-flight request without waiting for the provider", async () => {
    let observedSignal: AbortSignal | undefined
    let notifyStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined
      notifyStarted()
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        })
      })
    })
    const storedJournal = await journal()
    const service = await createService(storedJournal, fetchImpl)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-in-flight",
      contentType: "application/json",
      body: inputBody,
    }
    const pending = service.proxy(input)
    const pendingResult = pending.catch((error: unknown) => error)
    await started
    const revocation = service.revokeGrant({
      grantId: grant.grantId,
      attemptId: "attempt-1",
      reason: "stop",
    })
    const result = await Promise.race([
      revocation,
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ])
    expect(result).not.toBe("timed-out")
    expect(observedSignal?.aborted).toBe(true)
    expect((await service.inspectGrant(grant.grantId))?.revokedAt).toBe(now.toISOString())
    expect(await pendingResult).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    await expect(service.proxy({ ...input, requestId: "provider-after-stop" })).rejects.toThrow(
      /revoked/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const events = await storedJournal.load()
    expect(events.find((event) => event.payload.type === "request_result")?.payload).toMatchObject({
      result: { requestId: input.requestId, outcome: "UNKNOWN" },
    })
  })

  it("records an unknown outcome even if an upstream ignores local abort", async () => {
    let notifyStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const fetchImpl = vi.fn(() => {
      notifyStarted()
      return new Promise<Response>(() => undefined)
    })
    const storedJournal = await journal()
    const service = await createService(storedJournal, fetchImpl)
    const grant = await service.issueGrant(request())
    const pending = service
      .proxy({
        providerId: "azure-ai",
        path: fixturePolicy.endpoint,
        method: "POST",
        authorization: `Bearer ${grant.token}`,
        requestId: "provider-ignores-abort",
        contentType: "application/json",
        body: inputBody,
      })
      .catch((error: unknown) => error)
    await started
    await service.revokeGrant({ grantId: grant.grantId, attemptId: "attempt-1", reason: "stop" })
    expect(await pending).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    expect(
      (await storedJournal.load()).find((event) => event.payload.type === "request_result")?.payload
    ).toMatchObject({ result: { requestId: "provider-ignores-abort", outcome: "UNKNOWN" } })
  })

  it("serializes concurrent reservations without waiting for upstream responses", async () => {
    let notifyStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const fetchImpl = vi.fn(() => {
      notifyStarted()
      return new Promise<Response>(() => undefined)
    })
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request(1))
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-first-reservation",
      contentType: "application/json",
      body: inputBody,
    }
    const pending = service.proxy(input).catch((error: unknown) => error)
    await started
    await expect(
      service.proxy({ ...input, requestId: "provider-second-reservation" })
    ).rejects.toMatchObject({ code: "GRANT_REQUEST_BUDGET_EXHAUSTED" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await service.revokeGrant({ grantId: grant.grantId, attemptId: "attempt-1", reason: "stop" })
    expect(await pending).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
  })

  it("issues an attempt-bound grant and injects the provider credential only at the gateway", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("api-key")).toBe("real-provider-secret")
      expect(new Headers(init?.headers).get("authorization")).toBeNull()
      return new Response(providerBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request())
    expect(grant.attemptId).toBe("attempt-1")
    expect(grant.token).not.toContain("real-provider-secret")
    const response = await service.proxy({
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-request-1",
      contentType: "application/json",
      body: inputBody,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers["x-lyra-usage-id"]).toMatch(/^usage_/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("returns the immutable request identity on replay without a second provider request", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(providerBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-request-reused",
      contentType: "application/json",
      body: inputBody,
    }
    const original = await service.proxy(input)
    const replayed = await service.proxy(input)
    expect(replayed.body).toEqual(original.body)
    expect(replayed.headers["x-lyra-usage-id"]).toBe(original.headers["x-lyra-usage-id"])
    expect(replayed.replayed).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(
      service.proxy({ ...input, body: Buffer.from('{"input":"different"}') })
    ).rejects.toThrow(/different input/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("enforces the request budget and records no second upstream request", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(providerBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request(1))
    await service.proxy({
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-budget-1",
      contentType: "application/json",
      body: inputBody,
    })
    await expect(
      service.proxy({
        providerId: "azure-ai",
        path: fixturePolicy.endpoint,
        method: "POST",
        authorization: `Bearer ${grant.token}`,
        requestId: "provider-budget-2",
        contentType: "application/json",
        body: inputBody,
      })
    ).rejects.toThrow(/budget is exhausted/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("rejects expired, revoked and foreign-path grants", async () => {
    const service = await createService()
    const grant = await service.issueGrant(request())
    await service.revokeGrant({ grantId: grant.grantId, attemptId: "attempt-1", reason: "stop" })
    await expect(
      service.proxy({
        providerId: "azure-ai",
        path: fixturePolicy.endpoint,
        method: "POST",
        authorization: `Bearer ${grant.token}`,
        requestId: "provider-revoked",
        contentType: "application/json",
        body: inputBody,
      })
    ).rejects.toThrow(/revoked/)
    const second = await service.issueGrant({ ...request(), grantRequestId: "grant-request-2" })
    await expect(
      service.proxy({
        providerId: "azure-ai",
        path: "/different/responses",
        method: "POST",
        authorization: `Bearer ${second.token}`,
        requestId: "provider-path",
        contentType: "application/json",
        body: inputBody,
      })
    ).rejects.toThrow(/allowlisted/)
  })

  it("fails closed when runtime admission is closed", async () => {
    const service = await createService(await journal(), undefined, "closed")
    await expect(service.issueGrant(request())).rejects.toThrow(/admission is closed/)
  })

  it("records provider unavailability as UNKNOWN and never retries automatically", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unavailable")
    })
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-unknown",
      contentType: "application/json",
      body: inputBody,
    }
    await expect(service.proxy(input)).rejects.toThrow(/unknown/)
    await expect(service.proxy(input)).rejects.toThrow(/cannot be replayed/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("replays an exact canonical path+query and rejects silent query drift", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(providerBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request())
    const queried = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-request-query",
      contentType: "application/json",
      body: inputBody,
    }
    await service.proxy(queried)
    const replayed = await service.proxy(queried)
    expect(replayed.replayed).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(
      service.proxy({ ...queried, path: "/openai/responses?api-version=2&flag=a" })
    ).rejects.toThrow(/different input/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("binds forwarded content negotiation headers into the request identity", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(providerBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const service = await createService(await journal(), fetchImpl)
    const grant = await service.issueGrant(request())
    const negotiated = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-request-typed",
      contentType: "application/json",
      accept: "application/json",
      body: inputBody,
    }
    await service.proxy(negotiated)
    // Case/whitespace-equivalent headers still match the recorded identity.
    await expect(
      service.proxy({
        ...negotiated,
        contentType: "Application/JSON",
        accept: " application/json ",
      })
    ).resolves.toMatchObject({ replayed: true })
    // A genuinely different content type or accept is a different request.
    await expect(
      service.proxy({ ...negotiated, contentType: "multipart/form-data" })
    ).rejects.toThrow(/different input/)
    await expect(service.proxy({ ...negotiated, accept: "text/event-stream" })).rejects.toThrow(
      /different input/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
