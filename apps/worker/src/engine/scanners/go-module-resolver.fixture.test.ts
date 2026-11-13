import { describe, expect, it } from "vitest"
import { GoMetadataBroker } from "./go-metadata-broker"
import { resolveGoModules } from "./go-module-resolver"
const fixtureMetadata: Record<string, string> = {
  "example.org/a/@v/v1.0.0.mod": "module example.org/a\ngo 1.20\nrequire example.org/b v1.0.0\n",
  "example.org/a/@v/v1.0.0.info": JSON.stringify({
    Version: "v1.0.0",
    Time: "2024-01-01T00:00:00Z",
  }),
  "example.org/b/@v/v1.0.0.mod": "module example.org/b\ngo 1.20\n",
  "example.org/b/@v/v1.1.0.mod": "module example.org/b\ngo 1.20\n",
  "example.org/b/@v/v1.1.0.info": JSON.stringify({
    Version: "v1.1.0",
    Time: "2024-01-01T00:00:00Z",
  }),
}
function fixtureBroker() {
  return new GoMetadataBroker(Date.now() + 90000, undefined, async (url) => {
    const path = url.replace("https://proxy.golang.org/", "")
    const html = fixtureMetadata[path] ?? "not found"
    return {
      ok: true,
      result: {
        html,
        status: path in fixtureMetadata ? 200 : 404,
        headers: {},
        bodyBytes: Buffer.byteLength(html),
        bodyTruncated: false,
        finalUrl: url,
        urlHistory: [url],
      },
    }
  })
}
describe.skipIf(process.env.RUN_GO_RESOLVER_FIXTURE !== "1")(
  "actual pinned offline Go container",
  () => {
    it("selects native MVS versions, respects excludes, ignores obsolete sums and records provenance", async () => {
      const result = await resolveGoModules(
        new Map([
          [
            "go.mod",
            `module example.org/root
go 1.20
require (
 example.org/a v1.0.0
 example.org/b v1.1.0
)
exclude example.org/b v1.0.0
`,
          ],
          [
            "go.sum",
            "example.org/obsolete v0.1.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
          ],
        ]),
        { broker: fixtureBroker() }
      )
      expect(result.unresolved).toEqual([])
      expect(result.packages.map((p) => [p.name, p.version])).toEqual([
        ["example.org/a", "v1.0.0"],
        ["example.org/b", "v1.1.0"],
      ])
      expect(result.receipt.status).toBe("COMPLETE")
      expect(result.receipt.metadata.length).toBeGreaterThan(0)
      expect(result.receipt.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    }, 90000)
    it("honors contained workspace modules and local replacements with honest partial status", async () => {
      const result = await resolveGoModules(
        new Map([
          ["go.work", "go 1.20\nuse (\n ./app\n ./lib\n)\n"],
          [
            "app/go.mod",
            "module example.org/app\ngo 1.20\nrequire example.org/a v1.0.0\nreplace example.org/a => ../lib\n",
          ],
          ["lib/go.mod", "module example.org/local\ngo 1.20\nrequire example.org/b v1.1.0\n"],
        ]),
        { broker: fixtureBroker() }
      )
      expect(result.packages).toEqual([
        expect.objectContaining({ name: "example.org/b", version: "v1.1.0" }),
      ])
      expect(result.unresolved).toEqual([
        expect.objectContaining({
          name: "example.org/a",
          reason: expect.stringContaining("local"),
        }),
      ])
      expect(result.receipt.status).toBe("PARTIAL")
    }, 90000)
    it("rejects escaping replacements, newer toolchains and private/unavailable modules", async () => {
      for (const content of [
        "module example.org/root\ngo 1.20\nrequire example.org/a v1.0.0\nreplace example.org/a => /etc\n",
        "module example.org/root\ngo 1.99\n",
        "module example.org/root\ngo 1.20\nrequire private.example/secret v1.0.0\n",
      ]) {
        const result = await resolveGoModules(new Map([["go.mod", content]]), {
          broker: fixtureBroker(),
        })
        expect(result.receipt.status).toBe("UNSUPPORTED")
        expect(result.packages).toEqual([])
        expect(result.unresolved.length).toBeGreaterThan(0)
      }
    }, 90000)
  }
)
it.skipIf(process.env.RUN_GO_RESOLVER_FIXTURE !== "1")(
  "rejects metadata that contradicts a retained go.sum checksum",
  async () => {
    const result = await resolveGoModules(
      new Map([
        ["go.mod", "module example.org/root\ngo 1.20\nrequire example.org/b v1.1.0\n"],
        ["go.sum", "example.org/b v1.1.0/go.mod h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"],
      ]),
      { broker: fixtureBroker() }
    )
    expect(result.receipt.toolchain).toBe("go1.26.8")
    expect(result.receipt.metadata.length).toBeGreaterThan(0)
    expect(result.receipt.status).toBe("UNSUPPORTED")
    expect(result.packages).toEqual([])
    expect(result.unresolved.length).toBeGreaterThan(0)
  },
  90000
)
