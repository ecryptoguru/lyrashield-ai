import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, access, readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentEntry } from "@lyrashield/agent-registry"

/* eslint-disable security/detect-non-literal-fs-filename */

// Hoist the mock so vi.mock can reference it. Most tests need the real plugin
// dir; the copy-failure test overrides it to a non-existent path so `cp`
// fails naturally without spying on ESM exports.
const { credentialsFileExistsMock, getPluginDirMock, execFileMock } = vi.hoisted(() => ({
  credentialsFileExistsMock: vi.fn(),
  getPluginDirMock: vi.fn(),
  execFileMock: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFile: execFileMock }))

vi.mock("@lyrashield/agent-plugin", () => ({
  getPluginDir: getPluginDirMock,
}))

vi.mock("../../credentials.js", () => ({
  credentialsFileExists: credentialsFileExistsMock,
}))

import { installAgentPlugin, uninstallAgentPlugin } from "../../installers/agent-plugin.js"
import { getPluginDir } from "@lyrashield/agent-plugin"

const mockedGetPluginDir = vi.mocked(getPluginDir)

const ORIGINAL_ENV = { ...process.env }
let pluginSourceDir: string

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  process.env.LYRASHIELD_API_KEY = "lsk_test"
  credentialsFileExistsMock.mockResolvedValue(false)
  // Use an isolated source so the Agent Plugin generator can run in parallel
  // without renaming files while this suite copies them.
  pluginSourceDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-source-"))
  await writeFile(
    path.join(pluginSourceDir, "plugin.json"),
    JSON.stringify({ name: "lyrashield" }),
    "utf-8"
  )
  await writeFile(
    path.join(pluginSourceDir, "mcp.json"),
    JSON.stringify({ mcpServers: { lyrashield: {} } }),
    "utf-8"
  )
  mockedGetPluginDir.mockReturnValue(pluginSourceDir)
})

afterEach(async () => {
  await rm(pluginSourceDir, { recursive: true, force: true })
  process.env = ORIGINAL_ENV
  vi.clearAllMocks()
})

// Registry plugin locations are scope-anchored and resolved under a
// containment check (VERIFY-E-006): global entries live under $HOME, project
// entries under the project cwd. Fixture agents use project scope with an
// explicit cwd so tests never touch the real home directory.
function makeAgent(pluginPath: string): AgentEntry {
  return {
    id: "test-agent-plugin",
    displayName: "Test Agent Plugin",
    docsSlug: "test",
    installStrategy: "agent-plugin",
    format: null,
    rootKey: null,
    locations: [],
    pluginLocations: [
      {
        scope: "project",
        path: pluginPath,
        sharedByConvention: false,
      },
    ],
    transports: ["stdio"],
    credential: { kind: "shell-env" },
    rulesFiles: [],
    gotchas: [],
  }
}

function makeCodexAgent(): AgentEntry {
  return {
    ...makeAgent("~/.codex/plugins/lyrashield"),
    id: "openai-codex-agent-plugin",
    displayName: "OpenAI Codex (Agent Plugin)",
    transports: ["remote-http"],
  }
}

describe("installAgentPlugin", () => {
  it("registers the official marketplace before installing the Codex plugin", async () => {
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: unknown) => {
        if (typeof callback === "function") callback(null, "", "")
      }
    )

    const result = await installAgentPlugin({ agent: makeCodexAgent() })

    expect(result.outcome).toBe("DELEGATED")
    expect(execFileMock.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["codex", ["plugin", "marketplace", "add", "ecryptoguru/lyrashield-marketplace"]],
      ["codex", ["plugin", "add", "lyrashield@lyrashield-ai"]],
    ])
  })

  it("does not run Codex plugin commands during a dry run", async () => {
    const result = await installAgentPlugin({ agent: makeCodexAgent(), dryRun: true })

    expect(result.outcome).toBe("DELEGATED")
    expect(result.message).toContain("Would run codex plugin marketplace add")
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it("returns exact activation guidance instead of copying to an undiscovered path", async () => {
    const agent = {
      ...makeAgent("~/.example/plugins/lyrashield"),
      manualInstructions: "Install through the client marketplace.",
    }

    const result = await installAgentPlugin({ agent })
    expect(result).toMatchObject({
      outcome: "MANUAL_REQUIRED",
      message: "Install through the client marketplace.",
    })
  })

  it("copies the canonical plugin directory to the destination with --yes", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, cwd: tempDir, yes: true })
    expect(result.outcome).toBe("CONFIGURED")
    expect(result.path).toBe(dest)

    // Verify plugin.json was copied
    const pluginJson = JSON.parse(await readFile(path.join(dest, "plugin.json"), "utf-8")) as {
      name: string
    }
    expect(pluginJson.name).toBe("lyrashield")

    // Verify mcp.json was copied
    const mcpJson = JSON.parse(await readFile(path.join(dest, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>
    }
    expect(mcpJson.mcpServers).toBeDefined()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("fails when no credentials are available", async () => {
    delete process.env.LYRASHIELD_API_KEY
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, cwd: tempDir, yes: true })
    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toContain("lyrashield login")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("installs a remote OAuth plugin before client authentication", async () => {
    delete process.env.LYRASHIELD_API_KEY
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent: AgentEntry = { ...makeAgent(dest), transports: ["remote-http"] }

    const result = await installAgentPlugin({ agent, cwd: tempDir })
    expect(result.outcome).toBe("CONFIGURED")
    await expect(access(path.join(dest, "plugin.json"))).resolves.toBeUndefined()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("dry-run does not write files", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, cwd: tempDir, dryRun: true })
    expect(result.outcome).toBe("CONFIGURED")
    expect(result.message).toContain("Would copy")

    await expect(access(dest)).rejects.toThrow()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("installs to a fresh destination without --yes", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, cwd: tempDir })
    expect(result.outcome).toBe("CONFIGURED")
    expect(result.path).toBe(dest)

    await expect(access(dest)).resolves.toBeUndefined()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("preserves existing install on copy failure and restores backup", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    // Simulate an existing install with user customizations
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "user-custom.txt"), "user data", "utf-8")

    // Point getPluginDir to a non-existent source so `cp` fails.
    mockedGetPluginDir.mockReturnValue(path.join(tempDir, "nonexistent-source"))

    const result = await installAgentPlugin({ agent, cwd: tempDir, yes: true })
    expect(result.outcome).toBe("FAILED")
    expect(result.message).toContain("Plugin copy failed")

    // The original install should be restored
    const restored = await readFile(path.join(dest, "user-custom.txt"), "utf-8")
    expect(restored).toBe("user data")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("overwrites existing install and removes backup on success", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    // Simulate an existing install with user customizations
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "user-custom.txt"), "user data", "utf-8")

    const result = await installAgentPlugin({ agent, cwd: tempDir, yes: true })
    expect(result.outcome).toBe("CONFIGURED")

    // The new plugin files should be present
    const pluginJson = JSON.parse(await readFile(path.join(dest, "plugin.json"), "utf-8")) as {
      name: string
    }
    expect(pluginJson.name).toBe("lyrashield")

    // The old user customization should be gone (overwritten)
    await expect(access(path.join(dest, "user-custom.txt"))).rejects.toThrow()

    // No backup directory should remain
    const entries = await readdir(tempDir)
    expect(entries.some((e) => e.includes("lyrashield-backup"))).toBe(false)

    await rm(tempDir, { recursive: true, force: true })
  })
})

describe("uninstallAgentPlugin", () => {
  it("removes the Codex plugin through its marketplace manager", async () => {
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: unknown) => {
        if (typeof callback === "function") callback(null, "", "")
      }
    )

    const result = await uninstallAgentPlugin({ agent: makeCodexAgent() })

    expect(result.outcome).toBe("DELEGATED")
    expect(execFileMock).toHaveBeenCalledWith(
      "codex",
      ["plugin", "remove", "lyrashield@lyrashield-ai"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    )
  })

  it("does not delete a client-managed marketplace or MCP install", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = {
      ...makeAgent(dest),
      manualInstructions: "Install through the client marketplace.",
    }
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "client-owned.txt"), "keep", "utf-8")

    const result = await uninstallAgentPlugin({ agent, cwd: tempDir })
    expect(result.outcome).toBe("MANUAL_REQUIRED")
    await expect(access(path.join(dest, "client-owned.txt"))).resolves.toBeUndefined()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("removes the plugin directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    await installAgentPlugin({ agent, cwd: tempDir, yes: true })
    const result = await uninstallAgentPlugin({ agent, cwd: tempDir })
    expect(result.outcome).toBe("CONFIGURED")
    expect(result.message).toContain("Plugin removed")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("reports already-configured when plugin is not present", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    const result = await uninstallAgentPlugin({ agent, cwd: tempDir })
    expect(result.outcome).toBe("ALREADY_CONFIGURED")
    expect(result.message).toContain("not present")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("refuses to delete a path that escapes the project scope root (VERIFY-E-006)", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    // An attacker-influenced registry entry would resolve outside cwd —
    // containment must refuse before rm -r runs.
    const outside = await mkdtemp(path.join(tmpdir(), "lyra-plugin-outside-"))
    const victim = path.join(outside, "victim", "keep.txt")
    await mkdir(path.dirname(victim), { recursive: true })
    await writeFile(victim, "keep", "utf-8")

    const agent = makeAgent("../outside-scope")
    const result = await uninstallAgentPlugin({ agent, cwd: tempDir })
    expect(result.outcome).toBe("FAILED")
    expect(result.message).toContain("outside its scope root")

    // A depth-1 destination (e.g. the project root's direct child at scale,
    // or worse "~/.config" under global scope) is never an rm -r target.
    const shallow = makeAgent("top-level-only")
    const shallowResult = await uninstallAgentPlugin({ agent: shallow, cwd: tempDir })
    expect(shallowResult.outcome).toBe("FAILED")

    await expect(access(victim)).resolves.toBeUndefined()
    await rm(tempDir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
})
