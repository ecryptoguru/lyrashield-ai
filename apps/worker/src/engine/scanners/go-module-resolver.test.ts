import { describe, expect, it, vi } from "vitest"
import {
  buildGoSandboxArgs,
  parseGoJsonStream,
  validateGoLocalPath,
  GO_RESOLVER_IMAGE,
  resolveGoModules,
} from "./go-module-resolver"
describe("isolated Go resolver boundaries", () => {
  it("pins execution and disables network, credentials, VCS, toolchain downloads and source execution", () => {
    const args = buildGoSandboxArgs({
      name: "test",
      input: "/tmp/input",
      proxy: "/tmp/proxy",
      directory: ".",
      command: ["go", "list", "-m", "-json", "all"],
    })
    expect(GO_RESOLVER_IMAGE).toMatch(/golang:1\.26\.8-alpine@sha256:[a-f0-9]{64}$/)
    for (const value of [
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pull=never",
      "GOTOOLCHAIN=local",
      "GOVCS=*:off",
      "GOPROXY=file:///proxy",
      "GOSUMDB=off",
      "GOPRIVATE=",
      "GOENV=off",
    ])
      expect(args).toContain(value)
    expect(args).toContain(`--user=${process.getuid!()}:${process.getuid!()}`)
    expect(args).not.toContain("--privileged")
    expect(args).not.toContain("GITHUB_TOKEN")
  })
  it("rejects escaping or absolute workspace and replacement paths", () => {
    for (const path of ["../../outside", "/etc", "C:\\secret", "../sibling"])
      expect(() => validateGoLocalPath(".", path, new Set(["go.mod"]))).toThrow()
    expect(validateGoLocalPath("app", "../lib", new Set(["lib/go.mod"]))).toBe("lib")
  })
  it("parses concatenated JSON with braces in strings and fails closed on trailing junk", () => {
    expect(parseGoJsonStream('{"Path":"a}b"}\n{"Path":"c"}')).toEqual([
      { Path: "a}b" },
      { Path: "c" },
    ])
    for (const input of [
      '{"Path":"a"} junk',
      '{"Path":',
      "[]",
      "",
      " ",
      "x".repeat(4 * 1024 * 1024 + 1),
    ])
      expect(() => parseGoJsonStream(input)).toThrow()
  })
  it("does not claim a go.sum is the selected graph", async () => {
    const result = await resolveGoModules(new Map([["go.sum", "example.org/a v1.0.0 h1:abc\n"]]))
    expect(result.packages).toEqual([])
    expect(result.unresolved.length).toBeGreaterThan(0)
  })
  it("rejects cancelled, expired, oversized and aliased inputs before execution", async () => {
    const controller = new AbortController()
    controller.abort()
    for (const [inputs, options] of [
      [new Map([["go.mod", "module example.org/root"]]), { signal: controller.signal }],
      [new Map([["go.mod", "module example.org/root"]]), { deadline: Date.now() - 1 }],
      [new Map([["go.mod", "x".repeat(512 * 1024 + 1)]]), {}],
      [new Map([["./go.mod", "module example.org/root"]]), {}],
    ] as const) {
      const result = await resolveGoModules(inputs, options)
      expect(result.receipt.status).toBe("UNSUPPORTED")
      expect(result.receipt.toolchain).toBeNull()
      expect(result.unresolved.length).toBeGreaterThan(0)
    }
  })
  it("refuses a root worker instead of broadening snapshot permissions", () => {
    const uid = vi.spyOn(process, "getuid").mockReturnValue(0)
    try {
      expect(() =>
        buildGoSandboxArgs({
          name: "test",
          input: "/tmp/input",
          proxy: "/tmp/proxy",
          directory: ".",
          command: ["go", "version"],
        })
      ).toThrow("non-root")
    } finally {
      uid.mockRestore()
    }
  })
})
