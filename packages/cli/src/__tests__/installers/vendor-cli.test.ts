import { beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { installAgent } from "../../installers/install.js"

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const API_URL = "https://app.lyrashieldai.com"
const API_KEY = "lsk_testkey123"

function fakeVendorAgent(command: string): AgentEntry {
  return {
    id: `vendor-${command}`,
    displayName: `Vendor ${command}`,
    installStrategy: "vendor-cli",
    vendorCli: { command, args: ["mcp", "add"] },
    docsSlug: command,
    format: null,
    rootKey: null,
    transports: ["stdio"],
    locations: [],
    gotchas: [],
    rulesFiles: [],
  } as unknown as AgentEntry
}

const mockedExec = execFile as unknown as ReturnType<typeof vi.fn>

describe("vendor CLI allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects a vendor CLI command that is not in the allowlist", async () => {
    const result = await installAgent({
      agent: fakeVendorAgent("/path/to/evil-binary"),
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
    })

    expect(result.outcome).toBe("FAILED")
    expect(result.message).toMatch(/not allowlisted/)
    expect(result.message).toContain("/path/to/evil-binary")
    expect(execFile).not.toHaveBeenCalled()
  })

  it("rejects a vendor CLI command whose basename is not in the allowlist", async () => {
    const result = await installAgent({
      agent: fakeVendorAgent("/usr/bin/claude-rogue"),
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
    })

    expect(result.outcome).toBe("FAILED")
    expect(result.message).toMatch(/not allowlisted/)
    expect(execFile).not.toHaveBeenCalled()
  })

  it("delegates to an allowlisted vendor CLI", async () => {
    mockedExec.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      if (typeof callback === "function") callback(null, "", "")
      return undefined as never
    })

    const result = await installAgent({
      agent: fakeVendorAgent("claude"),
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
    })

    expect(result.outcome).toBe("DELEGATED")
    expect(mockedExec).toHaveBeenCalledWith(
      "claude",
      ["mcp", "add"],
      expect.objectContaining({
        env: expect.objectContaining({
          LYRASHIELD_API_KEY: API_KEY,
          LYRASHIELD_API_URL: API_URL,
        }),
      }),
      expect.any(Function)
    )
  })

  it("reports failure when the allowlisted vendor CLI exits with an error", async () => {
    mockedExec.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      if (typeof callback === "function") callback(new Error("exit code 1"))
      return undefined as never
    })

    const result = await installAgent({
      agent: fakeVendorAgent("amp"),
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
    })

    expect(result.outcome).toBe("FAILED")
    expect(result.message).toMatch(/exit code 1/)
  })
})
