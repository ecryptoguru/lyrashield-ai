import { describe, expect, it } from "vitest"
import { createAllTools, type ToolHandlerContext } from "./tools"
import { MUTATING_TOOL_NAMES } from "./tool-policy"

const dummyContext: ToolHandlerContext = {
  apiBaseUrl: "",
  apiKey: "",
}

describe("MUTATING_TOOL_NAMES", () => {
  it("matches the mutating entries in the MCP tool catalog exactly", () => {
    const derived = createAllTools(dummyContext)
      .filter((tool) => tool.mutating)
      .map((tool) => tool.name)
    expect([...MUTATING_TOOL_NAMES]).toEqual(derived)
  })

  it("contains no duplicates and no non-catalog names", () => {
    const catalogNames = new Set(createAllTools(dummyContext).map((tool) => tool.name))
    expect(new Set(MUTATING_TOOL_NAMES).size).toBe(MUTATING_TOOL_NAMES.length)
    for (const name of MUTATING_TOOL_NAMES) {
      expect(catalogNames.has(name)).toBe(true)
    }
  })
})
