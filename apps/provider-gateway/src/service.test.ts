import { fixtureActionIntentPublisher, fixtureAuthorityFence } from "./test-fixtures"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SignedJournal,
  type JournalPort,
  type ProviderGrantRequest,
  type ScanAuthorityFence,
} from "@lyrashield/runtime-control"
import type { ProviderRoute } from "./config"
import { fixturePolicy } from "./test-fixtures"
import {
  ProviderGatewayService,
  providerJournalEventSchema,
  type ProviderJournalEvent,
  type ProviderGatewayServiceOptions,
} from "./service"

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
  journalPort?: JournalPort<ProviderJournalEvent>,
  fetchImpl: typeof fetch = vi.fn(
    async () =>
      new Response(providerBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  ),
  admission: "closed" | "open" = "open",
  authorityFence: ScanAuthorityFence | null = fixtureAuthorityFence,
  publishActionIntent:
    ProviderGatewayServiceOptions["publishActionIntent"] | null = fixtureActionIntentPublisher
) {
  const activeJournal = journalPort ?? (await journal())
  return new ProviderGatewayService({
    journal: activeJournal,
    authorityFence: authorityFence ?? undefined,
    publishActionIntent: publishActionIntent ?? undefined,
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
  it("dispatches the approved snapshot when caller input changes during intent publication", async () => {
    const body = Buffer.from(inputBody)
    const fetchImpl = vi.fn(async (_target: unknown, init: RequestInit | undefined) => {
      expect(init?.method).toBe("POST")
      expect(Buffer.from(init?.body as Uint8Array)).toEqual(inputBody)
      return new Response(providerBody(), { headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    let input: Parameters<ProviderGatewayService["proxy"]>[0]
    const publishActionIntent: NonNullable<
      ProviderGatewayServiceOptions["publishActionIntent"]
    > = async (intent) => {
      expect(intent.actionInput).toMatchObject({ method: "POST" })
      body.fill(0)
      input.method = "DELETE"
      input.path = "/unapproved"
      return fixtureActionIntentPublisher(intent)
    }
    const service = await createService(
      undefined,
      fetchImpl,
      "open",
      fixtureAuthorityFence,
      publishActionIntent
    )
    const grant = await service.issueGrant(request())
    input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "post",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-snapshot",
      contentType: "application/json",
      body,
    }
    await expect(service.proxy(input)).resolves.toMatchObject({ statusCode: 200 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(["missing", "unknown", "wrong-request", "lost-ack"] as const)(
    "does not dispatch an unconfirmed durable intent: %s",
    async (failure) => {
      const fetchImpl = vi.fn(async () => new Response(providerBody()))
      const publisher: ProviderGatewayServiceOptions["publishActionIntent"] = async ({
        binding,
      }) => {
        if (failure === "lost-ack") throw new Error("database acknowledgement lost")
        return failure === "unknown"
          ? { kind: "unknown", requestId: binding.requestId!, reasonCode: "COMMIT_OUTCOME_UNKNOWN" }
          : { kind: "committed", requestId: "another-request", actionId: "original-intent" }
      }
      const service = await createService(
        undefined,
        fetchImpl,
        "open",
        fixtureAuthorityFence,
        failure === "missing" ? null : publisher
      )
      const grant = await service.issueGrant(request())
      const input = {
        providerId: "azure-ai",
        path: fixturePolicy.endpoint,
        method: "POST",
        authorization: `Bearer ${grant.token}`,
        requestId: "provider-original-intent",
        contentType: "application/json",
        body: inputBody,
      }
      await expect(service.proxy(input)).rejects.toThrow()
      expect(await service.inspectRequest(input.requestId)).toMatchObject({
        outcome: failure === "missing" ? "NEVER_DISPATCHED" : "UNKNOWN",
        physicalOutstanding: failure !== "missing",
      })
      await expect(service.proxy(input)).rejects.toThrow()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it("publishes the exact grant and dispatch descriptor before invoking the native fence", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async () => {
      calls.push("fetch")
      return new Response(providerBody(), { headers: { "content-type": "application/json" } })
    })
    let retained: Parameters<NonNullable<ProviderGatewayServiceOptions["publishActionIntent"]>>[0]
    const publishActionIntent: NonNullable<
      ProviderGatewayServiceOptions["publishActionIntent"]
    > = async (input) => {
      calls.push("publish")
      retained = input
      expect(input.authorityInput).toEqual({ request: request(), policy: fixturePolicy })
      expect(input.actionInput).toMatchObject({
        requestId: "provider-durable-intent",
        providerId: "azure-ai",
        path: "/openai/responses",
        query: "?api-version=1",
        method: "POST",
        contentType: "application/json",
        accept: "application/json",
      })
      expect(JSON.stringify(input)).not.toContain("real-provider-secret")
      return { kind: "committed", requestId: input.binding.requestId!, actionId: "original-intent" }
    }
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, effect) => {
        calls.push("fence")
        expect(binding).toEqual(retained.binding)
        return effect(() => undefined, { guardId: `fixture-${binding.requestId}` })
      },
    }
    const service = await createService(
      undefined,
      fetchImpl,
      "open",
      authorityFence,
      publishActionIntent
    )
    const grant = await service.issueGrant(request())
    await service.proxy({
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-durable-intent",
      contentType: "application/json",
      body: inputBody,
    })
    expect(calls).toEqual(["publish", "fence", "fetch"])
  })

  it.each(["missing", "revoked"] as const)(
    "releases the unused reservation when native dispatch authority is %s",
    async (failure) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(providerBody(), { headers: { "content-type": "application/json" } })
      )
      let checks = 0
      const authorityFence: ScanAuthorityFence = {
        run: async (binding) => {
          checks++
          expect(binding).toMatchObject({
            phase: "PROVIDER_DISPATCH",
            attemptId: "attempt-1",
            scanId: "scan-1",
            workspaceId: "workspace-1",
            requestId: "provider-fenced",
          })
          expect(binding.authorityChecksum).toMatch(/^[a-f0-9]{64}$/)
          expect(binding.actionChecksum).toMatch(/^[a-f0-9]{64}$/)
          throw new Error("membership revoked")
        },
      }
      const service = await createService(
        undefined,
        fetchImpl,
        "open",
        failure === "missing" ? null : authorityFence
      )
      const grant = await service.issueGrant(request())
      const input = {
        providerId: "azure-ai",
        path: fixturePolicy.endpoint,
        method: "POST",
        authorization: `Bearer ${grant.token}`,
        requestId: "provider-fenced",
        contentType: "application/json",
        body: inputBody,
      }
      await expect(service.proxy(input)).rejects.toThrow()
      expect(await service.inspectRequest(input.requestId)).toMatchObject({
        outcome: "NEVER_DISPATCHED",
        physicalOutstanding: false,
      })
      expect(await service.inspectGrant(grant.grantId)).toMatchObject({
        requestCount: 0,
        reservedCostMicros: 0,
      })
      await expect(service.proxy(input)).rejects.toMatchObject({ code: "REQUEST_NOT_DISPATCHED" })
      expect(checks).toBe(failure === "missing" ? 0 : 1)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it("holds the reservation if the fence fails after provider invocation", async () => {
    const fetchImpl = vi.fn(async () => new Response(providerBody()))
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, work) => {
        await work(() => undefined, { guardId: `fixture-${binding.requestId}` })
        throw new Error("lost fence acknowledgement")
      },
    }
    const service = await createService(undefined, fetchImpl, "open", authorityFence)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-fence-ack-lost",
      contentType: "application/json",
      body: inputBody,
    }
    await expect(service.proxy(input)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await service.inspectRequest(input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
    expect(await service.inspectGrant(grant.grantId)).toMatchObject({
      requestCount: 1,
      reservedCostMicros: (await service.inspectRequest(input.requestId))?.reservationMicros,
    })
  })

  it("preserves an earlier provider reservation when a later dispatch is denied", async () => {
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, work) => {
        if (binding.requestId === "provider-denied") throw new Error("authority revoked")
        return work(() => undefined, { guardId: `fixture-${binding.requestId}` })
      },
    }
    const service = await createService(undefined, undefined, "open", authorityFence)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-first",
      contentType: "application/json",
      body: inputBody,
    }
    await service.proxy(input)
    const previous = await service.inspectGrant(grant.grantId)
    await expect(service.proxy({ ...input, requestId: "provider-denied" })).rejects.toThrow()
    expect(await service.inspectGrant(grant.grantId)).toMatchObject({
      requestCount: previous?.requestCount,
      reservedCostMicros: previous?.reservedCostMicros,
    })
  })

  it("prevents a delayed fence callback from dispatching after the reservation is released", async () => {
    const fetchImpl = vi.fn(async () => new Response(providerBody()))
    let lateDispatch: (() => Promise<unknown>) | undefined
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, work) => {
        lateDispatch = async () =>
          work(() => undefined, { guardId: `fixture-${binding.requestId}` })
        throw new Error("fence timed out")
      },
    }
    const service = await createService(undefined, fetchImpl, "open", authorityFence)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-late-fence",
      contentType: "application/json",
      body: inputBody,
    }
    await expect(service.proxy(input)).rejects.toThrow()
    expect(lateDispatch).toBeDefined()
    await expect(lateDispatch?.()).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await service.inspectRequest(input.requestId)).toMatchObject({
      outcome: "NEVER_DISPATCHED",
      physicalOutstanding: false,
    })
  })

  it("does not dispatch twice if a fence invokes the callback twice", async () => {
    const fetchImpl = vi.fn(async () => new Response(providerBody()))
    const authorityFence: ScanAuthorityFence = {
      run: async (binding, work) => {
        await work(() => undefined, { guardId: `fixture-${binding.requestId}` })
        return work(() => undefined, { guardId: `fixture-${binding.requestId}` })
      },
    }
    const service = await createService(undefined, fetchImpl, "open", authorityFence)
    const grant = await service.issueGrant(request())
    const input = {
      providerId: "azure-ai",
      path: fixturePolicy.endpoint,
      method: "POST",
      authorization: `Bearer ${grant.token}`,
      requestId: "provider-double-fence",
      contentType: "application/json",
      body: inputBody,
    }
    await expect(service.proxy(input)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await service.inspectRequest(input.requestId)).toMatchObject({
      outcome: "UNKNOWN",
      physicalOutstanding: true,
    })
  })

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
