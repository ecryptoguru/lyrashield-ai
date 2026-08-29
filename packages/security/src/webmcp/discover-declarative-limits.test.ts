import { describe, expect, it } from "vitest"
import { discoverWebMcpTools } from "./discover"

function htmlFile(content: string) {
  return { path: "deep.html", content, size: content.length, extension: ".html" }
}

describe("declarative discovery traversal limits", () => {
  it("discovers the depth boundary and marks deeper input incomplete", async () => {
    const boundary = '<form toolname="at_boundary"></form>'
    const boundaryResult = await discoverWebMcpTools([htmlFile(boundary)], {
      limits: { maxWalkDepth: 3 },
    })

    expect(boundaryResult.inventory.definitions.map((tool) => tool.name)).toEqual(["at_boundary"])
    expect(boundaryResult.inventory.limitsReached).not.toContain("max_walk_depth")

    const nested = `<div>${boundary}</div>`
    const nestedResult = await discoverWebMcpTools([htmlFile(nested)], {
      limits: { maxWalkDepth: 3 },
    })

    expect(nestedResult.inventory.definitions).toHaveLength(0)
    expect(nestedResult.inventory.limitsReached).toContain("max_walk_depth")
    expect(nestedResult.inventory.incompleteDefinitions).toBeGreaterThan(0)
  })

  it("stops deterministically at maxWalkEntries", async () => {
    const content = '<form toolname="first"></form><form toolname="second"></form>'
    const first = await discoverWebMcpTools([htmlFile(content)], {
      limits: { maxWalkEntries: 5 },
    })
    const second = await discoverWebMcpTools([htmlFile(content)], {
      limits: { maxWalkEntries: 5 },
    })

    expect(first.inventory.definitions.map((tool) => tool.name)).toEqual(["first"])
    expect(second.inventory.definitions).toEqual(first.inventory.definitions)
    expect(first.inventory.limitsReached).toContain("max_walk_entries")
    expect(first.inventory.incompleteDefinitions).toBeGreaterThan(0)
  })

  it("bounds deeply nested markup without recursive traversal", async () => {
    const depth = 2_000
    const content = `${"<div>".repeat(depth)}<form toolname="buried"></form>${"</div>".repeat(depth)}`

    const { inventory } = await discoverWebMcpTools([htmlFile(content)], {
      limits: { maxWalkDepth: 40 },
    })

    expect(inventory.definitions).toHaveLength(0)
    expect(inventory.limitsReached).toContain("max_walk_depth")
    expect(inventory.incompleteDefinitions).toBeGreaterThan(0)
  })
})
