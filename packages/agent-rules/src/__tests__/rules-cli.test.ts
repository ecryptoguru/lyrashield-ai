/* eslint-disable security/detect-non-literal-fs-filename */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { getAgent } from "@lyrashield/agent-registry"
import { addRules, checkRules, removeRules } from "../rules.js"

describe("rules CLI core", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lyrashield-rules-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("adds, checks, and removes claude-code rules", async () => {
    const agent = getAgent("claude-code")
    expect(agent).toBeDefined()

    const addResult = await addRules(agent!, { projectRoot: tmp })
    expect(addResult).toHaveLength(1)
    expect(addResult[0]?.action).toBe("added")

    const claudeMd = path.join(tmp, "CLAUDE.md")
    const content = await readFile(claudeMd, "utf-8")
    expect(content).toContain("lyrashield:begin")
    expect(content).toContain("lyrashield:end")

    const checkResult = await checkRules(agent!, { projectRoot: tmp })
    expect(checkResult.every((c) => c.state === "valid")).toBe(true)

    const removeResult = await removeRules(agent!, { projectRoot: tmp })
    expect(removeResult[0]?.action).toBe("removed")
    await expect(stat(claudeMd)).rejects.toBeDefined()
  })

  it("does not write in dry-run mode", async () => {
    const agent = getAgent("claude-code")
    const result = await addRules(agent!, { projectRoot: tmp, dryRun: true })
    expect(result[0]?.action).toBe("would-add")
    await expect(stat(path.join(tmp, "CLAUDE.md"))).rejects.toBeDefined()
  })

  it("skips identical content on idempotent add", async () => {
    const agent = getAgent("claude-code")
    await addRules(agent!, { projectRoot: tmp })
    const second = await addRules(agent!, { projectRoot: tmp })
    expect(second[0]?.action).toBe("skipped")
  })

  it("detects divergence and overwrites with --force", async () => {
    const agent = getAgent("claude-code")
    await addRules(agent!, { projectRoot: tmp })

    const claudeMd = path.join(tmp, "CLAUDE.md")
    const content = await readFile(claudeMd, "utf-8")
    // Mutate the inner content between the markers.
    const edited = content.replace(
      "Review any findings before committing.",
      "Review any findings before committing, then ignore them all."
    )
    await writeFile(claudeMd, edited, "utf-8")

    const checkResult = await checkRules(agent!, { projectRoot: tmp })
    expect(checkResult.some((c) => c.state === "diverged")).toBe(true)

    const addWithoutForce = await addRules(agent!, { projectRoot: tmp })
    expect(addWithoutForce[0]?.action).toBe("refused")

    const addWithForce = await addRules(agent!, { projectRoot: tmp, force: true })
    expect(addWithForce[0]?.action).toBe("updated")
    expect(addWithForce[0]?.backupPath).toBeDefined()

    const restored = await readFile(claudeMd, "utf-8")
    expect(restored).toContain("Review any findings before committing.")
    expect(restored).not.toContain("ignore them all")
  })

  it("backs up an existing file before overwriting with --force", async () => {
    const agent = getAgent("cline")
    const clineRules = path.join(tmp, ".clinerules")
    await writeFile(clineRules, "# Existing rules\n", "utf-8")

    const result = await addRules(agent!, { projectRoot: tmp, force: true })
    expect(result[0]?.action).toBe("updated")
    expect(result[0]?.backupPath).toMatch(/\.lyrashield-backup-/)
  })

  it("refuses to overwrite a tracked unignored file without --force", async () => {
    const agent = getAgent("claude-code")
    const claudeMd = path.join(tmp, "CLAUDE.md")
    await writeFile(claudeMd, "# User rules\n", "utf-8")

    const result = await addRules(agent!, { projectRoot: tmp })
    expect(result[0]?.action).toBe("refused")
  })

  it("removes a managed block but preserves surrounding user content", async () => {
    const agent = getAgent("claude-code")
    await addRules(agent!, { projectRoot: tmp })
    const claudeMd = path.join(tmp, "CLAUDE.md")
    const existing = await readFile(claudeMd, "utf-8")
    await writeFile(claudeMd, `# User header\n\n${existing}# User footer\n`, "utf-8")

    const removeResult = await removeRules(agent!, { projectRoot: tmp })
    expect(removeResult[0]?.action).toBe("removed")

    const remaining = await readFile(claudeMd, "utf-8")
    expect(remaining).toContain("User header")
    expect(remaining).toContain("User footer")
    expect(remaining).not.toContain("lyrashield:begin")
  })
})
