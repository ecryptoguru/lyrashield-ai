import { describe, expect, it, vi } from "vitest"
import { AGENTS } from "@lyrashield/agent-registry"
import type { Output } from "../output.js"

vi.mock("../installers/detect.js", () => ({
  detectAgent: vi.fn(async () => false),
  findDetectedLocations: vi.fn(async () => []),
}))

import { handleAgents } from "../commands/agents.js"

describe("agents command", () => {
  it("returns the complete registry with support and verification metadata", async () => {
    const results: unknown[] = []
    const output: Output = {
      json: true,
      quiet: false,
      log: vi.fn(),
      notice: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      result: (value) => results.push(value),
      fail: (message) => {
        throw new Error(message)
      },
    }

    await expect(handleAgents([], output)).resolves.toBe(0)
    const rows = results[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(AGENTS.length)
    expect(rows.map((row) => row.id)).toEqual(AGENTS.map((agent) => agent.id))
    expect(rows.every((row) => typeof row.supportTier === "string")).toBe(true)
    expect(rows.every((row) => typeof row.verification === "object")).toBe(true)
  })
})
