import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WORKSPACE_SCOPED_MODELS, WORKSPACE_SCOPE_EXCLUSIONS } from "./scoping"

/**
 * The workspace-scoped set and the documented exclusion set must partition
 * exactly the schema models that carry a workspaceId column. A new model
 * with workspaceId fails this test until someone decides — in code — whether
 * the extension auto-scopes it or documents why it must not.
 */
describe("scoping sets vs schema", () => {
  const schema = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8")
  const modelsWithWorkspaceId = new Set(
    [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)]
      .filter(([, , body]) => /^\s*workspaceId\s+\w+\??/m.test(body))
      .map(([, name]) => name)
  )

  it("every model with a workspaceId column is scoped or documented as excluded", () => {
    const unaccounted = [...modelsWithWorkspaceId].filter(
      (model) => !WORKSPACE_SCOPED_MODELS.has(model) && !WORKSPACE_SCOPE_EXCLUSIONS.has(model)
    )
    expect(
      unaccounted,
      `models with workspaceId missing from both scoping sets: ${unaccounted.join(", ")}`
    ).toEqual([])
  })

  it("the two sets are disjoint and contain no non-existent models", () => {
    for (const model of WORKSPACE_SCOPED_MODELS) {
      expect(WORKSPACE_SCOPE_EXCLUSIONS.has(model), `${model} is in both sets`).toBe(false)
      expect(
        modelsWithWorkspaceId.has(model),
        `${model} is scoped but has no workspaceId column in schema.prisma`
      ).toBe(true)
    }
    for (const model of WORKSPACE_SCOPE_EXCLUSIONS) {
      expect(
        modelsWithWorkspaceId.has(model),
        `${model} is excluded but has no workspaceId column — prune the exclusion`
      ).toBe(true)
    }
  })
})
