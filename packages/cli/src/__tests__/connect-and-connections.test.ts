import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetEffectiveCredentials = vi.fn()
const mockCreateClient = vi.fn()
const mockInstallAgent = vi.fn()

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: () => mockGetEffectiveCredentials(),
}))

vi.mock("../client.js", () => ({
  createClient: () => mockCreateClient(),
}))

vi.mock("../installers/install.js", () => ({
  installAgent: (...args: unknown[]) => mockInstallAgent(...args),
}))

vi.mock("../installers/detect.js", () => ({
  detectAgent: vi.fn().mockResolvedValue(true),
}))

import { handleConnect } from "../commands/connect.js"
import { handleConnections } from "../commands/connections.js"
import type { Output } from "../output.js"

interface MockOutput extends Output {
  logs: string[]
  errors: string[]
  getResult: () => unknown
}

function createMockOutput(): MockOutput {
  const logs: string[] = []
  const errors: string[] = []
  let resultData: unknown = null
  return {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (msg: unknown) => errors.push(String(msg)),
    warn: vi.fn(),
    notice: vi.fn(),
    fail: (error: string, exitCode?: number) => {
      errors.push(error)
      throw new Error(`Process failed with code ${exitCode ?? 1}: ${error}`)
    },
    result: (data: unknown) => {
      resultData = data
    },
    json: false,
    quiet: false,
    logs,
    errors,
    getResult: () => resultData,
  }
}

describe("CLI connect command", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("fails if no credentials are present", async () => {
    mockGetEffectiveCredentials.mockResolvedValueOnce({
      apiKey: null,
      credentialKind: "none",
    })
    const output = createMockOutput()
    const code = await handleConnect([], output)
    expect(code).toBe(2)
    expect(output.errors[0]).toContain("No LyraShield credentials found")
  })

  it("connects a specified agent successfully and verifies read", async () => {
    mockGetEffectiveCredentials.mockResolvedValueOnce({
      apiKey: "lsk_test_key",
      apiUrl: "https://app.lyrashieldai.com",
      workspaceId: "ws-1",
      credentialKind: "api-key",
    })

    const requestMock = vi.fn().mockResolvedValue([{ id: "ws-1", name: "Default" }])
    mockCreateClient.mockResolvedValueOnce({
      request: requestMock,
    })

    mockInstallAgent.mockResolvedValueOnce({
      outcome: "CONFIGURED",
      path: "/Users/test/.cursor/config.json",
      message: "Cursor configured",
    })

    const output = createMockOutput()
    const code = await handleConnect(["--agent", "cursor"], output)

    expect(code).toBe(0)
    expect(output.logs.some((l) => l.includes("Configured Cursor"))).toBe(true)
    expect(output.logs.some((l) => l.includes("Read verification: Verified"))).toBe(true)
  })

  it("does not report manual installation as connected", async () => {
    mockGetEffectiveCredentials.mockResolvedValueOnce({
      apiKey: "lsk_test_key",
      apiUrl: "https://app.lyrashieldai.com",
      workspaceId: "ws-1",
      credentialKind: "api-key",
    })
    mockCreateClient.mockResolvedValueOnce({
      request: vi.fn().mockResolvedValue([{ id: "ws-1" }]),
    })
    mockInstallAgent.mockResolvedValueOnce({
      outcome: "MANUAL_REQUIRED",
      message: "Enable the integration in the client.",
    })

    const output = createMockOutput()
    expect(await handleConnect(["--agent", "cursor"], output)).toBe(2)
    expect(output.logs.some((line) => line.includes("Connected"))).toBe(false)
  })

  it("does not misconfigure Claude Chat as Claude Code", async () => {
    mockGetEffectiveCredentials.mockResolvedValueOnce({
      apiKey: "lsk_test_key",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "api-key",
    })

    const output = createMockOutput()
    expect(await handleConnect(["--agent", "claude-desktop"], output)).toBe(2)
    expect(output.errors[0]).toContain("Claude Chat custom connectors")
    expect(mockInstallAgent).not.toHaveBeenCalled()
  })
})

describe("CLI connections command", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEffectiveCredentials.mockResolvedValue({
      apiKey: "lsk_test",
      workspaceId: "ws-1",
    })
  })

  it("lists connections for active workspace", async () => {
    const requestMock = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: "conn-1",
          clientType: "codex",
          clientName: "Codex Agent",
          status: "ACTIVE",
          allowedOperations: ["CANONICAL_RUN_PR_SCAN"],
          allowedTargetIds: [],
          createdAt: new Date().toISOString(),
        },
      ],
    })
    mockCreateClient.mockResolvedValueOnce({ request: requestMock })

    const output = createMockOutput()
    const code = await handleConnections(["list"], output)

    expect(code).toBe(0)
    expect(requestMock).toHaveBeenCalledWith("GET", "/connections?workspaceId=ws-1")
    expect(output.logs.some((l) => l.includes("conn-1 [ACTIVE] Codex Agent"))).toBe(true)
  })

  it("pauses connection by id", async () => {
    const requestMock = vi.fn().mockResolvedValue({
      success: true,
      data: { id: "conn-1", status: "PAUSED" },
    })
    mockCreateClient.mockResolvedValueOnce({ request: requestMock })

    const output = createMockOutput()
    const code = await handleConnections(["pause", "conn-1"], output)

    expect(code).toBe(0)
    expect(requestMock).toHaveBeenCalledWith("POST", "/connections/conn-1/pause", {
      body: { workspaceId: "ws-1" },
    })
    expect(output.logs.some((l) => l.includes("paused"))).toBe(true)
  })

  it("revokes/disconnects connection by id", async () => {
    const requestMock = vi.fn().mockResolvedValue({
      success: true,
      data: { id: "conn-1", status: "REVOKED" },
    })
    mockCreateClient.mockResolvedValueOnce({ request: requestMock })

    const output = createMockOutput()
    const code = await handleConnections(["disconnect", "conn-1"], output)

    expect(code).toBe(0)
    expect(requestMock).toHaveBeenCalledWith("POST", "/connections/conn-1/revoke", {
      body: { workspaceId: "ws-1" },
    })
    expect(output.logs.some((l) => l.includes("revoked and disconnected"))).toBe(true)
  })
})
