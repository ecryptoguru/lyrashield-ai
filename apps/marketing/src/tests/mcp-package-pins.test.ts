import { describe, expect, it } from "vitest"
import { MCP_PACKAGE_VERSION } from "@lyrashield/agent-registry"

const sources = import.meta.glob<string>("../**/*.{astro,mdx}", {
  eager: true,
  query: "?raw",
  import: "default",
})
const historicalReleasePrefix = "content/blog/releases/"
const versionRejectionFixture = /(?:version-rejection|rejects-.*version)/i

describe("marketing MCP package pins", () => {
  it("keeps active install snippets aligned with the registry", () => {
    const mismatches: string[] = []
    for (const [path, contents] of Object.entries(sources)) {
      const relativePath = path.replace(/^\.\.\//, "")
      if (
        relativePath.startsWith(historicalReleasePrefix) ||
        versionRejectionFixture.test(relativePath)
      ) {
        continue
      }
      for (const match of contents.matchAll(/@lyrashield\/mcp@(\d+\.\d+\.\d+)/g)) {
        if (match[1] !== MCP_PACKAGE_VERSION) {
          mismatches.push(`${relativePath}: @lyrashield/mcp@${match[1]}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})
