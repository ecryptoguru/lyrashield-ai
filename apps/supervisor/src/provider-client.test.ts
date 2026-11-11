import { describe, expect, it, vi } from "vitest"
import type { ProviderGrantRequest } from "@lyrashield/runtime-control"
import { ProviderGatewayClient } from "./provider-client"

const expiresAt = "2026-11-05T11:00:00.000Z"

function grantRequest(): ProviderGrantRequest {
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
    maxRequests: 2,
    costReservationMicros: 100,
    maxReservedCostMicros: 1_000,
  }
}

describe("ProviderGatewayClient endpoint policy", () => {
  it("refuses to send the bearer token to a remote cleartext endpoint", () => {
    expect(
      () => new ProviderGatewayClient("http://provider-gateway.internal:8791", "t".repeat(48))
    ).toThrow(/HTTPS/)
    expect(() => new ProviderGatewayClient("ftp://127.0.0.1:8791", "t".repeat(48))).toThrow(/HTTPS/)
    expect(
      () => new ProviderGatewayClient("https://provider-gateway.internal:8791", "t".repeat(48))
    ).not.toThrow()
    expect(() => new ProviderGatewayClient("http://127.0.0.1:8791", "t".repeat(48))).not.toThrow()
    expect(() => new ProviderGatewayClient("http://localhost:8791", "t".repeat(48))).not.toThrow()
  })

  it("sends the bearer token only after the endpoint policy passes", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(48)}`)
      return new Response(
        JSON.stringify({
          grantId: "pg_grant",
          token: "g".repeat(64),
          attemptId: "attempt-1",
          providerId: "azure-ai",
          expiresAt,
          receipt: "1".repeat(64),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    })
    const client = new ProviderGatewayClient(
      "https://gateway.example.test",
      "t".repeat(48),
      fetchImpl
    )
    await expect(client.issueGrant(grantRequest())).resolves.toMatchObject({
      grantId: "pg_grant",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("streams and rejects an oversized gateway response before buffering it", async () => {
    const chunk = Buffer.alloc(64 * 1024, 1)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 128; index += 1) controller.enqueue(chunk)
        controller.close()
      },
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }))
    const client = new ProviderGatewayClient(
      "https://gateway.example.test",
      "t".repeat(48),
      fetchImpl
    )
    await expect(client.issueGrant(grantRequest())).rejects.toThrow(/oversized/)
  })
})
