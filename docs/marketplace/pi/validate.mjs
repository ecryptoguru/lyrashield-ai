import assert from "node:assert/strict"
import { lstat, readFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const piDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(piDir, "../../..")
const canonicalSkills = resolve(repoRoot, "packages/agent-plugin/plugin/skills")
const expectedSkills = [
  "fix-and-retest",
  "get-started",
  "launch-readiness",
  "review-changes",
  "scan-project",
]

async function read(path) {
  return readFile(resolve(piDir, path), "utf8")
}

async function main() {
  assert.deepEqual(
    (await readdir(piDir)).sort(),
    ["README.md", "mcp.json", "validate.mjs"],
    "keep this adapter limited to Pi-specific documentation, MCP example, and validator"
  )

  const readme = (await read("README.md")).replace(/\s+/g, " ").toLowerCase()
  for (const phrase of [
    "preparation",
    "no pi catalog listing",
    "no pi catalog listing or authenticated pi runtime acceptance",
    "pi install git:github.com/ecryptoguru/lyrashield-marketplace@<released-tag>",
    "project trust is granted",
    "does not create or publish a new npm package",
    "unpublished",
    "lyrashield@0.2.14",
    "@lyrashield/mcp@0.2.12",
    "do not pair the new workflow skills with the older published mcp `0.2.11`",
    "legacy `lyrashield` skill",
    "https://pi.dev/docs/latest/packages",
    "https://pi.dev/docs/latest/skills",
    "https://pi.dev/docs/latest/mcp",
    ...expectedSkills,
  ]) {
    assert.ok(readme.includes(phrase), "README.md must document " + phrase)
  }

  const marketplaceGuide = await readFile(resolve(repoRoot, "docs/marketplace/README.md"), "utf8")
  assert.match(marketplaceGuide, /root `plugin\.json`, `mcp\.json`, `skills\/`/)

  const config = JSON.parse(await read("mcp.json"))
  assert.deepEqual(Object.keys(config), ["mcpServers"])
  assert.deepEqual(Object.keys(config.mcpServers), ["lyrashield"])
  assert.deepEqual(Object.keys(config.mcpServers.lyrashield).sort(), ["description", "url"])
  assert.equal(config.mcpServers.lyrashield.url, "https://app.lyrashieldai.com/api/mcp")
  assert.match(config.mcpServers.lyrashield.description, /^LyraShield\b/)
  assert.doesNotMatch(
    JSON.stringify(config),
    /lsk_[A-Za-z0-9]{16,}/,
    "MCP example must not contain credentials"
  )
  assert.doesNotMatch(
    JSON.stringify(config),
    /authorization|bearer|api[_-]?key/i,
    "MCP example must not include static authentication"
  )

  for (const name of [...expectedSkills, "lyrashield"]) {
    const path = resolve(canonicalSkills, name, "SKILL.md")
    const stat = await lstat(path)
    assert.equal(stat.isFile(), true, name + " canonical source must be a regular SKILL.md")
    assert.equal(stat.isSymbolicLink(), false, name + " canonical source must not be a symlink")
    const content = await readFile(path, "utf8")
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    assert.ok(frontmatter, name + " canonical skill needs YAML frontmatter")
    assert.match(frontmatter[1], new RegExp("^name: " + name + "$", "m"))
    const description = frontmatter[1].match(/^description:\s*"?([^\r\n"]+)"?\s*$/m)?.[1]
    assert.ok(description?.trim(), name + " canonical skill needs a description")
    assert.ok(description.length <= 1024, name + " skill description exceeds Pi's limit")
    assert.doesNotMatch(
      content,
      /lsk_[A-Za-z0-9]{16,}/,
      name + " canonical skill must not contain credentials"
    )
  }

  console.log(
    "Pi preparation valid: secret-free MCP example, five focused skills, and legacy skill; release, catalog, and runtime remain unverified."
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
