/* eslint-disable security/detect-non-literal-fs-filename */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { handleRules } from "../commands/rules.js"
import { createOutput } from "../output.js"

describe("rules command conformance", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lyrashield-cli-rules-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  function mockOutput() {
    const lines: string[] = []
    const output = createOutput({ json: false })
    return {
      ...output,
      log: (...args: unknown[]) => {
        lines.push(args.map(String).join(" "))
      },
      get lines() {
        return lines
      },
    }
  }

  it("adds claude-code rules files", async () => {
    const output = mockOutput()
    const code = await handleRules(["add", "claude-code", "--project-root", tmp], output)
    expect(code).toBe(0)
    expect(output.lines.some((l) => l.includes("added"))).toBe(true)
    const claudeMd = path.join(tmp, "CLAUDE.md")
    const content = await readFile(claudeMd, "utf-8")
    expect(content).toContain("lyrashield:begin")
    expect(content).toContain("lyrashield:end")
  })

  it("dry-run does not create files", async () => {
    const output = mockOutput()
    const code = await handleRules(
      ["add", "claude-code", "--dry-run", "--project-root", tmp],
      output
    )
    expect(code).toBe(0)
    expect(output.lines.some((l) => l.includes("would-add"))).toBe(true)
    await expect(stat(path.join(tmp, "CLAUDE.md"))).rejects.toBeDefined()
  })

  it("check reports valid after add", async () => {
    await handleRules(["add", "claude-code", "--project-root", tmp], mockOutput())
    const output = mockOutput()
    const code = await handleRules(["check", "claude-code", "--project-root", tmp], output)
    expect(code).toBe(0)
    expect(output.lines.some((l) => l.includes("valid"))).toBe(true)
  })

  it("remove deletes the rule file", async () => {
    await handleRules(["add", "claude-code", "--project-root", tmp], mockOutput())
    const output = mockOutput()
    const code = await handleRules(["remove", "claude-code", "--project-root", tmp], output)
    expect(code).toBe(0)
    await expect(stat(path.join(tmp, "CLAUDE.md"))).rejects.toBeDefined()
  })
})
