import { describe, expect, it } from "vitest"
import { z } from "zod"
import { isJsonObject, parseJson, parseJsonColumn } from "./json"

describe("JSON guards", () => {
  it("accepts objects but rejects arrays and null", () => {
    expect(isJsonObject({ key: "value" })).toBe(true)
    expect(isJsonObject([])).toBe(false)
    expect(isJsonObject(null)).toBe(false)
  })

  it("validates parsed text and stored JSON with the supplied schema", () => {
    const schema = z.object({ count: z.number().int() })
    expect(parseJson('{"count":2}', schema)).toEqual({ count: 2 })
    expect(parseJsonColumn(schema, { count: 2 })).toEqual({ count: 2 })
    expect(() => parseJson("not JSON", schema)).toThrow(SyntaxError)
    expect(() => parseJson('{"count":"2"}', schema)).toThrow(z.ZodError)
    expect(() => parseJsonColumn(schema, { count: "2" })).toThrow(z.ZodError)
  })
})
