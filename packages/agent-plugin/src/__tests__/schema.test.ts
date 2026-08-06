import { describe, expect, it } from "vitest"
import { validatePlugin } from "../validate.js"
import { getPluginDir } from "../index.js"

describe("validatePlugin", () => {
  it("validates the built-in plugin directory", async () => {
    const result = await validatePlugin(getPluginDir())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})
