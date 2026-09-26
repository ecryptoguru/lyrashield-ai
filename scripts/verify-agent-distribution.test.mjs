import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  EXPECTED_MCP_TOOLS,
  inspectTarball,
  parseArgs,
  validatePublishedManifest,
} from "./verify-agent-distribution.mjs"

const runFile = promisify(execFile)

let workDir

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "verify-agent-distribution-test-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

const goodManifest = {
  name: "lyrashield-fixture",
  version: "1.2.3",
  files: ["bin", "dist", "README.md"],
  bin: { "fixture-cli": "bin/fixture.mjs" },
  main: "./dist/index.js",
  dependencies: { minimist: "^1.2.8" },
}

/** Create a `package/` layout dir and tar it up like `pnpm pack` output. */
async function packFixture(files, manifest = goodManifest) {
  const src = path.join(workDir, "fixture-src")
  const pkg = path.join(src, "package")
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, "package.json"), JSON.stringify(manifest, null, 2))
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(pkg, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  const tarball = path.join(workDir, `fixture-${Math.random().toString(36).slice(2)}.tgz`)
  await runFile("tar", ["-czf", tarball, "-C", src, "package"])
  return tarball
}

const wellFormedFiles = {
  "bin/fixture.mjs": "#!/usr/bin/env node\nconsole.log('fixture')\n",
  "dist/index.js": "export const fixture = true\n",
  "README.md": "# fixture\n",
}

describe("validatePublishedManifest", () => {
  it("accepts a well-formed publishable manifest", () => {
    expect(() => validatePublishedManifest(goodManifest)).not.toThrow()
  })

  it("rejects non-object manifests", () => {
    // @ts-expect-error deliberately invalid input
    expect(() => validatePublishedManifest(null)).toThrow(/non-null object/)
    // @ts-expect-error deliberately invalid input
    expect(() => validatePublishedManifest("x")).toThrow(/non-null object/)
  })

  it("rejects workspace:/link:/file: dependency ranges", () => {
    for (const [field, dep, range] of [
      ["dependencies", "@lyrashield/agent-plugin", "workspace:^"],
      ["devDependencies", "@lyrashield/sdk", "workspace:*"],
      ["dependencies", "private-lib", "link:../private-lib"],
      ["dependencies", "private-lib", "file:../private-lib"],
    ]) {
      const manifest = structuredClone(goodManifest)
      manifest[field] = { [dep]: range }
      expect(() => validatePublishedManifest(manifest)).toThrow(
        new RegExp(`${dep}.*unresolved range`)
      )
    }
  })

  it("rejects missing name and missing/invalid version", () => {
    const noName = structuredClone(goodManifest)
    delete noName.name
    expect(() => validatePublishedManifest(noName)).toThrow(/name: required/)
    const badVersion = structuredClone(goodManifest)
    badVersion.version = "next"
    expect(() => validatePublishedManifest(badVersion)).toThrow(/version: required semver/)
  })

  it("rejects a scoped package without publishConfig.access", () => {
    const manifest = structuredClone(goodManifest)
    manifest.name = "@lyrashield/scoped-fixture"
    expect(() => validatePublishedManifest(manifest)).toThrow(/publishConfig\.access/)
    manifest.publishConfig = { access: "public" }
    expect(() => validatePublishedManifest(manifest)).not.toThrow()
  })

  it("rejects manifests with no entry point or no files allowlist", () => {
    const noEntry = structuredClone(goodManifest)
    delete noEntry.bin
    delete noEntry.main
    expect(() => validatePublishedManifest(noEntry)).toThrow(/entry point/)
    const noFiles = structuredClone(goodManifest)
    delete noFiles.files
    expect(() => validatePublishedManifest(noFiles)).toThrow(/files: required/)
  })

  it("rejects bin entries that escape the package", () => {
    const manifest = structuredClone(goodManifest)
    manifest.bin = { evil: "../outside.mjs" }
    expect(() => validatePublishedManifest(manifest)).toThrow(/bin\.evil/)
  })
})

describe("inspectTarball", () => {
  it("passes a well-formed fixture tarball", async () => {
    const tarball = await packFixture(wellFormedFiles)
    const receipt = await inspectTarball(tarball)
    expect(receipt.pass).toBe(true)
    expect(receipt.package).toBe("lyrashield-fixture")
    expect(receipt.version).toBe("1.2.3")
    expect(receipt.fileCount).toBe(4)
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.commands).toEqual({ "fixture-cli": "bin/fixture.mjs" })
    expect(receipt.checks.every((check) => check.ok)).toBe(true)
  })

  it("rejects a tarball missing the declared bin file", async () => {
    const files = { ...wellFormedFiles }
    delete files["bin/fixture.mjs"]
    const tarball = await packFixture(files)
    const receipt = await inspectTarball(tarball)
    expect(receipt.pass).toBe(false)
    const check = receipt.checks.find((item) => item.id === "declared-artifacts")
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/bin\/fixture\.mjs/)
  })

  it("rejects forbidden paths (.env, credentials.json, node_modules)", async () => {
    const tarball = await packFixture({
      ...wellFormedFiles,
      ".env": "LYRASHIELD_API_KEY=lsk_aaaaaaaaaaaaaaaaaaaaaaaa\n",
      "dist/node_modules/leftpad/index.js": "module.exports = 1\n",
      "credentials.json": "{}\n",
    })
    const receipt = await inspectTarball(tarball)
    expect(receipt.pass).toBe(false)
    const check = receipt.checks.find((item) => item.id === "forbidden-paths")
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/\.env/)
    expect(check.detail).toMatch(/credentials\.json/)
    // ...and the embedded secret is caught by content scan as well
    const secrets = receipt.checks.find((item) => item.id === "secret-material")
    expect(secrets.ok).toBe(false)
  })

  it("rejects private-source paths and lsk_/private-key content", async () => {
    const tarball = await packFixture({
      ...wellFormedFiles,
      "packages/db/schema.prisma": "model User { id String }\n",
      "dist/leak.js": "const k = 'lsk_0123456789abcdef0123456789'\n",
    })
    const receipt = await inspectTarball(tarball)
    expect(receipt.pass).toBe(false)
    const forbidden = receipt.checks.find((item) => item.id === "forbidden-paths")
    expect(forbidden.ok).toBe(false)
    expect(forbidden.detail).toMatch(/packages\/db/)
    const secrets = receipt.checks.find((item) => item.id === "secret-material")
    expect(secrets.ok).toBe(false)
    expect(secrets.detail).toMatch(/lyrashield-api-key|private-key/)
  })

  it("rejects a tarball whose package.json declares workspace deps", async () => {
    const manifest = structuredClone(goodManifest)
    manifest.dependencies["@lyrashield/agent-plugin"] = "workspace:^"
    const tarball = await packFixture(wellFormedFiles, manifest)
    const receipt = await inspectTarball(tarball)
    expect(receipt.pass).toBe(false)
    const check = receipt.checks.find((item) => item.id === "manifest-publishable")
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/workspace:/)
  })

  it("fails cleanly on a missing tarball and on an archive without package.json", async () => {
    const missing = await inspectTarball(path.join(workDir, "nope.tgz"))
    expect(missing.pass).toBe(false)
    expect(missing.checks[0].id).toBe("archive-readable")

    const src = path.join(workDir, "empty-src")
    await mkdir(path.join(src, "package"), { recursive: true })
    const tarball = path.join(workDir, "no-manifest.tgz")
    await runFile("tar", ["-czf", tarball, "-C", src, "package"])
    const receipt = await inspectTarball(tarball)
    expect(receipt.pass).toBe(false)
    expect(
      receipt.checks.find((item) => item.id === "manifest-present")?.ok
    ).toBe(false)
  })
})

describe("parseArgs (smoke CLI plumbing, no subprocesses)", () => {
  it("parses repeated --tarball, --smoke, --json, --repo and --timeout", () => {
    const options = parseArgs([
      "--tarball",
      "a.tgz",
      "--tarball=b.tgz",
      "--smoke",
      "--json",
      "--repo",
      "packages/cli",
      "--timeout",
      "5000",
    ])
    expect(options.tarballs).toEqual(["a.tgz", "b.tgz"])
    expect(options.smoke).toBe(true)
    expect(options.json).toBe(true)
    expect(options.install).toBe(true)
    expect(options.repoDir).toBe(path.resolve("packages/cli"))
    expect(options.timeoutMs).toBe(5000)
  })

  it("honours --no-install and defaults to offline-safe values", () => {
    const options = parseArgs(["--tarball", "a.tgz", "--no-install"])
    expect(options.install).toBe(false)
    expect(options.smoke).toBe(false)
    expect(options.json).toBe(false)
    expect(options.timeoutMs).toBeGreaterThan(0)
  })

  it("rejects unknown arguments and missing values", () => {
    expect(() => parseArgs(["--publish"])).toThrow(/unknown argument/)
    expect(() => parseArgs(["--tarball"])).toThrow(/requires a value/)
    expect(() => parseArgs(["--timeout", "abc"])).toThrow(/positive number/)
  })
})

describe("EXPECTED_MCP_TOOLS", () => {
  it("covers the 15 published tool names documented in the MCP README", () => {
    expect(EXPECTED_MCP_TOOLS).toHaveLength(15)
    expect(new Set(EXPECTED_MCP_TOOLS).size).toBe(15)
    for (const name of EXPECTED_MCP_TOOLS) expect(name).toMatch(/^lyrashield_/)
    // The README tool table is the documented contract; every advertised tool
    // must appear in it (packages/mcp/src/readme-table.test.ts covers the
    // reverse direction against MCP_TOOL_ANNOTATIONS).
    const readme = readFileSync(
      fileURLToPath(new URL("../packages/mcp/README.md", import.meta.url)),
      "utf8"
    )
    for (const name of EXPECTED_MCP_TOOLS) {
      expect(readme).toContain(`\`${name}\``)
    }
  })
})
