import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const { parse } = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)("yaml")

function json(path) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository package manifests
  return JSON.parse(readFileSync(path, "utf8"))
}

function semver(value) {
  if (typeof value !== "string") return false
  const parts = value.split("-")[0].split(".")
  return parts.length === 3 && parts.every((part) => /^\d+$/.test(part))
}

test("CLI, MCP and Agent Plugin remain independently publishable package surfaces", () => {
  const expected = [
    ["packages/cli/package.json", "lyrashield"],
    ["packages/mcp/package.json", "@lyrashield/mcp"],
    ["packages/agent-plugin/package.json", "@lyrashield/agent-plugin"],
  ]
  for (const [path, name] of expected) {
    const manifest = json(path)
    assert.equal(manifest.name, name)
    assert.equal(semver(manifest.version), true)
    assert.equal(manifest.publishConfig.access, "public")
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
    assert.ok(manifest.bin || manifest.exports)
  }
  assert.equal(json("packages/mcp/package.json").mcpName, "io.github.ecryptoguru/lyrashield-ai")
})

test("GitHub Action matrix keeps local modes finite and the major tag mutable only for v2", () => {
  const action = parse(readFileSync("action.yml", "utf8"))
  assert.equal(action.inputs.scan_mode.default, "SAFE")
  assert.match(action.inputs.scan_mode.description, /SAFE.*AGGRESSIVE.*DEEP/)
  assert.equal(action.inputs.fail_on_severity.default, "HIGH")
  const versionWorkflow = readFileSync(".github/workflows/update-action-version.yml", "utf8")
  assert.match(versionWorkflow, /git tag -fa v2/)
  assert.match(versionWorkflow, /git push origin v2 --force/)
  assert.doesNotMatch(versionWorkflow, /tag -fa v1|push origin v1 --force/)
})
