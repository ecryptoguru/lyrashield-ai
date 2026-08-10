import { describe, expect, it } from "vitest"
import { resourcesMatch } from "./oauth-resource"

describe("resourcesMatch", () => {
  const expected = "https://app.example.com/api/mcp"

  it("accepts legacy tokens without an explicit resource", () => {
    expect(resourcesMatch(undefined, expected)).toBe(true)
  })

  it("accepts only the configured protected resource", () => {
    expect(resourcesMatch([expected], expected)).toBe(true)
    expect(resourcesMatch([expected, expected], expected)).toBe(true)
  })

  it("rejects tokens that include another resource", () => {
    expect(resourcesMatch([expected, "https://attacker.example/api"], expected)).toBe(false)
  })
})
