import { describe, expect, it } from "vitest"
import {
  nativeEngineResultChunkSchema,
  nativeEngineResultInputSchema,
} from "./native-engine-result"
const result = {
  kind: "available",
  operationId: "operation-1",
  attemptId: "attempt-1",
  sha256: `sha256:${"a".repeat(64)}`,
  totalBytes: 3,
  offset: 0,
  base64: "YWJj",
  eof: true,
}
describe("bounded native engine result envelope", () => {
  it("accepts canonical exact chunks and truthful pending state", () => {
    expect(nativeEngineResultChunkSchema.parse(result)).toEqual(result)
    expect(
      nativeEngineResultChunkSchema.parse({
        kind: "pending",
        operationId: result.operationId,
        attemptId: result.attemptId,
      }).kind
    ).toBe("pending")
  })
  it.each([
    { ...result, base64: "YWJj " },
    { ...result, base64: "@@@" },
    { ...result, eof: false },
    { ...result, totalBytes: 2 },
    { ...result, offset: -1 },
    { ...result, offset: 1 },
    { ...result, totalBytes: 97 * 1024 * 1024 },
    { ...result, base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") },
    { ...result, path: "/private" },
  ])("rejects malformed, oversized and contradictory chunks", (value) => {
    expect(() => nativeEngineResultChunkSchema.parse(value)).toThrow()
  })
  it("permits only fixed ownership selection inputs", () => {
    expect(() =>
      nativeEngineResultInputSchema.parse({
        operationId: "operation-1",
        attemptId: "attempt-1",
        offset: 0,
        ownership: "caller",
      })
    ).toThrow()
  })
})
