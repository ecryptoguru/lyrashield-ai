import { describe, expect, it } from "vitest"
import packageJson from "../package.json"
import { SERVER_VERSION } from "./create-server"

describe("package metadata", () => {
  it("keeps runtime metadata and packaged conformance docs aligned", () => {
    expect(SERVER_VERSION).toBe(packageJson.version)
    expect(packageJson.mcpName).toBe("io.github.ecryptoguru/lyrashield-ai")
    expect(packageJson.files).toContain("docs")
  })
})
