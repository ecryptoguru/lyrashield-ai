import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const header = readFileSync(new URL("../components/Header.astro", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const base = readFileSync(new URL("../layouts/Base.astro", import.meta.url), "utf8")

describe("marketing theme preference", () => {
  it("shares the app preference key and truthful system-light-dark controls", () => {
    expect(base).toContain('localStorage.getItem("lyrashield-theme")')
    expect(header).toContain('const preferences = ["system", "light", "dark"] as const')
    expect(header).toContain('data-theme-icon="system"')
    expect(header).toContain('data-theme-icon="light"')
    expect(header).toContain('data-theme-icon="dark"')
    expect(header).toContain('button?.setAttribute("aria-label"')
    expect(header).toContain('button?.setAttribute("title"')
  })

  it("updates system, cross-tab, and browser chrome state", () => {
    expect(header).toContain('systemTheme.addEventListener("change"')
    expect(header).toContain('addEventListener("storage"')
    expect(header).toContain("meta[data-theme-color]")
    expect(base).toContain("meta[data-theme-color]")
  })
})
