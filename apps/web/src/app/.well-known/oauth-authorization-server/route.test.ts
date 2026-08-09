import { describe, expect, it, vi } from "vitest"

const { metadataHandler } = vi.hoisted(() => ({
  metadataHandler: vi.fn(() => new Response('{"issuer":"https://app.lyrashieldai.com"}')),
}))

vi.mock("@better-auth/oauth-provider", () => ({
  oauthProviderAuthServerMetadata: vi.fn(() => metadataHandler),
}))

vi.mock("@lyrashield/auth/server", () => ({ auth: {} }))

import { GET } from "./route"

describe("GET /.well-known/oauth-authorization-server", () => {
  it("serves the Better Auth authorization-server metadata handler", async () => {
    const response = await GET()

    expect(metadataHandler).toHaveBeenCalledOnce()
    expect(response.status).toBe(200)
  })
})
