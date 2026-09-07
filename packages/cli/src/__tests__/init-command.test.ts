import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { handleInit } from "../commands/init.js"
import type { Output } from "../output.js"

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  install: vi.fn(),
  agents: [] as AgentEntry[],
}))

vi.mock("../credentials.js", () => ({ getEffectiveCredentials: mocks.credentials }))
vi.mock("../installers/install.js", () => ({ installAgent: mocks.install }))
vi.mock("@lyrashield/agent-registry", () => ({
  listAgents: () => mocks.agents,
  listPreferredAgents: () => mocks.agents,
  getPreferredAgent: (id: string) => mocks.agents.find((agent) => agent.id === id),
  AGENTS: mocks.agents,
}))

function fakeAgent(id: string, transports: AgentEntry["transports"]): AgentEntry {
  return {
    id,
    displayName: id,
    docsSlug: id,
    installStrategy: "guided-manual",
    format: null,
    rootKey: null,
    locations: [],
    transports,
    credential: { kind: "ui-fields" },
    rulesFiles: [],
    gotchas: [],
  }
}

const output = {
  error: vi.fn(),
  log: vi.fn(),
  notice: vi.fn(),
  warn: vi.fn(),
  result: vi.fn(),
  json: true,
  quiet: false,
} as unknown as Output

beforeEach(() => {
  vi.clearAllMocks()
  mocks.agents = [fakeAgent("hosted-plugin", ["remote-http"]), fakeAgent("local-client", ["stdio"])]
  mocks.credentials.mockResolvedValue({
    apiUrl: "https://app.lyrashieldai.com",
    apiKey: "lsk_testkey123",
    credentialKind: "api-key",
  })
  mocks.install.mockImplementation(({ agent }: { agent: AgentEntry }) =>
    Promise.resolve({ agent: agent.id, displayName: agent.displayName, outcome: "CONFIGURED" })
  )
})

describe("init transport selection", () => {
  it("uses each agent's preferred transport when --transport is omitted", async () => {
    expect(await handleInit(["--all", "--dry-run", "--yes"], output)).toBe(0)
    expect(mocks.install).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ transport: "remote-http", dryRun: true })
    )
    expect(mocks.install).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ transport: "stdio", dryRun: true })
    )
  })

  it("keeps an explicit transport for installer validation", async () => {
    await handleInit(["--all", "--transport", "stdio"], output)
    expect(mocks.install).toHaveBeenCalledTimes(2)
    for (const [options] of mocks.install.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ transport: "stdio" }))
    }
  })
})
