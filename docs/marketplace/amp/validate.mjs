#!/usr/bin/env node

import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(packageDir, "../../..")
const canonicalSkillsDir = path.join(repositoryRoot, "packages/agent-plugin/plugin/skills")
const toolSourcesDir = path.join(repositoryRoot, "packages/mcp/src")
const expectedTools = {
  "get-started": ["lyrashield_list_workspaces", "lyrashield_list_targets"],
  "review-changes": [
    "lyrashield_list_workspaces",
    "lyrashield_list_targets",
    "lyrashield_check_diff",
    "lyrashield_run_pr_scan",
  ],
  "scan-project": [
    "lyrashield_list_workspaces",
    "lyrashield_list_targets",
    "lyrashield_get_scan_eligibility",
    "lyrashield_scan_target",
    "lyrashield_run_pr_scan",
    "lyrashield_get_scan_status",
  ],
  "fix-and-retest": [
    "lyrashield_list_workspaces",
    "lyrashield_get_findings",
    "lyrashield_explain_finding",
    "lyrashield_generate_fix_plan",
    "lyrashield_record_fix_proposal",
    "lyrashield_verify_fix",
    "lyrashield_get_scan_status",
  ],
  "launch-readiness": [
    "lyrashield_list_workspaces",
    "lyrashield_list_targets",
    "lyrashield_get_launch_readiness",
  ],
}

const skillDirs = (await readdir(packageDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
assert.deepEqual(skillDirs, Object.keys(expectedTools).sort(), "unexpected Amp skill directories")

const readme = await readFile(path.join(packageDir, "README.md"), "utf8")
assert.match(readme, /amp skill add \/tmp\/lyrashield-marketplace\/amp/)
assert.match(readme, /amp skills list/)
assert.match(readme, /--global/)
assert.match(readme, /not yet confirmed in a released public/)
assert.match(readme, /https:\/\/ampcode\.com\/docs\/customize\/skills/)
assert.match(readme, /https:\/\/ampcode\.com\/docs\/customize\/mcp/)

const sourceSkillsAvailable = await readFile(
  path.join(canonicalSkillsDir, "get-started/SKILL.md"),
  "utf8"
)
  .then(() => true)
  .catch(() => false)
const toolSourcesAvailable = await readdir(toolSourcesDir)
  .then(() => true)
  .catch(() => false)
let liveToolNames = new Set()
if (toolSourcesAvailable) {
  const sourceNames = (await readdir(toolSourcesDir)).filter((file) =>
    /^tools-(core|workflow|attachments)\.ts$/.test(file)
  )
  const sourceText = await Promise.all(
    sourceNames.map((file) => readFile(path.join(toolSourcesDir, file), "utf8"))
  )
  liveToolNames = new Set(
    sourceText.flatMap((source) =>
      [...source.matchAll(/name:\s*"(lyrashield_[a-z0-9_]+)"/g)].map((match) => match[1])
    )
  )
}

for (const [skillName, expected] of Object.entries(expectedTools)) {
  const skillDir = path.join(packageDir, skillName)
  const skillText = await readFile(path.join(skillDir, "SKILL.md"), "utf8")
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert.ok(frontmatter, `${skillName}: missing YAML frontmatter`)
  assert.match(frontmatter[1], new RegExp(`^name: ${skillName}$`, "m"))
  assert.match(frontmatter[1], /^description:\s*.+$/m)
  const documentedTools = new Set(skillText.match(/lyrashield_[a-z0-9_]+/g) ?? [])
  for (const toolName of documentedTools) {
    assert.ok(expected.includes(toolName), `${skillName}: ${toolName} is absent from its allowlist`)
  }

  if (sourceSkillsAvailable) {
    const canonical = await readFile(path.join(canonicalSkillsDir, skillName, "SKILL.md"), "utf8")
    assert.equal(skillText, canonical, `${skillName}: drifted from canonical workflow`)
  }

  const configText = await readFile(path.join(skillDir, "mcp.json"), "utf8")
  assert.doesNotMatch(
    configText,
    /lsk_[A-Za-z0-9]{16,}|LYRASHIELD_API_KEY\s*[:=]|Authorization\s*:/
  )
  const config = JSON.parse(configText)
  assert.deepEqual(Object.keys(config), ["lyrashield"])
  assert.deepEqual(Object.keys(config.lyrashield).sort(), ["includeTools", "url"])
  assert.equal(config.lyrashield.url, "https://app.lyrashieldai.com/api/mcp")
  assert.deepEqual(config.lyrashield.includeTools, expected)
  assert.equal(new Set(expected).size, expected.length, `${skillName}: duplicate tool names`)
  if (toolSourcesAvailable) {
    for (const toolName of expected)
      assert.ok(liveToolNames.has(toolName), `${skillName}: unknown tool ${toolName}`)
  }
}

console.log(
  `Validated ${Object.keys(expectedTools).length} Amp skills and bundled MCP tool allowlists.`
)
