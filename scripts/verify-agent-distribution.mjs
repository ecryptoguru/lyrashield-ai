import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

const runFile = promisify(execFile)
const requiredFiles = {
  lyrashield: ["package.json", "bin/lyrashield.mjs", "dist/index.js"],
  "@lyrashield/mcp": ["package.json", "bin/lyrashield-mcp.mjs", "dist/stdio-transport.js"],
  "@lyrashield/agent-plugin": ["package.json", "dist/index.js", "plugin/plugin.json"],
}

export function validatePublishedManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !/^(@[^/]+\/)?[^/\s]+$/.test(manifest.name ?? ""))
    throw new Error("Packed package has no valid name")
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version ?? ""))
    throw new Error(`${manifest.name} has no valid version`)
  for (const [kind, dependencies] of Object.entries({
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  })) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      if (typeof range !== "string" || /^(workspace:|link:|file:)/.test(range))
        throw new Error(`${manifest.name} has unresolved ${kind} ${name}: ${range}`)
    }
  }
}

async function inspectArchive(archive) {
  const { stdout: listed } = await runFile("tar", ["-tzf", archive], { timeout: 15_000 })
  const files = listed.trim().split("\n").map((file) => file.replace(/^package\//, ""))
  const { stdout: manifestText } = await runFile("tar", ["-xOzf", archive, "package/package.json"], {
    timeout: 15_000,
  })
  const manifest = JSON.parse(manifestText)
  validatePublishedManifest(manifest)
  const required = requiredFiles[manifest.name]
  if (!required) throw new Error(`Unexpected package ${manifest.name}`)
  for (const file of required) {
    if (!files.includes(file)) throw new Error(`${manifest.name} tarball missing ${file}`)
  }
  const forbidden = files.filter((file) =>
    /(^|\/)(?:\.env(?:\..*)?|node_modules|\.git|\.npmrc|\.pnpm-store|\.turbo|coverage)(?:\/|$)/i.test(file)
  )
  if (forbidden.length) throw new Error(`${manifest.name} tarball contains forbidden files: ${forbidden.join(", ")}`)
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex")
  return { archive, manifest, files, sha256 }
}

async function run(file, args, options = {}) {
  const { stdout, stderr } = await runFile(file, args, {
    ...options,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return { stdout, stderr }
}

async function mcpTools(bin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => finish(new Error("Packed MCP stdio exchange timed out")), 20_000)
    function finish(error, tools) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(tools)
    }
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, 3000) })
    child.on("error", (error) => finish(error))
    child.on("close", () => {
      if (!settled) finish(new Error(`Packed MCP exited before tools/list: ${stderr}`))
    })
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let response
        try { response = JSON.parse(line) } catch { finish(new Error("Packed MCP wrote non-JSON stdout")); return }
        if (response.id === 1) {
          if (!response.result?.serverInfo) { finish(new Error("Packed MCP initialize failed")); return }
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`)
        } else if (response.id === 2) {
          if (!Array.isArray(response.result?.tools)) { finish(new Error("Packed MCP tools/list failed")); return }
          finish(null, response.result.tools.map((tool) => tool.name))
          return
        }
      }
    })
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "distribution-smoke", version: "1" } },
    })}\n`)
  })
}

export async function verifyAgentDistribution({ cli, mcp, plugin, sourceSha } = {}) {
  if (![cli, mcp, plugin].every(Boolean)) throw new Error("Pass --cli, --mcp and --plugin tarball paths")
  const packages = await Promise.all([cli, mcp, plugin].map((archive) => inspectArchive(path.resolve(archive))))
  const byName = Object.fromEntries(packages.map((item) => [item.manifest.name, item]))
  for (const name of Object.keys(requiredFiles)) if (!byName[name]) throw new Error(`Missing ${name} tarball`)
  const cliPluginRange = byName.lyrashield.manifest.dependencies?.["@lyrashield/agent-plugin"]
  if (!cliPluginRange || !cliPluginRange.includes(byName["@lyrashield/agent-plugin"].manifest.version))
    throw new Error(`CLI plugin dependency ${cliPluginRange} does not select packed plugin ${byName["@lyrashield/agent-plugin"].manifest.version}`)

  const directory = await mkdtemp(path.join(tmpdir(), "lyrashield-distribution-"))
  const home = path.join(directory, "home")
  const install = path.join(directory, "install")
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url?.startsWith("/api/v1/connections?")) {
      response.end(JSON.stringify({ success: true, data: [] }))
    } else if (request.url?.startsWith("/api/v1/scans/fixture-scan/quality?")) {
      response.end(JSON.stringify({
        success: true,
        data: {
          version: "lyrashield-scan-quality/1.0.0",
          facts: {
            scanStatus: "COMPLETED", scanMode: "QUICK",
            findings: { total: 0 }, coverage: { receiptsTotal: 1 },
            evidence: { manifestPresent: true, manifestChecksum: "fixture-checksum" },
          },
          estimates: {}, parity: {}, surfaceChecksum: "fixture-surface",
        },
      }))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "fixture route not found" } }))
    }
  })
  try {
    await mkdir(home, { recursive: true })
    await mkdir(install, { recursive: true })
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()))
    const apiUrl = `http://127.0.0.1:${server.address().port}`
    const env = {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      npm_config_userconfig: path.join(directory, "npmrc"),
      npm_config_globalconfig: path.join(directory, "global-npmrc"),
      npm_config_cache: path.join(directory, "npm-cache"),
      npm_config_registry: "https://registry.npmjs.org",
      LYRASHIELD_API_KEY: `lsk_${"A".repeat(24)}`,
      LYRASHIELD_API_URL: apiUrl,
      NO_COLOR: "1",
    }
    await writeFile(path.join(install, "package.json"), '{"private":true,"type":"module"}\n')
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packages.map((item) => item.archive)], { cwd: install, env, timeout: 120_000 })
    const cliBin = path.join(install, "node_modules", "lyrashield", "bin", "lyrashield.mjs")
    const mcpBin = path.join(install, "node_modules", "@lyrashield", "mcp", "bin", "lyrashield-mcp.mjs")
    const version = await run(process.execPath, [cliBin, "--version"], { cwd: install, env })
    assert.match(version.stdout, new RegExp(`lyrashield-cli/${byName.lyrashield.manifest.version.replaceAll(".", "\\.")}`))
    const help = await run(process.execPath, [cliBin, "--help"], { cwd: install, env })
    for (const command of ["quality", "connections", "scan", "mcp", "preflight", "cancel", "attachments"])
      assert.match(help.stderr, new RegExp(command))
    const beforeDryRun = await readdir(home, { recursive: true })
    const dryRun = await run(process.execPath, [cliBin, "install", "cursor", "--dry-run", "--json"], { cwd: install, env })
    assert.equal(JSON.parse(dryRun.stdout).ok, true)
    assert.deepEqual(await readdir(home, { recursive: true }), beforeDryRun, "Installer dry-run wrote into HOME")
    const connections = await run(process.execPath, [cliBin, "connections", "list", "--workspace", "fixture", "--json"], { cwd: install, env })
    assert.deepEqual(JSON.parse(connections.stdout), { ok: true, data: { connections: [] } })
    const credentialsDir = path.join(home, ".lyrashield")
    await mkdir(credentialsDir, { recursive: true })
    await writeFile(path.join(credentialsDir, "credentials.json"), JSON.stringify({ workspaceId: "fixture" }))
    const quality = await run(process.execPath, [cliBin, "quality", "fixture-scan", "--json"], { cwd: install, env })
    assert.equal(JSON.parse(quality.stdout).data.version, "lyrashield-scan-quality/1.0.0")
    const gitDir = path.join(directory, "git-fixture")
    await run("git", ["init", "--quiet", gitDir], { cwd: install, env })
    await writeFile(path.join(gitDir, "demo.js"), "export const safe = true\n")
    await run("git", ["add", "demo.js"], { cwd: gitDir, env })
    await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd: gitDir, env })
    await writeFile(path.join(gitDir, "demo.js"), "export const unsafe = ev" + "al('1')\n")
    await run("git", ["add", "demo.js"], { cwd: gitDir, env })
    const diff = await run(process.execPath, [cliBin, "check-diff", "--staged", "--json"], { cwd: gitDir, env })
    assert.equal(JSON.parse(diff.stdout).data.advisory, true)
    assert.ok(JSON.parse(diff.stdout).data.findings.length > 0, "Packed CLI diff analyzer missed fixture")
    const tools = await mcpTools(mcpBin, env)
    for (const tool of [
      "lyrashield_get_scan_quality",
      "lyrashield_run_pr_scan",
      "lyrashield_get_scan_status",
      "lyrashield_get_scan_eligibility",
      "lyrashield_list_scan_attachments",
      "lyrashield_upload_scan_attachment",
      "lyrashield_delete_scan_attachment",
      "lyrashield_cancel_scan",
      "lyrashield_request_fix_pr",
    ])
      assert.ok(tools.includes(tool), `Packed MCP missing ${tool}`)
    const http = await run(process.execPath, ["--input-type=module", "-e", `
      import { handleRemoteMcpRequest } from '@lyrashield/mcp'
      const request = new Request('http://127.0.0.1/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'distribution-smoke', version: '1' },
        } }),
      })
      const response = await handleRemoteMcpRequest(request, {
        toolContext: { apiBaseUrl: 'http://127.0.0.1', apiKey: ['lsk', 'fixture'].join('_') },
      })
      const body = await response.text()
      if (response.status !== 200 || !body.includes('2025-06-18')) process.exit(1)
      process.stdout.write(JSON.stringify({ status: response.status, protocol: '2025-06-18' }))
    `], { cwd: install, env })
    const httpReceipt = JSON.parse(http.stdout)
    return {
      sourceSha: sourceSha ?? null,
      node: process.version,
      packages: packages.map(({ manifest, sha256, files }) => ({
        name: manifest.name, version: manifest.version, sha256, fileCount: files.length,
        dependencies: manifest.dependencies ?? {},
      })),
      cli: { version: version.stdout.trim(), checked: ["help", "install cursor --dry-run --json", "connections list --json", "quality --json", "check-diff --staged --json"] },
      mcp: { toolCount: tools.length, tools, http: httpReceipt },
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "")
    if (!key || !["cli", "mcp", "plugin", "sourceSha"].includes(key) || !args[index + 1])
      throw new Error("Usage: node scripts/verify-agent-distribution.mjs --cli cli.tgz --mcp mcp.tgz --plugin plugin.tgz [--sourceSha SHA]")
    options[key] = args[index + 1]
  }
  console.log(JSON.stringify(await verifyAgentDistribution(options), null, 2))
}
