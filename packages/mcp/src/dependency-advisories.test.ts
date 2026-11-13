import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Resolve through the SDK and Express, matching the dependencies actually used
// by the packaged MCP and CLI consumers rather than an unrelated top-level copy.
const localRequire = createRequire(import.meta.url)
const sdkRequire = createRequire(localRequire.resolve("@modelcontextprotocol/sdk/server/index.js"))

describe("MCP transitive dependency security regressions", () => {
  it("does not serve a protected static file after a second URI decode", async () => {
    const { Hono } = sdkRequire("hono") as {
      Hono: new () => {
        use: (path: string, middleware: unknown) => void
        request: (url: string) => Promise<Response>
      }
    }
    const { serveStatic } = sdkRequire("@hono/node-server/serve-static") as {
      serveStatic: (options: { root: string }) => unknown
    }
    const root = mkdtempSync(join(tmpdir(), "lyrashield-hono-regression-"))
    try {
      mkdirSync(join(root, "static", "admin"), { recursive: true })
      writeFileSync(join(root, "static", "admin", "secret.txt"), "restricted")
      writeFileSync(join(root, "static", "hello world.txt"), "public")
      const app = new Hono()
      app.use("/static/admin/*", (c: { text: (body: string, status: number) => Response }) =>
        c.text("unauthorized", 401)
      )
      app.use("/static/*", serveStatic({ root }))

      expect((await app.request("http://localhost/static/admin/secret.txt")).status).toBe(401)
      const crafted = await app.request("http://localhost/static/%%36%31dmin/secret.txt")
      expect(crafted.status).toBe(404)
      expect(await crafted.text()).not.toContain("restricted")
      const publicFile = await app.request("http://localhost/static/hello%20world.txt")
      expect(publicFile.status).toBe(200)
      expect(await publicFile.text()).toBe("public")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("stringifies hostile array elements without throwing for either comma encoding path", () => {
    const expressRequire = createRequire(sdkRequire.resolve("express"))
    const qs = expressRequire("qs") as {
      stringify: (
        value: unknown,
        options: { arrayFormat: "comma"; encodeValuesOnly?: boolean }
      ) => string
    }
    const value = JSON.parse('{"a":[{"toString":"x"}]}') as Record<string, unknown>
    for (const encodeValuesOnly of [false, true]) {
      expect(() => qs.stringify(value, { arrayFormat: "comma", encodeValuesOnly })).not.toThrow()
    }
    expect(qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" })).toBe("a=one%2Ctwo")
  })
})
