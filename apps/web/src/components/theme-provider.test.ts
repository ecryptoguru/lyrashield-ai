import { afterEach, describe, expect, it, vi } from "vitest"
import { getThemePreference } from "./theme-provider"

afterEach(() => vi.unstubAllGlobals())

describe("getThemePreference", () => {
  it("prefers the shared parent-domain preference over this origin's local storage", () => {
    vi.stubGlobal("document", { cookie: "lyrashield-theme=light" })
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "dark" },
    })

    expect(getThemePreference()).toBe("light")
  })
})
