import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, access, readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentEntry } from "@lyrashield/agent-registry"

/* eslint-disable security/detect-non-literal-fs-filename */

// Hoist the mock so vi.mock can reference it. Most tests need the real plugin
// dir; the copy-failure test overrides it to a non-existent path so `cp`
// fails naturally without spying on ESM exports.
const { getPluginDirMock } = vi.hoisted(() => ({
  getPluginDirMock: vi.fn(),
}))

vi.mock("@lyrashield/agent-plugin", () => ({
  getPluginDir: getPluginDirMock,
}))

import { installAgentPlugin, uninstallAgentPlugin } from "../../installers/agent-plugin.js"
import { getPluginDir } from "@lyrashield/agent-plugin"

const mockedGetPluginDir = vi.mocked(getPluginDir)

const ORIGINAL_ENV = { ...process.env }

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  process.env.LYRASHIELD_API_KEY = "lsk_test"
  // Default: return the real plugin directory.
  const actual = await vi.importActual<typeof import("@lyrashield/agent-plugin")>(
    "@lyrashield/agent-plugin"
  )
  mockedGetPluginDir.mockReturnValue(actual.getPluginDir())
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.clearAllMocks()
})

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
        scope: "global",
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

describe("installAgentPlugin", () => {
  it("copies the canonical plugin directory to the destination with --yes", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, yes: true })
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
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, yes: true })
    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toContain("lyrashield login")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("dry-run does not write files", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, dryRun: true })
    expect(result.outcome).toBe("CONFIGURED")
    expect(result.message).toContain("Would copy")

    await expect(access(dest)).rejects.toThrow()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("requires --yes to proceed without confirmation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent })
    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toContain("--yes")

    // Nothing should have been written
    await expect(access(dest)).rejects.toThrow()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("preserves existing install on copy failure and restores backup", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    // Simulate an existing install with user customizations
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "user-custom.txt"), "user data", "utf-8")

    // Point getPluginDir to a non-existent source so `cp` fails.
    mockedGetPluginDir.mockReturnValue(path.join(tempDir, "nonexistent-source"))

    const result = await installAgentPlugin({ agent, yes: true })
    expect(result.outcome).toBe("FAILED")
    expect(result.message).toContain("Plugin copy failed")

    // The original install should be restored
    const restored = await readFile(path.join(dest, "user-custom.txt"), "utf-8")
    expect(restored).toBe("user data")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("overwrites existing install and removes backup on success", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    // Simulate an existing install with user customizations
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "user-custom.txt"), "user data", "utf-8")

    const result = await installAgentPlugin({ agent, yes: true })
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
  it("removes the plugin directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    await installAgentPlugin({ agent, yes: true })
    const result = await uninstallAgentPlugin({ agent })
    expect(result.outcome).toBe("CONFIGURED")
    expect(result.message).toContain("Plugin removed")

    await rm(tempDir, { recursive: true, force: true })
  })

  it("reports already-configured when plugin is not present", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    const result = await uninstallAgentPlugin({ agent })
    expect(result.outcome).toBe("ALREADY_CONFIGURED")
    expect(result.message).toContain("not present")

    await rm(tempDir, { recursive: true, force: true })
  })
})
