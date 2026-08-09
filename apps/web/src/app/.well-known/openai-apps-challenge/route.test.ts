import { afterEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"

describe("GET /.well-known/openai-apps-challenge", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("returns the public OpenAI domain-verification token as plain text", async () => {
    vi.stubEnv("OPENAI_APPS_DOMAIN_VERIFICATION_TOKEN", "openai-domain-verification-token")
    const response = GET()
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await response.text()).toBe("openai-domain-verification-token")
  })

  it("returns 404 while no domain token is configured", () => {
    expect(GET().status).toBe(404)
  })
})
