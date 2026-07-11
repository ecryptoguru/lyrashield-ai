import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

describe("MCP stdio transport", () => {
  it("reads tool inputs from the standard arguments field", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL("./stdio-transport.ts", import.meta.url), "utf8")
    expect(source).toContain("params?.arguments")
    expect(source).not.toContain("params?.args")
  })
})
