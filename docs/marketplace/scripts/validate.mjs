import { access, lstat, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"))
}

async function exists(relative) {
  try {
    await access(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const manifest = await readJson("manifest.json")
assert(manifest.manifestSchemaVersion === "marketplace-export/2", "unsupported manifest schema")
assert(
  typeof manifest.sourceCommit === "string" && /^[a-f0-9]{40}$/i.test(manifest.sourceCommit),
  "manifest.sourceCommit must be a commit SHA"
)
assert(
  manifest.publication?.status === "unpublished" ||
    manifest.publication?.status === "release-candidate",
  "manifest.publication.status is invalid"
)
if (process.argv.includes("--release")) {
  assert(
    manifest.publication.status === "release-candidate",
    "release requires a release-candidate export"
  )
  assert(manifest.publication.sourceClean === true, "release requires clean source provenance")
}
if (process.env.GITHUB_REF?.startsWith("refs/tags/v")) {
  assert(
    process.env.GITHUB_REF === `refs/tags/v${manifest.version}`,
    "release tag version must match manifest.version"
  )
}
assert(Array.isArray(manifest.generatedFiles), "manifest.generatedFiles must be an array")
for (const relative of manifest.generatedFiles) {
  assert(await exists(relative), `missing generated artifact: ${relative}`)
}

async function exportedFiles(dir = root) {
  const files = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    if (dir === root && entry.name === ".git") continue
    const full = path.join(dir, entry.name)
    const relative = path.relative(root, full).split(path.sep).join("/")
    const stat = await lstat(full)
    if (stat.isSymbolicLink()) throw new Error(`symlink present in export: ${relative}`)
    if (stat.isDirectory()) files.push(...(await exportedFiles(full)))
    else if (stat.isFile() && relative !== "manifest.json") {
      files.push({
        path: relative,
        sha256: createHash("sha256")
          .update(await readFile(full))
          .digest("hex"),
        mode: stat.mode & 0o777,
      })
    } else if (!stat.isFile()) throw new Error(`unsupported entry in export: ${relative}`)
  }
  return files
}

assert(Array.isArray(manifest.files), "manifest.files must be an array")
const listedFiles = manifest.files
assert(
  listedFiles.every(
    (file) =>
      typeof file?.path === "string" &&
      /^[a-f0-9]{64}$/i.test(file.sha256) &&
      Number.isInteger(file.mode)
  ),
  "manifest.files contains an invalid entry"
)
const actualFiles = await exportedFiles()
assert(
  JSON.stringify(listedFiles) === JSON.stringify(actualFiles),
  "export file set or hash differs from manifest"
)

assert(!(await exists("plugin")), "portable plugin artifacts must live at the repository root")

// Enforce manifest.forbidden — none of the listed paths may be present anywhere
// (including nested) in the export. The generator is the only writer; this
// catches a hand-edited artifact or a mis-configured export that leaks private paths.
assert(Array.isArray(manifest.forbidden), "manifest.forbidden must be an array")
for (const forbidden of manifest.forbidden) {
  assert(!existsSync(path.join(root, forbidden)), `forbidden path present in export: ${forbidden}`)
}
// Nested forbidden: reject .env*, credential files, private keys, PEM/cert stores,
// provider tokens, or any file whose path contains a forbidden segment.
const NESTED_FORBIDDEN_BASENAME =
  /^\.env(\..*)?$|^credentials(\.json)?$|\.pem$|\.key$|\.p12$|\.pfx$|\.crt$|\.cert$/i
const NESTED_FORBIDDEN_SEGMENTS = manifest.forbidden.map((p) => p.replace(/^\//, "").split("/")[0])
async function scanForbidden(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    // Basename-level forbidden (covers nested .env*, *.pem, etc.)
    if (NESTED_FORBIDDEN_BASENAME.test(entry.name)) {
      throw new Error(`forbidden file present (nested): ${rel}`)
    }
    // Segment-level forbidden (e.g. apps/web nested anywhere)
    const segments = rel.split(path.sep)
    for (const seg of NESTED_FORBIDDEN_SEGMENTS) {
      if (segments.includes(seg)) throw new Error(`forbidden path present (nested): ${rel}`)
    }
    if (entry.isDirectory()) await scanForbidden(full)
  }
}
await scanForbidden(root)

// Scan tracked text files for leaked secrets. LyraShield keys (lsk_…) are the
// primary product credential, but the marketplace must also reject private
// keys, PEM blocks, and common provider token shapes. Placeholders are
// allowlisted so install guides can document the variables safely.
const KEY_PATTERN = /lsk_[A-Za-z0-9]{8,}/
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA )?PRIVATE KEY-----/
const PEM_PATTERN = /-----BEGIN (?:CERTIFICATE|PRIVATE KEY|PUBLIC KEY)-----/
const PROVIDER_TOKEN_PATTERN =
  /(?:gh[po]_|github[_]pat_|sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{20,})/
async function scanSecrets(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    if (entry.isDirectory()) {
      await scanSecrets(full)
    } else {
      const ext = path.extname(entry.name).toLowerCase()
      const textish = [
        ".md",
        ".json",
        ".ts",
        ".js",
        ".cjs",
        ".mjs",
        ".yml",
        ".yaml",
        ".toml",
        ".rs",
        ".jsonc",
        ".svg",
        ".lock",
        ".txt",
        "",
      ].includes(ext)
      if (!textish) continue
      const content = await readFile(full, "utf8")
      for (const [index, line] of content.split("\n").entries()) {
        const location = `${path.relative(root, full)}:${index + 1}`
        if (KEY_PATTERN.test(line))
          throw new Error(`real LyraShield API key detected at ${location}`)
        if (PRIVATE_KEY_PATTERN.test(line) || PEM_PATTERN.test(line))
          throw new Error(`private key/PEM detected at ${location}`)
        if (PROVIDER_TOKEN_PATTERN.test(line))
          throw new Error(`provider token detected at ${location}`)
      }
    }
  }
}
await scanSecrets(root)

const portableMcp = await readJson("mcp.json")
const claudeMcp = await readJson(".mcp.json")
const portableMcpServer = portableMcp.mcpServers?.lyrashield
assert(
  portableMcpServer?.type === "streamable-http",
  "portable mcp.json must use the Agent Plugins transport"
)
assert(
  portableMcpServer?.url === "https://app.lyrashieldai.com/api/mcp",
  "portable mcp.json has the wrong MCP URL"
)
assert(
  !("headers" in portableMcpServer),
  "portable mcp.json must allow hosted OAuth authentication"
)
const claudeMcpServer = claudeMcp.mcpServers?.lyrashield
assert(claudeMcpServer?.type === "http", ".mcp.json must use Claude Code's HTTP transport")
assert(
  claudeMcpServer?.url === "https://app.lyrashieldai.com/api/mcp",
  ".mcp.json has the wrong MCP URL"
)
assert(!("headers" in claudeMcpServer), ".mcp.json must allow hosted OAuth authentication")

const codexPlugin = await readJson(".codex-plugin/plugin.json")
const codexMcp = await readJson(".mcp.codex.json")
assert(
  codexPlugin.mcpServers === "./.mcp.codex.json",
  ".codex-plugin/plugin.json must reference the Codex-specific MCP descriptor"
)
assert(
  codexMcp.lyrashield?.url === "https://app.lyrashieldai.com/api/mcp",
  ".mcp.codex.json must contain a direct LyraShield server map"
)
assert(!("mcpServers" in codexMcp), ".mcp.codex.json must not use the Agent Plugins envelope")

const codexMarketplace = await readJson(".agents/plugins/marketplace.json")
const codexMarketplaceEntry = codexMarketplace.plugins?.find(
  (plugin) => plugin.name === "lyrashield"
)
assert(
  codexMarketplaceEntry?.source?.path === "./codex-plugin",
  "Codex marketplace must install the dedicated Codex plugin root"
)
assert(
  codexMarketplaceEntry?.policy?.installation === "AVAILABLE" &&
    codexMarketplaceEntry?.policy?.authentication === "ON_INSTALL",
  "Codex marketplace install policy is invalid"
)
const installedCodexManifest = await readJson("codex-plugin/.codex-plugin/plugin.json")
const installedCodexMcp = await readJson("codex-plugin/.mcp.json")
assert(
  installedCodexManifest.mcpServers === "./.mcp.json",
  "installed Codex manifest must reference its native MCP descriptor"
)
assert(
  installedCodexMcp.lyrashield?.type === "streamable-http" &&
    installedCodexMcp.lyrashield?.url === "https://app.lyrashieldai.com/api/mcp",
  "installed Codex MCP descriptor must use the native streamable-http transport"
)

// Cursor shim inlines MCP config — same invariants as root configs.
const cursorPlugin = await readJson(".cursor-plugin/plugin.json")
const cursorServer = cursorPlugin.mcpServers?.lyrashield
assert(cursorServer, ".cursor-plugin/plugin.json must declare the lyrashield MCP server")
assert(
  cursorServer.type === "http",
  ".cursor-plugin/plugin.json lyrashield server must use Streamable HTTP"
)
assert(
  cursorServer.url === "https://app.lyrashieldai.com/api/mcp",
  ".cursor-plugin/plugin.json lyrashield server has the wrong MCP URL"
)
assert(
  !("headers" in cursorServer),
  ".cursor-plugin/plugin.json must allow the hosted OAuth flow to authenticate"
)

const license = await readFile(path.join(root, "LICENSE"), "utf8")
assert(
  license.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"),
  "LICENSE must contain the complete Apache-2.0 terms"
)

const openclaw = await readFile(path.join(root, "openclaw", "SKILL.md"), "utf8")
assert(openclaw.includes("license: MIT-0"), "OpenClaw skill must declare MIT-0")
assert(
  (await readFile(path.join(root, "openclaw", "LICENSE"), "utf8")).includes("MIT No Attribution"),
  "OpenClaw MIT-0 license is missing"
)

const rootEntries = await readdir(root)
assert(rootEntries.includes("plugin.json"), "root plugin.json is missing")
assert(rootEntries.includes("skills"), "root skills directory is missing")

// Antigravity has a separate, strict manifest and MCP config from portable Agent Plugins.
const antigravityPlugin = await readJson("antigravity/plugin.json")
assert(
  antigravityPlugin.$schema === "https://antigravity.google/schemas/v1/plugin.json" &&
    antigravityPlugin.name === "lyrashield" &&
    typeof antigravityPlugin.description === "string" &&
    antigravityPlugin.description.length > 0 &&
    Object.keys(antigravityPlugin).sort().join(",") === "$schema,description,name",
  "Antigravity plugin.json must follow Google's native manifest schema"
)
const antigravityMcp = await readJson("antigravity/mcp_config.json")
const antigravityServer = antigravityMcp.mcpServers?.lyrashield
assert(
  antigravityServer?.serverUrl === "https://app.lyrashieldai.com/api/mcp" &&
    Object.keys(antigravityMcp.mcpServers ?? {}).join(",") === "lyrashield" &&
    Object.keys(antigravityServer).join(",") === "serverUrl",
  "Antigravity MCP config must use only the documented hosted serverUrl field"
)

const openCodeConfig = await readJson("opencode/opencode.json")
const openCodeServer = openCodeConfig.mcp?.lyrashield
assert(
  openCodeConfig.$schema === "https://opencode.ai/config.json" &&
    openCodeServer?.type === "remote" &&
    openCodeServer?.url === "https://app.lyrashieldai.com/api/mcp" &&
    openCodeServer?.oauth?.scope === "lyrashield.read" &&
    Object.keys(openCodeServer).sort().join(",") === "oauth,type,url",
  "OpenCode MCP config must use remote OAuth with the read-only scope"
)
const exportedSkills = (await readdir(path.join(root, "skills"))).sort()
assert(
  JSON.stringify((await readdir(path.join(root, "opencode", "skills"))).sort()) ===
    JSON.stringify(exportedSkills),
  "OpenCode skills must match the portable skill set"
)
for (const skill of exportedSkills) {
  assert(
    (await readFile(path.join(root, "opencode", "skills", skill, "SKILL.md"), "utf8")) ===
      (await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8")),
    `OpenCode ${skill} skill drifted from the portable skill`
  )
}

for (const skill of [
  "get-started",
  "review-changes",
  "scan-project",
  "fix-and-retest",
  "launch-readiness",
]) {
  const ampSkill = await readFile(path.join(root, "amp", skill, "SKILL.md"), "utf8")
  assert(
    ampSkill === (await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8")),
    `Amp ${skill} skill drifted from the portable skill`
  )
  const ampMcp = await readJson(`amp/${skill}/mcp.json`)
  const server = ampMcp.lyrashield
  assert(
    server?.url === "https://app.lyrashieldai.com/api/mcp" &&
      Array.isArray(server.includeTools) &&
      server.includeTools.length > 0 &&
      Object.keys(server).sort().join(",") === "includeTools,url",
    `Amp ${skill} MCP config must use a bounded hosted tool list`
  )
}

// The marketplace catalog is what makes this repository installable rather than merely
// readable: `/plugin marketplace add` and VS Code's "Install Plugin From Source" both
// resolve plugins through it. Keep it consistent with the root plugin manifest.
const marketplace = await readJson(".claude-plugin/marketplace.json")
const rootPlugin = await readJson("plugin.json")
assert(/^\d+\.\d+\.\d+$/.test(rootPlugin.version), "plugin version must be semver")
assert(manifest.version === rootPlugin.version, "manifest version must match plugin.json")
assert(
  manifest.generator?.version === rootPlugin.version,
  "generator version must match plugin.json"
)
for (const file of [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".kiro-plugin/plugin.json",
  "codex-plugin/.codex-plugin/plugin.json",
  "gemini-extension.json",
  "gemini-extension/gemini-extension.json",
]) {
  assert(
    (await readJson(file)).version === rootPlugin.version,
    `${file} version must match plugin.json`
  )
}
assert(
  codexMarketplaceEntry.version === rootPlugin.version,
  "Codex marketplace version must match plugin.json"
)
assert(
  (await readFile(path.join(root, "codex-plugin/skills/lyrashield/SKILL.md"), "utf8")) ===
    (await readFile(path.join(root, "skills/lyrashield/SKILL.md"), "utf8")),
  "installed Codex skill must match the root authorization contract"
)
assert(
  typeof marketplace.name === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(marketplace.name),
  "marketplace.name must be a non-empty kebab-case identifier"
)
assert(typeof marketplace.owner?.name === "string", "marketplace.owner.name is required")
assert(
  Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0,
  "marketplace.plugins must list at least one plugin"
)
const rootEntry = marketplace.plugins.find((entry) => entry.name === rootPlugin.name)
assert(rootEntry, `marketplace.plugins must list the root plugin (${rootPlugin.name})`)
assert(
  rootEntry.source === "./",
  'the root plugin entry must use source "./" so it resolves to the marketplace root'
)
assert(
  marketplace.version === rootPlugin.version && rootEntry.version === rootPlugin.version,
  "marketplace catalog versions must track plugin.json"
)

// Artifact versions recorded in the manifest must match each artifact's own
// source-of-truth file, so a version bump that skips the manifest fails here.
function parseVersion(text, pattern, label) {
  const match = text.match(pattern)
  assert(match?.[1], `could not parse ${label} version`)
  return match[1]
}

const versions = manifest.artifactVersions
assert(versions && typeof versions === "object", "manifest.artifactVersions is required")
for (const [artifact, [file, pattern, label]] of Object.entries({
  gemini: [
    "gemini-extension/gemini-extension.json",
    /"version"\s*:\s*"([^"]+)"/,
    "gemini-extension.json",
  ],
  zed: ["zed-extension/extension.toml", /^version\s*=\s*"([^"]+)"/m, "zed extension.toml"],
  codebuff: ["codebuff/lyrashield-review.ts", /^\s*version:\s*"([^"]+)"/m, "codebuff agent"],
  openclaw: ["openclaw/SKILL.md", /^version:\s*(\S+)\s*$/m, "openclaw SKILL.md"],
})) {
  const actual = parseVersion(await readFile(path.join(root, file), "utf8"), pattern, label)
  assert(actual === rootPlugin.version, `${artifact} version must track plugin.json`)
  assert(
    versions[artifact] === actual,
    `manifest.artifactVersions.${artifact} (${versions[artifact]}) must match ${label} (${actual})`
  )
}
assert(
  parseVersion(
    await readFile(path.join(root, "zed-extension/Cargo.toml"), "utf8"),
    /^version\s*=\s*"([^"]+)"/m,
    "zed Cargo.toml"
  ) === rootPlugin.version,
  "Zed Cargo version must match plugin.json"
)

// Explicit user-invoked scan workflows may call the two scan tools. All other
// mutating MCP operations stay excluded from the Gemini extension.
const allMutating = manifest.mutatingTools
const allowed = manifest.geminiAllowedMutatingTools
const excluded = manifest.geminiExcludedTools
assert(
  Array.isArray(allMutating) && allMutating.length > 0,
  "manifest.mutatingTools must be a non-empty array"
)
for (const name of allMutating) {
  assert(
    typeof name === "string" && name.startsWith("lyrashield_"),
    `unexpected tool name in manifest.mutatingTools: ${name}`
  )
}
assert(
  JSON.stringify(allowed) === JSON.stringify(["lyrashield_scan_target", "lyrashield_run_pr_scan"]),
  "manifest.geminiAllowedMutatingTools must contain only the supported scan operations"
)
assert(Array.isArray(excluded), "manifest.geminiExcludedTools must be an array")
assert(
  allMutating.length === allowed.length + excluded.length &&
    allMutating.every((name) => allowed.includes(name) !== excluded.includes(name)),
  "Gemini allow/exclude lists must partition all mutating MCP tools"
)
const geminiManifest = await readJson("gemini-extension/gemini-extension.json")
assert(
  JSON.stringify(geminiManifest.excludeTools) === JSON.stringify(excluded),
  "gemini-extension.json excludeTools must equal the manifest-recorded excluded tool set"
)
const rootGemini = await readJson("gemini-extension.json")
assert(
  JSON.stringify(rootGemini.excludeTools) === JSON.stringify(excluded),
  "root gemini-extension.json excludeTools must equal the manifest-recorded excluded tool set"
)

const expectedPackage = "@lyrashield/mcp@0.2.12"
const publishedMcpVerifier = await readFile(
  path.join(root, "scripts/verify-published-mcp.mjs"),
  "utf8"
)
assert(
  publishedMcpVerifier.includes('npm_config_ignore_scripts: "true"'),
  "published MCP runtime verification must disable npm lifecycle scripts"
)
assert(
  !publishedMcpVerifier.includes("...process.env") &&
    !/spawn\(\s*["']npx["']/.test(publishedMcpVerifier) &&
    publishedMcpVerifier.includes("await verifyStdio(process.execPath") &&
    publishedMcpVerifier.includes("verifyIntegrity(archive, metadata.dist?.integrity)") &&
    publishedMcpVerifier.includes("marketplace-stdio/1"),
  "published MCP verification must execute the verified local artifact with an isolated environment and required tool schemas"
)
assert(
  await exists("scripts/tests/verify-published-mcp.fixtures.mjs"),
  "published MCP verifier fixtures must be included in the export"
)
const kiro = (await readJson(".mcp.kiro.json")).mcpServers?.lyrashield
assert(
  kiro?.command === "npx" && JSON.stringify(kiro.args) === JSON.stringify(["-y", expectedPackage]),
  "Kiro executable pin differs"
)
const sharedSkillNames = [
  "lyrashield",
  "get-started",
  "review-changes",
  "scan-project",
  "fix-and-retest",
  "launch-readiness",
]
assert(
  JSON.stringify((await readdir(path.join(root, "antigravity", "skills"))).sort()) ===
    JSON.stringify([...sharedSkillNames].sort()),
  "Antigravity plugin must bundle exactly the shared LyraShield skills"
)
for (const skill of sharedSkillNames) {
  assert(
    (await readFile(path.join(root, "antigravity", "skills", skill, "SKILL.md"), "utf8")) ===
      (await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8")),
    `Antigravity skill ${skill} must match the canonical shared skill`
  )
}

// Kilo installs MCP companion skills by resolving each top-level `skills` ID
// to a published skill archive. Keep the source folders, frontmatter IDs, and
// MCP.yaml list in sync before the official packaging/generation step.
const kiloSkillEntries = await readdir(path.join(root, "kilo", "skills"), { withFileTypes: true })
assert(
  kiloSkillEntries.every((entry) => entry.isDirectory()),
  "Kilo skills root must contain skill directories only"
)
const kiloSkillNames = kiloSkillEntries.map((entry) => entry.name).sort()
assert(
  JSON.stringify(kiloSkillNames) === JSON.stringify([...sharedSkillNames].sort()),
  "Kilo must bundle exactly the shared LyraShield skills"
)
for (const skill of sharedSkillNames) {
  const kiloSkill = await readFile(path.join(root, "kilo", "skills", skill, "SKILL.md"), "utf8")
  const frontmatter = kiloSkill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  assert(frontmatter, `Kilo skill ${skill} must have YAML frontmatter`)
  const scalar = (value) => {
    const trimmed = value.trim()
    return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed
  }
  const rawName = frontmatter[1].match(/^name:\s*([^\r\n]+)\s*$/m)?.[1]
  const rawDescription = frontmatter[1].match(/^description:\s*(.+)\s*$/m)?.[1]
  const skillName = rawName ? scalar(rawName) : undefined
  const description = rawDescription ? scalar(rawDescription) : undefined
  assert(skillName === skill, `Kilo skill ${skill} frontmatter name must match its directory`)
  assert(description, `Kilo skill ${skill} must have a non-empty frontmatter description`)
  assert(
    kiloSkill === (await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8")),
    `Kilo skill ${skill} must match the canonical shared skill`
  )
}
const kiloMcpYaml = await readFile(
  path.join(root, "kilo", "mcps", "lyrashield", "MCP.yaml"),
  "utf8"
)
const kiloSkillsSections = kiloMcpYaml.match(/^skills:\s*$/gm) ?? []
assert(kiloSkillsSections.length === 1, "Kilo MCP.yaml must declare one top-level skills list")
const kiloSkillsStart = kiloMcpYaml.search(/^skills:\s*$/m)
const kiloSkillsIds = []
for (const line of kiloMcpYaml.slice(kiloSkillsStart).split(/\r?\n/).slice(1)) {
  if (!line.trim() || /^\s*#/.test(line)) continue
  if (!/^\s/.test(line)) break
  const item = line.match(/^  - ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/)
  assert(item, `invalid Kilo MCP.yaml skills entry: ${line}`)
  kiloSkillsIds.push(item[1])
}
assert(
  new Set(kiloSkillsIds).size === kiloSkillsIds.length &&
    JSON.stringify([...kiloSkillsIds].sort()) === JSON.stringify([...sharedSkillNames].sort()),
  "Kilo MCP.yaml skills list must match the bundled skill directories"
)
for (const file of [
  ".mcp.kiro.json",
  "gemini-extension.json",
  "gemini-extension/gemini-extension.json",
  "codebuff/lyrashield-review.ts",
  "zed-extension/src/lib.rs",
  "kilo/mcps/lyrashield/MCP.yaml",
]) {
  const text = await readFile(path.join(root, file), "utf8")
  assert(
    !text.includes("LYRASHIELD_API_URL"),
    `${file} must not override OAuth credential-store provenance`
  )
  if (file.endsWith(".rs")) {
    assert(
      text.includes('const PACKAGE_VERSION: &str = "0.2.12";'),
      "Zed must pin the published MCP version"
    )
    assert(!text.includes("npm_package_latest_version"), "Zed must not install a floating release")
  } else {
    assert(text.includes(expectedPackage), `${file} must pin the published MCP version`)
  }
}
assert(
  geminiManifest.settings[0].envVar === "GEMINI_LYRASHIELD_CRED",
  "Gemini setting must survive environment redaction"
)
assert(
  geminiManifest.mcpServers.lyrashield.env.LYRASHIELD_EXTENSION_CRED ===
    "${GEMINI_LYRASHIELD_CRED}",
  "Gemini must explicitly pass the optional extension credential"
)
assert(
  JSON.stringify(rootGemini.mcpServers) === JSON.stringify(geminiManifest.mcpServers),
  "Both Gemini entrypoints must use the same credential launcher"
)
assert(
  geminiManifest.mcpServers.lyrashield.args.includes(
    '--node-options=--require="${extensionPath}/mcp-env.cjs"'
  ),
  "Gemini must preload credential normalization before the pinned MCP server"
)
const credentialPreload = await readFile(path.join(root, "mcp-env.cjs"), "utf8")
for (const relative of ["gemini-extension/mcp-env.cjs", "zed-extension/mcp-env.cjs"]) {
  assert(
    (await readFile(path.join(root, relative), "utf8")) === credentialPreload,
    `${relative} must match the root credential preload`
  )
}
const zed = await readFile(path.join(root, "zed-extension/src/lib.rs"), "utf8")
assert(
  zed.includes('include_str!("../mcp-env.cjs")') &&
    zed.includes('"--eval".to_string()') &&
    zed.includes('const EXTENSION_CRED_ENV_VAR: &str = "LYRASHIELD_EXTENSION_CRED";'),
  "Zed must embed credential normalization before importing the MCP entrypoint"
)
for (const setting of [undefined, "", "  ", " demo-credential "]) {
  const env = {
    LYRASHIELD_API_URL: "http://untrusted.invalid",
    LYRASHIELD_API_KEY: "inherited-credential",
    LYRASHIELD_OAUTH_ACCESS_TOKEN: "inherited-token",
    ...(setting === undefined ? {} : { LYRASHIELD_EXTENSION_CRED: setting }),
  }
  runInNewContext(credentialPreload, { process: { env } })
  assert(!("LYRASHIELD_EXTENSION_CRED" in env), "Launcher must remove its temporary credential")
  assert(
    !("LYRASHIELD_OAUTH_ACCESS_TOKEN" in env),
    "Launcher must remove inherited OAuth overrides"
  )
  if (setting?.trim()) {
    assert(env.LYRASHIELD_API_KEY === "demo-credential", "Explicit API key must be preserved")
    assert(
      env.LYRASHIELD_API_URL === "https://app.lyrashieldai.com",
      "Explicit Cloud API key must use the canonical HTTPS origin"
    )
  } else {
    assert(!("LYRASHIELD_API_KEY" in env), "Empty credentials must not block stored OAuth")
    assert(
      env.LYRASHIELD_API_URL === "http://untrusted.invalid",
      "Stored OAuth must preserve an explicit API URL override"
    )
  }
}
const codebuff = await readFile(path.join(root, "codebuff/lyrashield-review.ts"), "utf8")
const { default: codebuffDefinition } = await import(
  pathToFileURL(path.join(root, "codebuff/lyrashield-review.ts")).href
)
assert(codebuffDefinition.version === rootPlugin.version, "Codebuff version must match plugin.json")
assert(
  JSON.stringify(codebuffDefinition.mcpServers?.lyrashield?.args) ===
    JSON.stringify(["-y", expectedPackage]),
  "Codebuff executable pin differs"
)
const codebuffTools = codebuffDefinition.toolNames ?? []
const expectedCodebuffMcpTools = [
  "lyrashield/lyrashield_get_findings",
  "lyrashield/lyrashield_get_launch_readiness",
  "lyrashield/lyrashield_list_workspaces",
  "lyrashield/lyrashield_list_targets",
  "lyrashield/lyrashield_get_scan_status",
  "lyrashield/lyrashield_get_scan_quality",
  "lyrashield/lyrashield_check_diff",
  "lyrashield/lyrashield_explain_finding",
  "lyrashield/lyrashield_generate_fix_plan",
  "lyrashield/lyrashield_create_pr_security_recap",
]
assert(
  JSON.stringify(codebuffTools.filter((name) => name.startsWith("lyrashield/"))) ===
    JSON.stringify(expectedCodebuffMcpTools),
  "Codebuff MCP tools must match the validated curated allowlist"
)
assert(
  !codebuffTools.includes("run_terminal_command") &&
    manifest.mutatingTools.every((name) => !codebuffTools.includes(`lyrashield/${name}`)) &&
    codebuffTools.some((name) => name.startsWith("lyrashield/")),
  "Codebuff must expose only the selected read-only MCP tools"
)
assert(
  !codebuff.includes("run_terminal_command"),
  "Read-only Codebuff agent must not run shell commands"
)
assert(
  codebuff.includes("env: apiKey ? { LYRASHIELD_API_KEY: apiKey } : {}"),
  "Codebuff must omit an absent API key so stored OAuth remains available"
)

// The approved authorization statement is validated as one sentence, and
// contradictory variants that reuse the same nouns (e.g. "not limited by
// connection permissions") must fail. Self-tested below so drift in either
// direction is caught, not just absence of the approved wording.
const CONTRADICTORY_BOUNDARY_PATTERNS = [
  /not\s+limited\s+by\s+connection\s+permissions/i,
  /without\s+connection\s+permissions/i,
  /regardless\s+of\s+connection\s+permissions/i,
  /bypass(?:es)?\s+connection\s+permissions/i,
]
function connectionBoundaryIsIntact(text) {
  const approved =
    text.includes("Authorized workflows execute within connection permissions") &&
    text.includes("pull requests never auto-merge")
  const contradicts = CONTRADICTORY_BOUNDARY_PATTERNS.some((pattern) => pattern.test(text))
  return approved && !contradicts
}
{
  const approved =
    "Fixes are proposals. Authorized workflows execute within connection permissions; pull requests never auto-merge."
  assert(connectionBoundaryIsIntact(approved), "self-test: approved statement must validate")
  const drift =
    "Fixes are proposals. Authorized workflows are not limited by connection permissions; pull requests never auto-merge."
  assert(
    !connectionBoundaryIsIntact(drift),
    "self-test: contradictory permission wording must fail validation"
  )
  const silentDrift = "Fixes are proposals. Workflows run regardless of connection permissions."
  assert(
    !connectionBoundaryIsIntact(silentDrift),
    "self-test: missing no-auto-merge boundary must fail validation"
  )
}
for (const file of [
  "skills/lyrashield/SKILL.md",
  "openclaw/SKILL.md",
  "kiro-power/POWER.md",
  "GEMINI.md",
]) {
  const requiredKiroSkills = [
    "lyrashield",
    "get-started",
    "review-changes",
    "scan-project",
    "fix-and-retest",
    "launch-readiness",
  ].map((name) => `kiro-power/skills/${name}/SKILL.md`)
  const contractFiles = file === "kiro-power/POWER.md" ? [file, ...requiredKiroSkills] : [file]
  const text = (
    await Promise.all(
      contractFiles.map((candidate) => readFile(path.join(root, candidate), "utf8"))
    )
  ).join("\n")
  assert(
    text.includes("lyrashield_check_diff") && text.includes("lyrashield_verify_fix"),
    `${file} must use canonical tools`
  )
  assert(
    connectionBoundaryIsIntact(text),
    `${file} must preserve connection authorization and the no-auto-merge boundary`
  )
}

const workflowSkills = [
  "get-started",
  "review-changes",
  "scan-project",
  "fix-and-retest",
  "launch-readiness",
]
const workflowSkillRoots = [
  "amp",
  "antigravity/skills",
  "augment/plugins/lyrashield/skills",
  "cline/skills",
  "devin-cli/skills",
  "devin-desktop/skills",
  "factory/plugins/lyrashield/skills",
  "gemini-extension/skills",
  "goose/skills",
  "hermes/skills",
  "jetbrains-ai-assistant/skills",
  "jetbrains-junie/skills",
  "kilo/skills",
  "kiro-power/skills",
  "lovable/skills",
  "mimo-code/skills",
  "mistral-vibe/skills",
  "oh-my-pi/skills",
  "opencode/skills",
  "qoder/plugins/lyrashield/skills",
  "qwen/skills",
  "replit/skills",
  "roo-code/skills",
  "v0/skills",
]
for (const skillRoot of workflowSkillRoots) {
  for (const skill of workflowSkills) {
    const canonical = await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8")
    const clientSkill = await readFile(
      path.join(root, skillRoot, skill, "SKILL.md"),
      "utf8"
    )
    assert(clientSkill === canonical, `${skillRoot}/${skill} must match the canonical workflow`)
  }
}

console.log(
  `Marketplace validation passed (${manifest.generatedFiles.length} generated artifacts).`
)
