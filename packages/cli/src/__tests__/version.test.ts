/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { CLI_VERSION } from "../version.js"

describe("CLI version", () => {
  it("uses one 0.2.0 version across runtime and package metadata", async () => {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url))
    const packageJson = JSON.parse(await readFile(packagePath, "utf-8")) as {
      version: string
      engines: { node: string }
    }

    expect(CLI_VERSION).toBe("0.2.0")
    expect(packageJson.version).toBe(CLI_VERSION)
    expect(packageJson.engines.node).toBe(">=22.0.0 <25.0.0")
  })
})
