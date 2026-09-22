/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { MCP_TOOL_ANNOTATIONS } from "./tools"

describe("README tool table", () => {
  it("documents every registered tool exactly once", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")
    const documented = [...readme.matchAll(/^\|\s*`(lyrashield_\w+)`/gm)].map((match) => match[1])
    const registered = Object.keys(MCP_TOOL_ANNOTATIONS)
    expect(documented.sort()).toEqual(registered.sort())
  })
})
