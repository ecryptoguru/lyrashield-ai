#!/usr/bin/env node
/**
 * Verify LyraShield agent-distribution tarballs before publication.
 *
 * Given one or more `pnpm pack`/`npm pack` tarballs this tool produces a
 * per-package receipt: identity, file count, bin/tool inventory, the checks
 * performed, and an overall PASS/FAIL. It never publishes, never installs into
 * a real agent config, and never needs credentials or the network. The opt-in
 * `--smoke` step extracts each tarball to a temp dir and runs the packed
 * artifact itself (CLI `--version`/`--help`, or a real MCP `initialize` +
 * `tools/list` stdio handshake for `@lyrashield/mcp`) with `HOME` redirected to
 * the temp dir, a synthetic `LYRASHIELD_API_KEY` and an unroutable
 * `LYRASHIELD_API_URL`, so no real credential or API is ever touched.
 *
 * Smoke dependency resolution is offline-first: each declared dependency is
 * linked from another tarball under test, a workspace package with the same
 * name, or a `node_modules` directory reachable from `--repo`. Only when a
 * dependency cannot be linked does it fall back to a bounded
 * `npm install --omit=dev` (disable with `--no-install`).
 *
 * Usage:
 *   node scripts/verify-agent-distribution.mjs \
 *     --tarball lyrashield-0.2.12.tgz [--tarball lyrashield-mcp-0.2.9.tgz] \
 *     [--smoke] [--json] [--repo <dir>] [--timeout <ms>]
 */

import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const UNRESOLVED_RANGE_RE = /^(workspace|link|file|portal):/i
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const INSTALL_TIMEOUT_MS = 120_000

/**
 * MCP tools the packed `@lyrashield/mcp` stdio server must advertise. Mirrors
 * `MCP_TOOL_ANNOTATIONS` keys in packages/mcp/src/tools.ts; kept as a literal
 * so the receipt asserts the published catalog, not whatever a build emits.
 */
export const EXPECTED_MCP_TOOLS = [
  "lyrashield_check_diff",
  "lyrashield_create_pr_security_recap",
  "lyrashield_create_report",
  "lyrashield_explain_finding",
  "lyrashield_generate_fix_plan",
  "lyrashield_get_findings",
  "lyrashield_get_launch_readiness",
  "lyrashield_get_scan_quality",
  "lyrashield_get_scan_status",
  "lyrashield_list_targets",
  "lyrashield_list_workspaces",
  "lyrashield_record_fix_proposal",
  "lyrashield_run_pr_scan",
  "lyrashield_scan_target",
  "lyrashield_verify_fix",
]

function binEntries(manifest) {
  const bin = manifest?.bin
  if (typeof bin === "string" && bin.trim()) {
    return { [typeof manifest.name === "string" ? manifest.name : "bin"]: bin.trim() }
  }
  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    const entries = {}
    for (const [command, target] of Object.entries(bin)) {
      if (typeof target === "string" && target.trim()) entries[command] = target.trim()
    }
    return entries
  }
  return {}
}

function exportTargets(exportsField) {
  const targets = []
  const visit = (value) => {
    if (typeof value === "string") {
      const target = value.startsWith("./") ? value.slice(2) : value
      if (target && !target.includes("*")) targets.push(target)
      return
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of Object.values(value)) visit(nested)
    }
  }
  visit(exportsField)
  return targets
}

/**
 * Synchronous publishability gate for a package.json manifest.
 * Returns normally when the manifest is publishable; throws one bounded,
 * actionable Error listing every violation otherwise.
 */
export function validatePublishedManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a non-null object")
  }
  const errors = []
  const name = typeof manifest.name === "string" ? manifest.name.trim() : ""
  if (!name) {
    errors.push("name: required non-empty package name")
  }
  if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version.trim())) {
    errors.push(
      `version: required semver string (got ${JSON.stringify(manifest.version ?? null)})`
    )
  }
  if (name.startsWith("@")) {
    const access = manifest.publishConfig?.access
    if (typeof access !== "string" || !access.trim()) {
      errors.push(
        `publishConfig.access: required for scoped package ${name} (e.g. { "access": "public" })`
      )
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field]
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range !== "string" || !range.trim()) {
        errors.push(`${field}.${dep}: empty version range`)
        continue
      }
      if (UNRESOLVED_RANGE_RE.test(range.trim())) {
        errors.push(
          `${field}.${dep}: unresolved range ${JSON.stringify(range)} — pack/publish with pnpm so workspace protocols resolve to semver, or remove the private dependency`
        )
      }
    }
  }
  const bin = binEntries(manifest)
  if (manifest.bin !== undefined && Object.keys(bin).length === 0) {
    errors.push("bin: declared but has no usable command entries")
  }
  for (const [command, target] of Object.entries(bin)) {
    if (target.startsWith("/") || target.split("/").includes("..")) {
      errors.push(`bin.${command}: target ${JSON.stringify(target)} must stay inside the package`)
    }
  }
  const hasMain = typeof manifest.main === "string" && manifest.main.trim().length > 0
  const hasExports = exportTargets(manifest.exports).length > 0
  if (Object.keys(bin).length === 0 && !hasMain && !hasExports) {
    errors.push("entry point: declare at least one of bin, main or exports")
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push(
      "files: required non-empty allowlist so the published tarball contents stay reviewable"
    )
  } else {
    for (const entry of manifest.files) {
      if (typeof entry !== "string" || !entry.trim()) {
        errors.push("files: every entry must be a non-empty path")
        break
      }
    }
  }
  if (errors.length) {
    const label = name ? ` for ${name}` : ""
    throw new Error(
      `Publish manifest validation failed${label}:\n${errors.map((e) => ` - ${e}`).join("\n")}`
    )
  }
}

/** Paths that must never appear inside a published artifact. */
function forbiddenPathReason(entry) {
  const segments = entry.split("/").filter(Boolean)
  for (const segment of segments) {
    if (segment === ".env" || segment.startsWith(".env.")) return ".env file"
    if (segment === ".git") return ".git metadata"
    if (segment === "node_modules") return "node_modules content"
    if (segment === "credentials.json") return "credentials.json"
  }
  if (segments[0] === "apps" && segments[1] === "web") return "apps/web private source"
  if (segments[0] === "packages" && segments[1] === "db") return "packages/db private source"
  return undefined
}

const SECRET_PATTERNS = [
  { id: "private-key", re: /BEGIN [A-Z0-9 ]*PRIVATE KEY/ },
  { id: "lyrashield-api-key", re: /\blsk_[A-Za-z0-9]{16,}\b/ },
]

async function walkFiles(dir, limit, out = []) {
  if (out.length >= limit) return out
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (out.length >= limit) return out
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, limit, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

async function scanForSecrets(pkgDir) {
  const hits = []
  const files = await walkFiles(pkgDir, 5000)
  for (const file of files) {
    const info = await stat(file).catch(() => null)
    if (!info || info.size > MAX_SCAN_BYTES) continue
    const text = await readFile(file, "utf8").catch(() => "")
    if (!text) continue
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(text)) {
        hits.push(`${path.relative(pkgDir, file)} contains ${pattern.id} material`)
        break
      }
    }
  }
  return hits
}

async function pathKind(target) {
  const info = await stat(target).catch(() => null)
  if (!info) return "missing"
  if (info.isDirectory()) return "dir"
  if (info.isFile()) return "file"
  return "other"
}

async function dirHasFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && (await dirHasFiles(path.join(dir, entry.name)))) return true
  }
  return false
}

/** Every artifact the manifest references must exist inside the tarball. */
async function missingDeclaredArtifacts(pkgDir, manifest) {
  const missing = []
  for (const entry of manifest.files ?? []) {
    if (typeof entry !== "string" || entry.startsWith("!") || entry.includes("*")) continue
    const target = path.join(pkgDir, entry)
    const kind = await pathKind(target)
    if (kind === "missing") {
      missing.push(`files entry ${entry}`)
    } else if (kind === "dir" && !(await dirHasFiles(target))) {
      missing.push(`files entry ${entry} (empty directory)`)
    }
  }
  for (const [command, target] of Object.entries(binEntries(manifest))) {
    if ((await pathKind(path.join(pkgDir, target))) !== "file") {
      missing.push(`bin ${command} -> ${target}`)
    }
  }
  if (typeof manifest.main === "string" && manifest.main.trim()) {
    const main = manifest.main.replace(/^\.\//, "")
    if ((await pathKind(path.join(pkgDir, main))) !== "file") {
      missing.push(`main ${manifest.main}`)
    }
  }
  for (const target of exportTargets(manifest.exports)) {
    if ((await pathKind(path.join(pkgDir, target))) === "missing") {
      missing.push(`exports ${target}`)
    }
  }
  return missing
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

function runFile(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr
          error.stdout = stdout
          reject(error)
        } else {
          resolve({ stdout, stderr })
        }
      }
    )
  })
}

function shortError(err) {
  const detail = (err?.stderr || err?.message || String(err)).split("\n")[0]
  return detail.slice(0, 300)
}

function emptyReceipt(tarballPath) {
  return {
    tarball: path.resolve(tarballPath),
    sha256: undefined,
    bytes: undefined,
    package: undefined,
    version: undefined,
    fileCount: 0,
    commands: {},
    tools: [],
    checks: [],
    pass: false,
  }
}

/**
 * Inspect one `pnpm pack`/`npm pack` tarball. Returns a receipt object; the
 * receipt lists every check performed and `pass` is true only when all checks
 * succeeded. With `keepExtractDir` the extracted tree is retained at
 * `receipt.extractDir` for a later smoke run; otherwise it is removed.
 */
export async function inspectTarball(tarballPath, { timeoutMs, keepExtractDir = false } = {}) {
  const receipt = emptyReceipt(tarballPath)
  const check = (id, ok, detail) => receipt.checks.push({ id, ok, detail })

  const info = await stat(tarballPath).catch(() => null)
  if (!info?.isFile()) {
    check("archive-readable", false, `tarball not found: ${tarballPath}`)
    return receipt
  }
  receipt.bytes = info.size
  receipt.sha256 = await sha256File(tarballPath)

  let listing
  try {
    const { stdout } = await runFile("tar", ["-tzf", tarballPath], { timeoutMs })
    listing = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (err) {
    check("archive-readable", false, `tar could not list the archive: ${shortError(err)}`)
    return receipt
  }
  check("archive-readable", true, `${listing.length} entries`)

  const nonPackage = listing.filter((entry) => !entry.startsWith("package/"))
  check(
    "package-layout",
    nonPackage.length === 0,
    nonPackage.length === 0
      ? "all entries under package/"
      : `unexpected entries outside package/: ${nonPackage.slice(0, 5).join(", ")}`
  )
  const files = listing
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length))
  receipt.fileCount = files.length

  const forbidden = files
    .map((entry) => ({ entry, reason: forbiddenPathReason(entry) }))
    .filter((hit) => hit.reason)
  check(
    "forbidden-paths",
    forbidden.length === 0,
    forbidden.length === 0
      ? "no .env/credentials.json/node_modules/.git/private-source paths"
      : forbidden
          .slice(0, 8)
          .map((hit) => `${hit.entry} (${hit.reason})`)
          .join("; ")
  )

  const extractDir = await mkdtemp(path.join(tmpdir(), "lyrashield-dist-verify-"))
  try {
    try {
      await runFile("tar", ["-xzf", tarballPath, "-C", extractDir], { timeoutMs })
    } catch (err) {
      check("archive-extracts", false, `tar extract failed: ${shortError(err)}`)
      receipt.pass = receipt.checks.every((item) => item.ok)
      return receipt
    }
    const pkgDir = path.join(extractDir, "package")
    if (keepExtractDir) receipt.extractDir = pkgDir

    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"))
      check("manifest-present", true, "package/package.json parses")
    } catch (err) {
      check("manifest-present", false, `package/package.json unreadable: ${shortError(err)}`)
    }

    if (manifest) {
      receipt.package = manifest.name
      receipt.version = manifest.version
      receipt.commands = binEntries(manifest)
      try {
        validatePublishedManifest(manifest)
        check("manifest-publishable", true, "name/version/deps/files/publishConfig ok")
      } catch (err) {
        check("manifest-publishable", false, err.message)
      }
      const missing = await missingDeclaredArtifacts(pkgDir, manifest)
      check(
        "declared-artifacts",
        missing.length === 0,
        missing.length === 0
          ? "every files/bin/main/exports target exists"
          : `missing: ${missing.join(", ")}`
      )
      const rootFiles = await readdir(pkgDir).catch(() => [])
      const hasReadme = rootFiles.some((entry) => /^readme/i.test(entry))
      check("readme", hasReadme, hasReadme ? "README present" : "no README* file")
    }

    const secretHits = await scanForSecrets(pkgDir)
    check(
      "secret-material",
      secretHits.length === 0,
      secretHits.length === 0
        ? "no private-key or lsk_ token material"
        : secretHits.slice(0, 8).join("; ")
    )
  } finally {
    if (!keepExtractDir) await rm(extractDir, { recursive: true, force: true })
  }
  receipt.pass = receipt.checks.every((item) => item.ok)
  return receipt
}

/* ------------------------------------------------------------------ */
/* --smoke: run the packed artifact itself from a disposable install   */
/* ------------------------------------------------------------------ */

async function workspacePackageDirs(repoDir) {
  const dirs = []
  for (const group of ["packages", "apps"]) {
    const groupDir = path.join(repoDir, group)
    const entries = await readdir(groupDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(groupDir, entry.name))
    }
  }
  return dirs
}

/**
 * Find an installable directory providing package `name`, in order:
 * 1. another extracted tarball under test (e.g. @lyrashield/agent-plugin
 *    packed alongside the CLI — the same artifact that would be published);
 * 2. an installed copy inside any workspace package's node_modules (pnpm
 *    keeps workspace deps as symlinks there, so realpath lands on the real
 *    package and its transitive deps resolve normally);
 * 3. a node_modules copy reachable by walking up from each search root;
 * 4. a workspace package whose manifest.name matches (unpacked fallback).
 */
export async function resolveDependencyDir(
  name,
  { extractedByName, workspaceDirs, repoDir, searchRoots } = {}
) {
  if (extractedByName?.has(name)) return extractedByName.get(name)
  const dirs = workspaceDirs ?? (await workspacePackageDirs(repoDir ?? process.cwd()))
  for (const dir of dirs) {
    const candidate = path.join(dir, "node_modules", name, "package.json")
    if (existsSync(candidate)) return path.dirname(candidate)
  }
  for (const root of searchRoots ?? []) {
    let dir = path.resolve(root)
    while (true) {
      const candidate = path.join(dir, "node_modules", name, "package.json")
      if (existsSync(candidate)) return path.dirname(candidate)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
      if (manifest.name === name) return dir
    } catch {
      // not a package dir — keep looking
    }
  }
  return undefined
}

/**
 * Populate `<pkgDir>/node_modules` with symlinks to resolved dependency
 * directories. Dependencies resolved to another extracted tarball have no
 * node_modules context of their own — Node resolves symlinks to realpaths, so
 * their deps are linked inside the extracted dir itself (recursively), which
 * mirrors what `npm install` would lay down for nested packages.
 * Returns { linked, missing, hoisted }.
 */
export async function linkDependencies(pkgDir, manifest, options = {}) {
  const extractedDirs = new Set(options.extractedByName?.values() ?? [])
  const state = { linked: [], missing: [], hoisted: [], populated: new Set() }
  await populateNodeModules(pkgDir, manifest, options, state, extractedDirs, 0)
  return { linked: state.linked, missing: state.missing, hoisted: state.hoisted }
}

async function populateNodeModules(dir, manifest, options, state, extractedDirs, depth) {
  if (state.populated.has(dir)) return
  state.populated.add(dir)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const source = await resolveDependencyDir(name, options)
    if (!source) {
      state.missing.push(`${name} (required by ${manifest.name ?? path.basename(dir)})`)
      continue
    }
    const dest = path.join(dir, "node_modules", name)
    await mkdir(path.dirname(dest), { recursive: true })
    await rm(dest, { force: true, recursive: true }).catch(() => {})
    await symlink(source, dest, "dir")
    ;(depth === 0 ? state.linked : state.hoisted).push(name)
    if (extractedDirs.has(source)) {
      try {
        const subManifest = JSON.parse(
          await readFile(path.join(source, "package.json"), "utf8")
        )
        await populateNodeModules(source, subManifest, options, state, extractedDirs, depth + 1)
      } catch {
        // extracted dir without a readable manifest — nothing further to link
      }
    }
  }
}

function spawnJson(pkgArgs, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, pkgArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut: false, error: err })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: signal === "SIGKILL" })
    })
  })
}

/**
 * Perform a real MCP `initialize` + `tools/list` exchange against a packed
 * stdio server. Resolves with the tool names the server advertised.
 */
export function mcpToolsList(binPath, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let buffer = ""
    let stderr = ""
    // A server that exits early makes stdin writes raise EPIPE — the close
    // handler already reports the failure.
    child.stdin.on("error", () => {})
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`MCP stdio handshake timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const fail = (err) => {
      clearTimeout(timer)
      child.kill("SIGKILL")
      reject(err)
    }
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "verify-agent-distribution", version: "1" },
        },
      })}\n`
    )
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let response
        try {
          response = JSON.parse(line)
        } catch {
          fail(new Error("MCP server wrote non-JSON-RPC stdout"))
          return
        }
        if (response.id === 1) {
          if (!response.result?.serverInfo) {
            fail(new Error("MCP initialize failed: no serverInfo in response"))
            return
          }
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
          )
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`
          )
        } else if (response.id === 2) {
          const tools = response.result?.tools
          if (!Array.isArray(tools)) {
            fail(new Error("MCP tools/list returned no tools array"))
            return
          }
          clearTimeout(timer)
          child.kill("SIGKILL")
          resolve(tools.map((tool) => tool.name))
          return
        }
      }
    })
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("error", (err) => fail(err))
    child.on("close", (code) => {
      clearTimeout(timer)
      reject(
        new Error(
          `MCP server exited before tools/list (code ${code})${stderr ? `: ${stderr.split("\n")[0].slice(0, 200)}` : ""}`
        )
      )
    })
  })
}

/**
 * Smoke-test one already-extracted packed package:
 * - link declared dependencies from other extracted tarballs / the workspace /
 *   installed node_modules, else a bounded `npm install --omit=dev`;
 * - `lyrashield`: `<bin> --version` must exit 0 and print the manifest
 *   version, `--help` must exit 0;
 * - `@lyrashield/mcp`: stdio initialize + tools/list must return every
 *   EXPECTED_MCP_TOOLS name;
 * - packages without a bin: the `main` module must import cleanly.
 *
 * HOME is redirected to an empty temp dir and a synthetic API key plus an
 * unroutable API URL are supplied, so no real credential or network endpoint
 * is ever used. Returns the list of smoke check results.
 */
export async function smokePackage(pkgDir, manifest, options = {}) {
  const checks = []
  const check = (id, ok, detail) => checks.push({ id, ok, detail })
  // Disposable HOME so the packed artifact never sees the real credential
  // store (~/.lyrashield/credentials.json stays untouched).
  const home = await mkdtemp(path.join(tmpdir(), "lyrashield-smoke-home-"))
  try {
    return await runSmokeChecks(pkgDir, manifest, { ...options, home, check, checks })
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

async function runSmokeChecks(pkgDir, manifest, options) {
  const {
    repoDir = process.cwd(),
    extractedByName = new Map(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    install = true,
    home,
    check,
    checks,
  } = options
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    LYRASHIELD_API_KEY: `lsk_${"A".repeat(24)}`,
    LYRASHIELD_API_URL: "http://127.0.0.1:9",
    LYRASHIELD_LOG_DESTINATION: "stderr",
  }

  const depNames = Object.keys(manifest.dependencies ?? {})
  const { linked, missing, hoisted } = await linkDependencies(pkgDir, manifest, {
    extractedByName,
    workspaceDirs: options.workspaceDirs ?? (await workspacePackageDirs(repoDir)),
    repoDir,
    searchRoots: [pkgDir, repoDir],
  })
  let installNote = ""
  if (missing.length && install) {
    try {
      await runFile("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: pkgDir,
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      })
      installNote = `; npm installed: ${missing.join(", ")}`
    } catch (err) {
      check(
        "smoke:dependencies",
        false,
        `unresolved deps ${missing.join(", ")} and npm install failed: ${shortError(err)}`
      )
      return checks
    }
  } else if (missing.length) {
    check(
      "smoke:dependencies",
      false,
      `unresolved deps (no local package, --no-install): ${missing.join(", ")}`
    )
    return checks
  }
  check(
    "smoke:dependencies",
    true,
    depNames.length
      ? `${linked.length}/${depNames.length} linked offline` +
          (hoisted.length ? ` (+${hoisted.length} transitive)` : "") +
          installNote
      : "no runtime dependencies"
  )

  const bins = binEntries(manifest)
  const binList = Object.entries(bins)
  if (manifest.name === "@lyrashield/mcp") {
    const binPath = path.join(pkgDir, bins["lyrashield-mcp"] ?? Object.values(bins)[0])
    try {
      const tools = await mcpToolsList(binPath, { cwd: pkgDir, env, timeoutMs })
      const missingTools = EXPECTED_MCP_TOOLS.filter((name) => !tools.includes(name))
      check(
        "smoke:mcp-tools",
        missingTools.length === 0,
        missingTools.length === 0
          ? `initialize + tools/list returned ${tools.length} tools`
          : `missing tools: ${missingTools.join(", ")}`
      )
      // recorded for the receipt by the caller
      checks[checks.length - 1].tools = tools
    } catch (err) {
      check("smoke:mcp-tools", false, shortError(err))
    }
  } else if (binList.length) {
    for (const [command, target] of binList) {
      const binPath = path.join(pkgDir, target)
      const version = await spawnJson([binPath, "--version"], { cwd: pkgDir, env, timeoutMs })
      const versionOk =
        version.code === 0 &&
        !version.timedOut &&
        (version.stdout + version.stderr).includes(String(manifest.version))
      check(
        `smoke:${command} --version`,
        versionOk,
        version.timedOut
          ? `timed out after ${timeoutMs}ms`
          : versionOk
            ? `exit 0, prints ${String(manifest.version)}`
            : `exit ${version.code}: ${(version.stdout + version.stderr).split("\n")[0]?.slice(0, 200)}`
      )
      const help = await spawnJson([binPath, "--help"], { cwd: pkgDir, env, timeoutMs })
      const helpOk = help.code === 0 && !help.timedOut
      check(
        `smoke:${command} --help`,
        helpOk,
        help.timedOut
          ? `timed out after ${timeoutMs}ms`
          : helpOk
            ? "exit 0"
            : `exit ${help.code}: ${(help.stdout + help.stderr).split("\n")[0]?.slice(0, 200)}`
      )
    }
  } else if (typeof manifest.main === "string" && manifest.main.trim()) {
    const entry = path.join(pkgDir, manifest.main.replace(/^\.\//, ""))
    const probe = await spawnJson(
      ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${entry}`)})`],
      { cwd: pkgDir, env, timeoutMs }
    )
    check(
      "smoke:import",
      probe.code === 0 && !probe.timedOut,
      probe.code === 0 && !probe.timedOut
        ? `${manifest.main} imports cleanly`
        : probe.timedOut
          ? `import timed out after ${timeoutMs}ms`
          : `import failed: ${(probe.stderr || probe.stdout).split("\n")[0]?.slice(0, 200)}`
    )
  } else {
    check("smoke:entrypoint", true, "no bin/main entrypoint to execute")
  }
  return checks
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const options = {
    tarballs: [],
    json: false,
    smoke: false,
    install: true,
    repoDir: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.split("=", 2)
    const next = () => {
      if (inline !== undefined) return inline
      if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`)
      return argv[++i]
    }
    switch (flag) {
      case "--tarball":
        options.tarballs.push(next())
        break
      case "--json":
        options.json = true
        break
      case "--smoke":
        options.smoke = true
        break
      case "--no-install":
        options.install = false
        break
      case "--repo":
        options.repoDir = path.resolve(next())
        break
      case "--timeout":
        options.timeoutMs = Number(next())
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of milliseconds")
        }
        break
      case "--help":
      case "-h":
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

const USAGE = `Usage: node scripts/verify-agent-distribution.mjs --tarball <pkg.tgz> [options]

Options:
  --tarball <path>   packed tarball to verify (repeatable)
  --smoke            also execute the packed artifact (CLI --version/--help,
                     @lyrashield/mcp stdio initialize + tools/list) in a
                     disposable temp dir with a synthetic credential
  --repo <dir>       repository root used to resolve workspace/node_modules
                     dependencies for --smoke (default: cwd)
  --no-install       never fall back to npm install during --smoke
  --timeout <ms>     per-subprocess bound (default ${DEFAULT_TIMEOUT_MS})
  --json             print machine-readable receipts
  --help             show this message

Never publishes, never installs into a real agent config, never needs
credentials or the network (the optional --smoke npm fallback aside).`

function renderReceipt(receipt) {
  const status = receipt.pass ? "PASS" : "FAIL"
  const lines = []
  const id =
    receipt.package != null ? `${receipt.package}@${receipt.version ?? "?"}` : receipt.tarball
  lines.push(`${receipt.pass ? "✓" : "✗"} ${id} — ${status}`)
  lines.push(`    tarball: ${receipt.tarball}`)
  if (receipt.sha256) {
    lines.push(`    sha256: ${receipt.sha256} (${receipt.bytes} bytes, ${receipt.fileCount} files)`)
  }
  const commands = Object.entries(receipt.commands ?? {})
  if (commands.length) {
    lines.push(`    bin: ${commands.map(([name, target]) => `${name} -> ${target}`).join(", ")}`)
  }
  if (receipt.tools?.length) {
    lines.push(`    tools (${receipt.tools.length}): ${receipt.tools.join(", ")}`)
  }
  for (const item of receipt.checks) {
    lines.push(`    ${item.ok ? "✓" : "✗"} ${item.id}: ${item.detail}`)
  }
  return lines.join("\n")
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help || options.tarballs.length === 0) {
    console.log(USAGE)
    return options.help ? 0 : 2
  }

  // Extract every tarball first so --smoke can link cross-tarball deps such as
  // lyrashield -> @lyrashield/agent-plugin without touching the registry.
  const extractedByName = new Map()
  const receipts = []
  const retained = []
  try {
    for (const tarball of options.tarballs) {
      const receipt = await inspectTarball(tarball, {
        timeoutMs: options.timeoutMs,
        keepExtractDir: options.smoke,
      })
      if (options.smoke && receipt.extractDir) {
        try {
          const manifest = JSON.parse(
            await readFile(path.join(receipt.extractDir, "package.json"), "utf8")
          )
          if (manifest?.name) extractedByName.set(manifest.name, receipt.extractDir)
        } catch {
          // manifest check already recorded on the receipt
        }
        retained.push(path.dirname(receipt.extractDir))
      }
      receipts.push(receipt)
    }

    if (options.smoke) {
      for (const receipt of receipts) {
        if (!receipt.extractDir) continue
        let manifest
        try {
          manifest = JSON.parse(
            await readFile(path.join(receipt.extractDir, "package.json"), "utf8")
          )
        } catch {
          continue
        }
        const smokeChecks = await smokePackage(receipt.extractDir, manifest, {
          repoDir: options.repoDir,
          extractedByName,
          timeoutMs: options.timeoutMs,
          install: options.install,
        })
        for (const item of smokeChecks) {
          receipt.checks.push({ id: item.id, ok: item.ok, detail: item.detail })
          if (item.tools) receipt.tools = item.tools
        }
        receipt.pass = receipt.checks.every((item) => item.ok)
      }
    }
  } finally {
    for (const dir of retained) await rm(dir, { recursive: true, force: true }).catch(() => {})
    for (const receipt of receipts) delete receipt.extractDir
  }

  if (options.json) {
    console.log(JSON.stringify(receipts, null, 2))
  } else {
    for (const receipt of receipts) console.log(renderReceipt(receipt))
  }
  return receipts.every((receipt) => receipt.pass) ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (invokedDirectly && !process.env.VITEST && !process.env.VITEST_WORKER_ID) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  )
}
