import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/lyrashield-scan.yml"),
  "utf8"
)

function runBlocks(yaml: string): string[] {
  const lines = yaml.split("\n")
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)run:\s*\|\s*$/.exec(lines[index] ?? "")
    if (!match) continue
    const indent = match[1]?.length ?? 0
    const body: string[] = []
    while (++index < lines.length) {
      const line = lines[index] ?? ""
      if (line.trim() && line.search(/\S/) <= indent) {
        index--
        break
      }
      body.push(line)
    }
    blocks.push(body.join("\n"))
  }
  return blocks
}

describe("reusable workflow input safety", () => {
  it("never interpolates GitHub expressions into Bash source", () => {
    for (const block of runBlocks(workflow)) {
      expect(block).not.toContain("${{")
    }
  })

  it("validates caller-controlled modes and severities", () => {
    expect(workflow).toContain("SAFE|DEEP|AGGRESSIVE")
    expect(workflow).toContain("CRITICAL|HIGH|MEDIUM|LOW|INFO")
  })

  it("warns callers that DEEP currently has SAFE-equivalent coverage", () => {
    expect(workflow).toContain("scan_mode DEEP is not yet implemented")
  })

  it("scopes gitleaks to the resolved base and head range", () => {
    expect(workflow).toContain(
      "GITLEAKS_LOG_OPTS: ${{ steps.diff.outputs.base_sha }}..${{ steps.diff.outputs.head_sha }}"
    )
    expect(workflow).not.toContain("steps.resolve.outputs")
  })
})
