import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import {
  chmod,
  mkdtemp,
  rm,
  access,
  readFile,
  writeFile,
  mkdir,
  symlink,
  lstat,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { getAgent, type AgentEntry } from "@lyrashield/agent-registry"

// Hoist the mock so vi.mock can reference it. Most tests need the real plugin
// dir; the copy-failure test overrides it to a non-existent path so `cp`
// fails naturally without spying on ESM exports.
const { getPluginDirMock, execFileMock } = vi.hoisted(() => ({
  getPluginDirMock: vi.fn(),
  execFileMock: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFile: execFileMock }))

vi.mock("@lyrashield/agent-plugin", () => ({
  getPluginDir: getPluginDirMock,
}))

import { installAgentPlugin, uninstallAgentPlugin } from "../../installers/agent-plugin.js"
import { getPluginDir } from "@lyrashield/agent-plugin"

const mockedGetPluginDir = vi.mocked(getPluginDir)

const ORIGINAL_ENV = { ...process.env }
let pluginSourceDir: string

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  process.env.LYRASHIELD_API_KEY = "lsk_test"
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
  it.each(["openai-codex-agent-plugin", "github-copilot-agent-plugin"])(
    "keeps the current %s entry manual without running marketplace commands",
    async (id) => {
      const agent = getAgent(id)!
      for (const dryRun of [false, true]) {
        const result = await installAgentPlugin({ agent, dryRun, yes: true })
        expect(result.outcome).toBe("MANUAL_REQUIRED")
        expect(result.message).toContain("reviewed matching immutable package release")
        expect(result.message).not.toContain("marketplace add")
      }
      expect(execFileMock).not.toHaveBeenCalled()
    }
  )

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

  it("keeps the selected VS Code plugin action manual without writing an install directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-vscode-plugin-"))
    try {
      const agent = getAgent("vscode-agent-plugin")!
      for (const dryRun of [false, true]) {
        const result = await installAgentPlugin({ agent, cwd: tempDir, dryRun, yes: true })
        expect(result.outcome).toBe("MANUAL_REQUIRED")
        expect(result.path).toBeUndefined()
        expect(result.message).toContain("does not install or register")
        expect(result.message).toContain(".vscode/mcp.json")
      }
      await expect(access(path.join(tempDir, ".vscode"))).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
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

  it("stages plugin files without requiring local credentials", async () => {
    delete process.env.LYRASHIELD_API_KEY
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const agent = makeAgent(dest)

    const result = await installAgentPlugin({ agent, cwd: tempDir, yes: true })
    expect(result.outcome).toBe("CONFIGURED")

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
    await expect(access(path.dirname(dest))).rejects.toThrow()

    await rm(tempDir, { recursive: true, force: true })
  })

  it("rejects a symlinked plugin parent without changing the target", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const outside = await mkdtemp(path.join(tmpdir(), "lyra-outside-"))
    await symlink(outside, path.join(tempDir, "plugins"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    const result = await installAgentPlugin({ agent: makeAgent(dest), cwd: tempDir, yes: true })
    expect(result.outcome).toBe("FAILED")
    expect(result.message).toContain("symlink")
    await expect(access(path.join(outside, "lyrashield"))).rejects.toThrow()
    await rm(tempDir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
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

  it("retains a backup with user customizations on replacement", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const pluginStore = path.join(tempDir, ".cursor", "plugins", "local")
    const dest = path.join(pluginStore, "lyrashield")
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

    expect(result.backupPath).toContain(path.join(tempDir, ".lyrashield", "plugin-backups"))
    expect(path.relative(pluginStore, result.backupPath!)).toMatch(/^\.\./)
    expect(await readFile(path.join(result.backupPath!, "user-custom.txt"), "utf-8")).toBe(
      "user data"
    )

    await rm(tempDir, { recursive: true, force: true })
  })
})

describe("uninstallAgentPlugin", () => {
  it("previews removal without deleting the plugin", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const dest = path.join(tempDir, "plugins", "lyrashield")
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "user-custom.txt"), "keep", "utf-8")
    const result = await uninstallAgentPlugin({
      agent: makeAgent(dest),
      cwd: tempDir,
      dryRun: true,
    })
    expect(result.message).toContain("Would remove")
    expect(await readFile(path.join(dest, "user-custom.txt"), "utf-8")).toBe("keep")
    await rm(tempDir, { recursive: true, force: true })
  })
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

  it("preserves customized plugin files outside the client plugin directory on uninstall", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
    const pluginStore = path.join(tempDir, ".cursor", "plugins", "local")
    const dest = path.join(pluginStore, "lyrashield")
    const backupRoot = path.join(tempDir, ".lyrashield", "plugin-backups")
    const agent = makeAgent(dest)
    await mkdir(backupRoot, { recursive: true, mode: 0o700 })
    await chmod(backupRoot, 0o777)
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, "plugin.json"), '{"name":"lyrashield"}\n', "utf-8")
    await writeFile(path.join(dest, "custom-skill.md"), "User customization\n", "utf-8")

    const result = await uninstallAgentPlugin({ agent, cwd: tempDir })

    expect(result.outcome).toBe("CONFIGURED")
    expect(result.backupPath).toContain(path.join(tempDir, ".lyrashield", "plugin-backups"))
    expect(path.relative(pluginStore, result.backupPath!)).toMatch(/^\.\./)
    expect(result.message).toContain(result.backupPath)
    expect((await lstat(backupRoot)).mode & 0o777).toBe(0o700)
    await expect(access(dest)).rejects.toThrow()
    expect(await readFile(path.join(result.backupPath!, "custom-skill.md"), "utf-8")).toBe(
      "User customization\n"
    )
    expect(await readFile(path.join(result.backupPath!, "plugin.json"), "utf-8")).toBe(
      '{"name":"lyrashield"}\n'
    )

    await rm(tempDir, { recursive: true, force: true })
  })

  it.each(["symlink", "file"] as const)(
    "keeps customized files in place when the plugin backup root is a %s",
    async (backupRootKind) => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-plugin-"))
      const dest = path.join(tempDir, ".cursor", "plugins", "local", "lyrashield")
      const backupRoot = path.join(tempDir, ".lyrashield", "plugin-backups")
      await mkdir(path.dirname(backupRoot), { recursive: true })
      if (backupRootKind === "symlink") {
        const outside = path.join(tempDir, "outside")
        await mkdir(outside)
        await symlink(outside, backupRoot)
      } else {
        await writeFile(backupRoot, "not a directory", "utf-8")
      }
      await mkdir(dest, { recursive: true })
      await writeFile(path.join(dest, "custom-skill.md"), "User customization\n", "utf-8")

      const result = await uninstallAgentPlugin({ agent: makeAgent(dest), cwd: tempDir })

      expect(result.outcome).toBe("FAILED")
      expect(await readFile(path.join(dest, "custom-skill.md"), "utf-8")).toBe(
        "User customization\n"
      )
      await rm(tempDir, { recursive: true, force: true })
    }
  )

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
