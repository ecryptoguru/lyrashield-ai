import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, access, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installAgentPlugin, uninstallAgentPlugin } from "../../installers/agent-plugin.js"
import type { AgentEntry } from "@lyrashield/agent-registry"

/* eslint-disable security/detect-non-literal-fs-filename */

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  process.env.LYRASHIELD_API_KEY = "lsk_test"
})

afterEach(() => {
  process.env = ORIGINAL_ENV
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
  it("copies the canonical plugin directory to the destination", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent })
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

    const result = await installAgentPlugin({ agent })
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
})

describe("uninstallAgentPlugin", () => {
  it("removes the plugin directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "lyrashield")
    const agent = makeAgent(dest)

    await installAgentPlugin({ agent })
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
