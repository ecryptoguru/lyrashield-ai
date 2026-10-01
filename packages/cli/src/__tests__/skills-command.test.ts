import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentEntry } from "@lyrashield/agent-registry"
import type { Output } from "../output.js"

const mocks = vi.hoisted(() => ({
  pluginDir: "",
  agent: undefined as
    | {
        id: string
        displayName: string
        skillLocations?: {
          scope: "project" | "global"
          path: string
          sharedByConvention: boolean
        }[]
      }
    | undefined,
}))
vi.mock("@lyrashield/agent-plugin", () => ({ getPluginDir: () => mocks.pluginDir }))
vi.mock("@lyrashield/agent-registry", () => ({
  getPreferredAgent: (id: string) => (id === "pi" ? mocks.agent : undefined),
}))

import { handleSkills } from "../commands/skills.js"

describe("skills command", () => {
  let temp: string
  let project: string
  const captured = { lines: [] as string[], notices: [] as string[], errors: [] as string[] }

  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "lyrashield-cli-skills-command-"))
    project = path.join(temp, "project")
    mocks.pluginDir = path.join(temp, "plugin")
    await mkdir(path.join(project), { recursive: true })
    await mkdir(path.join(mocks.pluginDir, "skills", "get-started"), { recursive: true })
    await writeFile(
      path.join(mocks.pluginDir, "skills", "get-started", "SKILL.md"),
      "---\nname: get-started\ndescription: Connect\n---\n"
    )
    captured.lines = []
    captured.notices = []
    captured.errors = []
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  function output(json = false): Output {
    return {
      json,
      quiet: false,
      log: (...args) => captured.lines.push(args.map(String).join(" ")),
      notice: (...args) => captured.notices.push(args.map(String).join(" ")),
      warn: (...args) => captured.notices.push(args.map(String).join(" ")),
      error: (message) => captured.errors.push(String(message)),
      result: (value) => captured.lines.push(JSON.stringify(value)),
      fail: (message): never => {
        throw new Error(message)
      },
    }
  }

  it("installs for the selected project and reports reload limits", async () => {
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
      skillLocations: [{ scope: "project", path: ".agents/skills", sharedByConvention: true }],
      gotchas: [],
    }
    mocks.agent = agent

    const code = await handleSkills(
      ["install", "pi", "--project", "--project-root", project],
      output()
    )

    expect(code).toBe(0)
    expect(
      await readFile(path.join(project, ".agents/skills/get-started/SKILL.md"), "utf8")
    ).toContain("Connect")
    expect(captured.lines.some((line) => line.includes("INSTALLED Pi"))).toBe(true)
    expect(captured.notices.join(" ")).toContain("verify its skill list")
  })

  it("does not silently fall back from an unsupported project scope", async () => {
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
      skillLocations: [{ scope: "global", path: "~/.agents/skills", sharedByConvention: false }],
      gotchas: [],
    }
    mocks.agent = agent

    const code = await handleSkills(
      ["install", "pi", "--project", "--project-root", project],
      output()
    )

    expect(code).toBe(1)
    expect(captured.notices.join(" ")).toContain("No project skill installation path")
    await expect(
      readFile(path.join(project, ".agents/skills/get-started/SKILL.md"), "utf8")
    ).rejects.toBeDefined()
  })
})
