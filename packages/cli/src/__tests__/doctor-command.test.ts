import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleDoctor } from "../commands/doctor.js"
import type { Output } from "../output.js"

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  request: vi.fn(),
}))

vi.mock("../credentials.js", () => ({ getEffectiveCredentials: mocks.credentials }))
vi.mock("../client.js", () => ({
  createClient: vi.fn(async () => ({ request: mocks.request })),
}))
vi.mock("@lyrashield/agent-registry", () => ({ AGENTS: [], listAgents: () => [] }))
vi.mock("../installers/detect.js", () => ({
  detectAgent: vi.fn(),
  findDetectedLocations: vi.fn(),
}))

const output = {
  error: vi.fn(),
  log: vi.fn(),
  notice: vi.fn(),
  result: vi.fn(),
  warn: vi.fn(),
  json: true,
} as unknown as Output

beforeEach(() => {
  vi.clearAllMocks()
  mocks.request.mockResolvedValue([])
})

describe("doctor credential diagnostics", () => {
  it("labels OAuth without presenting its bearer token as an API key", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "oauth-bearer-token",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "oauth",
      source: "file",
    })

    expect(await handleDoctor([], output)).toBe(0)
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: "OAuth access token",
        credentialKind: "oauth",
        credentialSource: "file",
        apiKey: "not set",
      })
    )
  })

  it("keeps API keys redacted", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "lsk_testkey123",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "api-key",
      source: "environment",
    })

    expect(await handleDoctor([], output)).toBe(0)
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: "lsk_y123",
        credentialKind: "api-key",
        apiKey: "lsk_y123",
      })
    )
  })
})
