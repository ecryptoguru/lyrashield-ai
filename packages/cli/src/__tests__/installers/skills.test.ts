import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentEntry, ConfigLocation } from "@lyrashield/agent-registry"

const mockPlugin = vi.hoisted(() => ({ directory: "" }))
vi.mock("@lyrashield/agent-plugin", () => ({ getPluginDir: () => mockPlugin.directory }))

import {
  installAgentSkills,
  removeAgentSkills,
  resolveSkillLocation,
} from "../../installers/skills.js"

describe("agent skill installer", () => {
  let temp: string
  let project: string
  let plugin: string
  let home: string

  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "lyrashield-cli-skills-"))
    project = path.join(temp, "project")
    plugin = path.join(temp, "plugin")
    home = path.join(temp, "home")
    await mkdir(project)
    await mkdir(home)
    await mkdir(path.join(plugin, "skills"), { recursive: true })
    mockPlugin.directory = plugin
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  function makeAgent(
    skillPath = ".agents/skills",
    scope: "project" | "global" = "project"
  ): AgentEntry {
    const location: ConfigLocation = { scope, path: skillPath, sharedByConvention: true }
    const agent: AgentEntry = {
      id: "pi",
      displayName: "Pi",
      docsSlug: "pi",
      installStrategy: "config-file",
      format: "json",
      rootKey: null,
      locations: [],
      transports: ["stdio"],
      credential: { kind: "ui-fields" },
      rulesFiles: [],
      skillLocations: [location],
      gotchas: [],
    }
    return agent
  }

  async function writeSource(relative: string, content: string): Promise<void> {
    const file = path.join(plugin, "skills", ...relative.split("/"))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  async function seedSource(
    content = "---\nname: example\ndescription: Example\n---\n\nOriginal\n"
  ) {
    await writeSource("example/SKILL.md", content)
    await writeSource("example/references/guide.md", "Bundled guide\n")
  }

  function ownershipManifestPath(root: string): string {
    const id = createHash("sha256").update(path.resolve(root)).digest("hex")
    return path.join(home, ".lyrashield", "skills", `${id}.json`)
  }

  function testInstall(options: Parameters<typeof installAgentSkills>[0]) {
    return installAgentSkills({ ...options, homeDir: options.homeDir ?? home })
  }

  function testRemove(options: Parameters<typeof removeAgentSkills>[0]) {
    return removeAgentSkills({ ...options, homeDir: options.homeDir ?? home })
  }

  it("preserves unrelated skills, config, and an existing custom skill", async () => {
    await seedSource()
    const skillRoot = path.join(project, ".agents", "skills")
    await mkdir(path.join(skillRoot, "example"), { recursive: true })
    await writeFile(path.join(skillRoot, "example", "SKILL.md"), "My custom skill\n")
    await mkdir(path.join(skillRoot, "other"), { recursive: true })
    await writeFile(path.join(skillRoot, "other", "SKILL.md"), "Unrelated skill\n")
    await writeFile(path.join(skillRoot, "client.json"), '{"other":"server"}\n')

    const result = await testInstall({ agent: makeAgent(), scope: "project", cwd: project })

    expect(result.outcome).toBe("PARTIAL")
    expect(await readFile(path.join(skillRoot, "example", "SKILL.md"), "utf8")).toBe(
      "My custom skill\n"
    )
    expect(await readFile(path.join(skillRoot, "other", "SKILL.md"), "utf8")).toBe(
      "Unrelated skill\n"
    )
    expect(await readFile(path.join(skillRoot, "client.json"), "utf8")).toBe('{"other":"server"}\n')
    expect(await readFile(path.join(skillRoot, "example", "references", "guide.md"), "utf8")).toBe(
      "Bundled guide\n"
    )
  })

  it("refuses withheld skill installs but still removes previously owned files", async () => {
    await seedSource()
    const permittedAgent = makeAgent(".github/skills")
    const withheldAgent: AgentEntry = {
      ...permittedAgent,
      id: "github-copilot-cloud-agent",
      displayName: "GitHub Copilot Cloud Agent",
      skillInstallState: "withheld",
    }
    const skillFile = path.join(project, ".github", "skills", "example", "SKILL.md")

    const denied = await testInstall({ agent: withheldAgent, scope: "project", cwd: project })
    expect(denied.outcome).toBe("FAILED")
    expect(denied.message).toContain(
      "withheld for GitHub Copilot Cloud Agent until a workflow bundle is validated"
    )
    await expect(readFile(skillFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(path.join(project, ".github"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      readFile(ownershipManifestPath(path.join(project, ".github", "skills")), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })

    await testInstall({ agent: permittedAgent, scope: "project", cwd: project })
    const removed = await testRemove({ agent: withheldAgent, scope: "project", cwd: project })
    expect(removed.outcome).toBe("REMOVED")
    await expect(readFile(skillFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("upgrades files only when their prior checksum still matches", async () => {
    await seedSource()
    const agent = makeAgent()
    await testInstall({ agent, scope: "project", cwd: project })
    await writeSource(
      "example/SKILL.md",
      "---\nname: example\ndescription: Updated\n---\n\nUpdated by LyraShield\n"
    )

    const result = await testInstall({ agent, scope: "project", cwd: project })

    expect(result.outcome).toBe("INSTALLED")
    expect(result.actions.some((action) => action.action === "updated")).toBe(true)
    expect(await readFile(path.join(project, ".agents/skills/example/SKILL.md"), "utf8")).toContain(
      "Updated by LyraShield"
    )
  })

  it("keeps customized owned files on upgrade and removal", async () => {
    await seedSource()
    const agent = makeAgent()
    await testInstall({ agent, scope: "project", cwd: project })
    const installedFile = path.join(project, ".agents/skills/example/SKILL.md")
    await writeFile(installedFile, "Customized by user\n")
    await writeSource("example/SKILL.md", "---\nname: example\ndescription: New\n---\n\nNew\n")

    const upgrade = await testInstall({ agent, scope: "project", cwd: project })
    const removal = await testRemove({ agent, scope: "project", cwd: project })

    expect(upgrade.outcome).toBe("PARTIAL")
    expect(removal.outcome).toBe("PARTIAL")
    expect(await readFile(installedFile, "utf8")).toBe("Customized by user\n")
    expect(
      await readFile(ownershipManifestPath(path.join(project, ".agents/skills")), "utf8")
    ).toContain('"example/SKILL.md"')
  })

  it("removes only owned unmodified files and preserves neighbors", async () => {
    await seedSource()
    const agent = makeAgent()
    const skillRoot = path.join(project, ".agents/skills")
    await testInstall({ agent, scope: "project", cwd: project })
    await writeFile(path.join(skillRoot, "example", "custom.txt"), "keep me\n")

    const result = await testRemove({ agent, scope: "project", cwd: project })

    expect(result.outcome).toBe("REMOVED")
    await expect(readFile(path.join(skillRoot, "example/SKILL.md"), "utf8")).rejects.toBeDefined()
    expect(await readFile(path.join(skillRoot, "example/custom.txt"), "utf8")).toBe("keep me\n")
    expect(await readdir(skillRoot)).toContain("example")
    await expect(readFile(ownershipManifestPath(skillRoot), "utf8")).rejects.toBeDefined()
  })

  it("rejects path traversal in registry locations", async () => {
    await seedSource()
    const outside = path.join(temp, "outside")
    const result = await testInstall({
      agent: makeAgent("../../outside/skills"),
      scope: "project",
      cwd: project,
    })
    expect(result.outcome).toBe("FAILED")
    await expect(readFile(outside, "utf8")).rejects.toBeDefined()
  })

  it.skipIf(process.platform === "win32")("rejects symlinked skill roots", async () => {
    await seedSource()
    const outside = path.join(temp, "outside")
    await mkdir(outside)
    await symlink(outside, path.join(project, ".agents"), "dir")

    const result = await testInstall({ agent: makeAgent(), scope: "project", cwd: project })

    expect(result.outcome).toBe("FAILED")
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it("rejects traversal paths in the stored ownership manifest", async () => {
    await seedSource()
    const agent = makeAgent()
    await testInstall({ agent, scope: "project", cwd: project })
    const root = path.join(project, ".agents/skills")
    await writeFile(
      ownershipManifestPath(root),
      JSON.stringify({
        owner: "lyrashield-agent-skills",
        version: 1,
        files: { "../victim": "a".repeat(64) },
      })
    )

    const result = await testRemove({ agent, scope: "project", cwd: project })

    expect(result.outcome).toBe("FAILED")
    expect(await readFile(path.join(root, "example/SKILL.md"), "utf8")).toContain("Original")
  })

  it("ignores a project-forged manifest for a current bundled skill", async () => {
    await writeSource("example/SKILL.md", "Bundled skill\n")
    const agent = makeAgent()
    const skillRoot = path.join(project, ".agents/skills")
    const existingSkill = path.join(skillRoot, "example/SKILL.md")
    await mkdir(path.dirname(existingSkill), { recursive: true })
    await writeFile(existingSkill, "Existing same-name skill\n")
    await writeFile(
      path.join(skillRoot, ".lyrashield-skills.json"),
      JSON.stringify({
        owner: "lyrashield-agent-skills",
        version: 1,
        files: {
          "example/SKILL.md": createHash("sha256")
            .update("Existing same-name skill\n")
            .digest("hex"),
        },
      })
    )

    const install = await testInstall({ agent, scope: "project", cwd: project })
    const removal = await testRemove({ agent, scope: "project", cwd: project })

    expect(install.outcome).toBe("PARTIAL")
    expect(removal.outcome).toBe("NOOP")
    expect(await readFile(existingSkill, "utf8")).toBe("Existing same-name skill\n")
    expect(await readFile(path.join(skillRoot, ".lyrashield-skills.json"), "utf8")).toContain(
      "lyrashield-agent-skills"
    )
  })

  it("cleans a previously owned skill file removed from a later bundle", async () => {
    await seedSource()
    const agent = makeAgent()
    const root = path.join(project, ".agents/skills")
    const obsolete = path.join(root, "example/references/guide.md")
    await testInstall({ agent, scope: "project", cwd: project })
    await rm(path.join(plugin, "skills/example/references/guide.md"))

    const result = await testInstall({ agent, scope: "project", cwd: project })

    expect(result.outcome).toBe("REMOVED")
    await expect(readFile(obsolete, "utf8")).rejects.toBeDefined()
  })

  it("expands home paths and selects platform-specific skill locations", () => {
    const location: ConfigLocation = {
      scope: "global",
      path: "~/fallback/skills",
      platform: { darwin: "~/.agents/skills", linux: "~/.agents-linux/skills" },
      sharedByConvention: false,
    }
    expect(resolveSkillLocation(location, { homeDir: "/home/test", platform: "darwin" })).toBe(
      "/home/test/.agents/skills"
    )
    expect(resolveSkillLocation(location, { homeDir: "/home/test", platform: "linux" })).toBe(
      "/home/test/.agents-linux/skills"
    )
  })

  it("installs to the selected global home directory", async () => {
    await seedSource()
    const agent = makeAgent("~/.agents/skills", "global")

    const result = await testInstall({ agent, scope: "global", homeDir: home })

    expect(result.outcome).toBe("INSTALLED")
    expect(result.path).toBe(path.join(home, ".agents/skills"))
    expect(await readFile(path.join(home, ".agents/skills/example/SKILL.md"), "utf8")).toContain(
      "Original"
    )
  })
})
