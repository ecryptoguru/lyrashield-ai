import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("WebMCP dashboard hardening headers", () => {
  it("keeps tools same-origin and enables origin isolation", () => {
    // Test-only path is fixed relative to this module.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const config = readFileSync(new URL("../../../next.config.ts", import.meta.url), "utf8")

    expect(config).toContain('key: "Permissions-Policy"')
    expect(config).toContain(
      'value: "tools=(self), camera=(), microphone=(), geolocation=(), browsing-topics=()"'
    )
    expect(config).not.toContain("tools=(*)")
    expect(config).toContain('{ key: "Origin-Agent-Cluster", value: "?1" }')
  })
})
