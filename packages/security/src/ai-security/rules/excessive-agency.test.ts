import { describe, expect, it } from "vitest"
import { detectExcessiveAgency } from "./excessive-agency"
import type { AIScanFile } from "../types"

function tsFile(content: string): AIScanFile {
  return {
    path: "src/tools.ts",
    content,
    size: content.length,
    extension: ".ts",
    language: "typescript",
  }
}

const state = (content: string) => detectExcessiveAgency(tsFile(content))[0]?.state

/**
 * AI-05 matched destructive verbs with a bare substring test (`includes("rm")`),
 * which fired on any line containing the letters in sequence. Ordinary code was
 * reported as "unbounded agent permissions": `userMessage`, `perform`, `format`,
 * `transform`, `confirm` and even `terms` all matched. Because the rule runs per
 * line and not only over tool declarations, the false-positive surface was very
 * wide — and a security tool that cries wolf on `const terms = []` is worse than
 * one that stays quiet.
 *
 * These tests pin the boundary behaviour in both directions.
 */
describe("AI-05 excessive agency", () => {
  it("does not flag ordinary code containing a destructive verb as a substring", () => {
    const clean = [
      "const userMessage = req.body.text;",
      "const perform = true;",
      "function formatDate(d) { return d }",
      "const transform = (x) => x;",
      "const terms = [];",
      "const confirmed = true;",
      "if (isFormatted) render();",
    ]
    for (const line of clean) {
      expect(state(line), `false positive on: ${line}`).toBe("NO_FINDING")
    }
  })

  it("still flags genuine destructive tool names, including snake_case", () => {
    // `\b` cannot be used here: in `delete_file` the boundary after `delete` is
    // followed by `_`, itself a word character, so `delete\b` would not match
    // and this real case would be lost.
    for (const line of [
      '  name: "delete_file",',
      '  name: "remove_user",',
      '  name: "rm_rf",',
      "await db.drop(table)",
      "tool.truncate()",
      "overwrite(path)",
      "destroy()",
    ]) {
      expect(state(line), `missed destructive call: ${line}`).toBe("DETECTED")
    }
  })

  it("stays clean when approval is required for a destructive tool", () => {
    expect(state('  name: "delete_file", requireApproval: true')).toBe("NO_FINDING")
  })

  it("still flags auto-approve and auto-execute settings", () => {
    expect(state("    autoApprove: true,")).toBe("DETECTED")
    expect(state("new Agent({ tools, autoExecute: true })")).toBe("DETECTED")
  })

  it("preserves the fixture contract", () => {
    // The vulnerable fixture must still detect; the safe one must stay clean.
    const vulnerable = `import { Agent } from "langchain/agents"

const tools = [
  {
    name: "delete_file",
    description: "Deletes a file",
    autoApprove: true,
    func: ({ path }) => require("fs").unlinkSync(path),
  },
]

export const agent = new Agent({ tools, autoExecute: true })`

    const safe = `import { Agent } from "langchain/agents"

const tools = [
  {
    name: "read_file",
    description: "Reads a file",
    requireApproval: true,
    func: ({ path }) => require("fs").readFileSync(path, "utf8"),
  },
]

export const agent = new Agent({ tools, requireApproval: true })`

    expect(state(vulnerable)).toBe("DETECTED")
    expect(state(safe)).toBe("NO_FINDING")
  })
})
