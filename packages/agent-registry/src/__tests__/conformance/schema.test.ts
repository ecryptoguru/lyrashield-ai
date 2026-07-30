import { describe, expect, it } from "vitest"
import { AGENTS } from "../../agents.js"
import { agentEntrySchema } from "../../schema.js"

describe("conformance: every registry entry validates", () => {
  it("all 15 agents pass agentEntrySchema", () => {
    for (const agent of AGENTS) {
      const result = agentEntrySchema.safeParse(agent)
      if (!result.success) {
        throw new Error(`schema failure for ${agent.id}: ${result.error}`)
      }
      expect(result.success, `${agent.id} must match the registry schema`).toBe(true)
    }
  })
})
