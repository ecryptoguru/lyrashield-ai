import { applyProviderJournalRecord, type ProviderJournalState } from "./journal-state"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import {
  SignedJournal,
  type JournalPort,
  type ScanAuthorityFence,
} from "@lyrashield/runtime-control"
import {
  ProviderGatewayService,
  providerJournalEventSchema,
  type ProviderJournalEvent,
  type ProviderGatewayServiceOptions,
} from "./service"
import { fixtureActionIntentPublisher, fixtureAuthorityFence, fixturePolicy } from "./test-fixtures"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(fence: ScanAuthorityFence = fixtureAuthorityFence, loseAck = false) {
  const root = await mkdtemp(join(tmpdir(), "provider-native-ack-"))
  roots.push(root)
  const journal = new SignedJournal(join(root, "journal.jsonl"), "s".repeat(48), (value) =>
    providerJournalEventSchema.parse(value)
  )
  const port: JournalPort<ProviderJournalEvent> = {
    load: () => journal.load(),
    append: async (event) => {
      const record = await journal.append(event)
      if (loseAck && event.type === "request_transport_ack") throw new Error("lost journal ACK")
      return record
    },
  }
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "response-1",
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
  )
  const options: ProviderGatewayServiceOptions = {
    journal: port,
    signingSecret: "s".repeat(48),
    responseEncryptionSecret: "e".repeat(48),
    authorityFence: fence,
    publishActionIntent: fixtureActionIntentPublisher,
    authorizeGrant: async () => fixturePolicy,
    admission: "open",
    providers: new Map([
      [
        "azure-ai",
        {
          id: "azure-ai",
          baseUrl: "https://provider.example.test/openai",
          auth: { kind: "api-key", credential: "synthetic-secret", headerName: "api-key" },
          allowedPathPrefixes: ["/openai/"],
          requestPolicy: fixturePolicy,
        },
      ],
    ]),
    fetchImpl,
    now: () => new Date("2026-11-05T10:00:00Z"),
  }
  const service = new ProviderGatewayService(options)
  const grant = await service.issueGrant({
    grantRequestId: "grant-request-1",
    attemptId: "attempt-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    operationId: "operation-1",
    authorityEpochId: "epoch-1",
    authorityRevision: 1,
    expiresAt: "2026-11-05T11:00:00Z",
    providerId: "azure-ai",
    maxRequests: 2,
    costReservationMicros: 100,
    maxReservedCostMicros: 1000,
  })
  const input = {
    providerId: "azure-ai",
    path: fixturePolicy.endpoint,
    method: "POST",
    authorization: `Bearer ${grant.token}`,
    requestId: "request-1",
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({ model: "gpt-6-luna", input: "hello", max_output_tokens: 64 })
    ),
  }
  return { service, journal, fetchImpl, input, grant, options }
}

it("retains the actual original guard and HTTP acknowledgement as separate signed records", async () => {
  const f = await fixture()
  await f.service.proxy(f.input)
  const records = await f.journal.load()
  const bound = records.find((record) => record.payload.type === "request_invocation_bound")!
  const ack = records.find((record) => record.payload.type === "request_transport_ack")!
  expect(bound.sequence).toBeLessThan(ack.sequence)
  expect(bound.payload).toMatchObject({
    type: "request_invocation_bound",
    invocation: {
      guardId: "fixture-request-1",
      binding: { requestId: "request-1", phase: "PROVIDER_DISPATCH" },
    },
  })
  expect(ack.payload).toMatchObject({
    type: "request_transport_ack",
    ack: { requestId: "request-1", guardId: "fixture-request-1", statusCode: 200 },
  })
  expect(f.fetchImpl).toHaveBeenCalledTimes(1)
})

it("never invokes upstream without the durable invocation guard", async () => {
  const f = await fixture({ run: async (_binding, effect) => effect(() => undefined) })
  await expect(f.service.proxy(f.input)).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" })
  expect(f.fetchImpl).not.toHaveBeenCalled()
  expect(
    (await f.journal.load()).some((record) => record.payload.type === "request_invocation_bound")
  ).toBe(false)
})

it("keeps lost HTTP acknowledgement held and cannot retry paid work after restart", async () => {
  const f = await fixture(fixtureAuthorityFence, true)
  await expect(f.service.proxy(f.input)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
  await expect(f.service.proxy(f.input)).rejects.toMatchObject({ code: "ADMISSION_CLOSED" })
  const original = (await f.journal.load()).find(
    (record) => record.payload.type === "request_started"
  )!
  if (original.payload.type !== "request_started") throw new Error("Original request is missing")
  const restarted = new ProviderGatewayService({ ...f.options, journal: f.journal })
  await expect(restarted.proxy(f.input)).rejects.toMatchObject({ code: "REQUEST_UNKNOWN" })
  expect(await restarted.inspectRequest(f.input.requestId)).toMatchObject({
    outcome: "UNKNOWN",
    physicalOutstanding: true,
    reservationMicros: original.payload.request.reservationMicros,
  })
  expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  const records = await f.journal.load()
  expect(records.some((record) => record.payload.type === "request_transport_ack")).toBe(true)
  expect(
    records
      .slice()
      .reverse()
      .find((record) => record.payload.type === "request_result")?.payload
  ).toMatchObject({ type: "request_result", result: { outcome: "UNKNOWN" } })
})

it("rejects a foreign guard acknowledgement and keeps late acknowledgement financially held", async () => {
  const f = await fixture()
  await f.service.proxy(f.input)
  const records = await f.journal.load()
  const state: ProviderJournalState = {
    grants: new Map(),
    grantsByRequest: new Map(),
    requests: new Map(),
  }
  for (const record of records) {
    if (record.payload.type === "request_transport_ack") {
      const forged = {
        ...record,
        payload: { ...record.payload, ack: { ...record.payload.ack, guardId: "foreign-guard" } },
      }
      expect(() => applyProviderJournalRecord(state, "s".repeat(48), forged)).toThrow(
        /original invocation/
      )
      const request = state.requests.get(f.input.requestId)!
      const held = state.grants.get(f.grant.grantId)!.reservedCostMicros
      request.outcome = "UNKNOWN"
      applyProviderJournalRecord(state, "s".repeat(48), record)
      expect(request.transportAck?.guardId).toBe("fixture-request-1")
      expect(request.outcome).toBe("UNKNOWN")
      expect(request.physicalOutstanding).toBe(true)
      expect(state.grants.get(f.grant.grantId)?.reservedCostMicros).toBe(held)
      return
    }
    applyProviderJournalRecord(state, "s".repeat(48), record)
  }
  throw new Error("Actual gateway acknowledgement was missing")
})
