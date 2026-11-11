import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SignedJournal } from "@lyrashield/runtime-control"
import { createProviderGatewayHandler } from "./http"
import { ProviderGatewayService, providerJournalEventSchema } from "./service"

const roots: string[] = []
const secret = "g".repeat(48)
const control = "c".repeat(48)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("provider gateway HTTP boundary", () => {
  it("drains an active HTTP proxy, records UNKNOWN, and hands over its journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-http-drain-"))
    roots.push(root)
    const journalPath = join(root, "journal.jsonl")
    const journal = new SignedJournal(journalPath, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    let notifyStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const service = new ProviderGatewayService({
      journal,
      signingSecret: secret,
      admission: "open",
      now: () => new Date("2026-11-05T10:00:00.000Z"),
      providers: new Map([
        [
          "azure-ai",
          {
            id: "azure-ai",
            baseUrl: "https://provider.example.test/openai",
            auth: { kind: "api-key", credential: "fixture-secret", headerName: "api-key" },
            allowedPathPrefixes: ["/openai/"],
          },
        ],
      ]),
      fetchImpl: () => {
        notifyStarted()
        return new Promise<Response>(() => undefined)
      },
    })
    const grant = await service.issueGrant({
      grantRequestId: "grant-http-drain",
      attemptId: "attempt-http",
      scanId: "scan-http",
      workspaceId: "workspace-http",
      operationId: "operation-http",
      authorityEpochId: "epoch-http",
      authorityRevision: 1,
      expiresAt: "2026-11-05T11:00:00.000Z",
      providerId: "azure-ai",
      maxRequests: 1,
      costReservationMicros: 100,
      maxReservedCostMicros: 1000,
    })
    const server = createServer(
      createProviderGatewayHandler(service, { controlToken: control, admission: "open" })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/provider/azure-ai/openai/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token}`,
          "x-lyra-request-id": "provider-http-active",
        },
        body: "{}",
      }
    )
    await started
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await Promise.all([closed, service.drain()])
    expect((await request).status).toBe(502)
    const beforeHandover = await journal.load()
    expect(
      beforeHandover.find((record) => record.payload.type === "request_result")?.payload
    ).toMatchObject({ result: { requestId: "provider-http-active", outcome: "UNKNOWN" } })
    await journal.close()
    const replacement = new SignedJournal(journalPath, secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    expect(await replacement.load()).toEqual(beforeHandover)
    await replacement.close()
  })

  it("requires control authentication and rejects grant issuance while admission is closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-http-test-"))
    roots.push(root)
    const journal = new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
      providerJournalEventSchema.parse(value)
    )
    const service = new ProviderGatewayService({
      journal,
      signingSecret: secret,
      admission: "closed",
      providers: new Map(),
    })
    const server = createServer(
      createProviderGatewayHandler(service, { controlToken: control, admission: "closed" })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const base = `http://127.0.0.1:${address.port}`
    try {
      const health = await fetch(`${base}/healthz`)
      expect(await health.json()).toEqual({ status: "ok", admission: "closed" })
      const unauthorized = await fetch(`${base}/v1/grants`, { method: "POST", body: "{}" })
      expect(unauthorized.status).toBe(401)
      const closed = await fetch(`${base}/v1/grants`, {
        method: "POST",
        headers: { authorization: `Bearer ${control}`, "content-type": "application/json" },
        body: JSON.stringify({
          grantRequestId: "grant-http",
          attemptId: "attempt-http",
          scanId: "scan-http",
          workspaceId: "workspace-http",
          operationId: "operation-http",
          authorityEpochId: "epoch-http",
          authorityRevision: 1,
          expiresAt: "2026-11-05T11:00:00.000Z",
          providerId: "azure-ai",
          maxRequests: 1,
          costReservationMicros: 0,
          maxReservedCostMicros: 0,
        }),
      })
      expect(closed.status).toBe(403)
      expect(await closed.json()).toMatchObject({ code: "ADMISSION_CLOSED" })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
