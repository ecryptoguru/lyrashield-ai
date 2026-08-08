/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(new URL("../../../../", import.meta.url).pathname)
const marketplaceRoot = path.join(repoRoot, "docs", "marketplace")

describe("marketplace fixtures", () => {
  it("keeps Gemini and Cline contracts machine-readable", async () => {
    const gemini = JSON.parse(
      await readFile(
        path.join(marketplaceRoot, "gemini-extension", "gemini-extension.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    const cline = JSON.parse(
      await readFile(path.join(marketplaceRoot, "cline", "submission.json"), "utf8")
    ) as Record<string, unknown>
    expect(gemini).toMatchObject({ name: "lyrashield-ai", version: "0.1.0" })
    expect(gemini.mcpServers).toBeTruthy()
    expect(cline).toMatchObject({
      license: "Apache-2.0",
      defaultScope: "lyrashield.read",
      writeScope: "lyrashield.write",
    })
  })

  it("ships reviewer-safe workflows and accurate community wording", async () => {
    const workflows = JSON.parse(
      await readFile(path.join(marketplaceRoot, "reviewer-pack", "workflows.json"), "utf8")
    ) as {
      positiveWorkflows: string[]
      safeFailures: string[]
    }
    const openclaw = await readFile(path.join(marketplaceRoot, "openclaw", "SKILL.md"), "utf8")
    expect(workflows.positiveWorkflows).toHaveLength(5)
    expect(workflows.safeFailures).toHaveLength(3)
    expect(openclaw).toContain("not an official OpenClaw channel")
  })
})
