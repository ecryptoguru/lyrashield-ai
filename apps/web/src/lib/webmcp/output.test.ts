import { describe, expect, it } from "vitest"
import {
  WEBMCP_BUDGETS,
  boundOutputValue,
  buildObjectSchema,
  enforceParamDescription,
  enforceToolDescription,
  enforceToolName,
  enforceToolTitle,
  wrapToolError,
  wrapToolOutput,
} from "./output"

describe("WebMCP output budgets", () => {
  it("enforces tool name budget", () => {
    const long = "a".repeat(WEBMCP_BUDGETS.toolName + 50)
    const bounded = enforceToolName(long)
    expect(bounded.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolName)
    expect(bounded).toMatch(/a+…$/)
  })

  it("rejects an empty tool name", () => {
    expect(() => enforceToolName("   ")).toThrow("must not be empty")
  })

  it("enforces tool description budget", () => {
    const long = "b".repeat(WEBMCP_BUDGETS.toolDescription + 50)
    const bounded = enforceToolDescription(long)
    expect(bounded.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolDescription)
  })

  it("enforces tool title budget", () => {
    const long = "c".repeat(WEBMCP_BUDGETS.toolTitle + 50)
    expect(enforceToolTitle(long).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolTitle)
  })

  it("enforces parameter description budget", () => {
    const long = "d".repeat(WEBMCP_BUDGETS.paramDescription + 50)
    expect(enforceParamDescription(long).length).toBeLessThanOrEqual(
      WEBMCP_BUDGETS.paramDescription
    )
  })

  it("bounds tool output to the output budget", () => {
    const large = {
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: "x".repeat(20) })),
    }
    const bounded = boundOutputValue(large)
    if (typeof bounded === "object" && bounded !== null && "truncated" in bounded) {
      expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)
      expect(bounded.truncated).toBe(true)
      expect(bounded.summary.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)
    } else {
      expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)
    }
  })

  it("keeps small outputs intact", () => {
    const value = { ok: true, count: 3 }
    expect(boundOutputValue(value)).toEqual(value)
  })

  it("trims long strings and leaves primitives alone", () => {
    const str = "x".repeat(WEBMCP_BUDGETS.output + 100)
    const result = boundOutputValue(str)
    expect(typeof result).toBe("string")
    expect(result.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)
  })

  it("bounds serialized strings containing escaped characters", () => {
    const result = boundOutputValue('\\"'.repeat(WEBMCP_BUDGETS.output))
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)
  })

  it("wraps output and errors within budget", () => {
    const out = wrapToolOutput({ a: "value".repeat(300) })
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)

    const err = wrapToolError("a".repeat(2_000))
    expect(err.ok).toBe(false)
    expect(JSON.stringify(err).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.output)
  })

  it("builds an object schema with bounded parameter descriptions", () => {
    const schema = buildObjectSchema({
      description: "A test tool",
      properties: {
        query: {
          type: "string",
          description:
            "A very long parameter description that should be trimmed down to the budget.",
        },
      },
      required: ["query"],
    })
    expect(schema.type).toBe("object")
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.query.description?.length).toBeLessThanOrEqual(
      WEBMCP_BUDGETS.paramDescription
    )
  })
})
