/* eslint-disable security/detect-non-literal-fs-filename -- All variable filesystem paths are confined to the owned staging directory or trusted client config. */
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REGISTRY = "https://registry.npmjs.org"
const PACKAGE = "@lyrashield/mcp"
const SYNTHETIC_KEY = `lsk_${"A".repeat(24)}`
export const LIMITS = Object.freeze({
  registryMs: 15_000,
  archiveMs: 60_000,
  processMs: 60_000,
  handshakeMs: 30_000,
  terminateMs: 2_000,
  metadataBytes: 1024 * 1024,
  archiveBytes: 32 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024,
  frameBytes: 1024 * 1024,
  stderrBytes: 16 * 1024,
})

// marketplace-stdio/1: supported discovery, review and scan-start inputs.
// Additional tools and optional properties remain compatible.
export const REQUIRED_TOOLS = Object.freeze({
  lyrashield_list_workspaces: { required: [], properties: {} },
  lyrashield_list_targets: {
    required: ["workspaceId"],
    properties: { workspaceId: "string", cursor: "string", limit: "integer" },
  },
  lyrashield_get_scan_status: {
    required: ["workspaceId"],
    properties: { workspaceId: "string", scanId: "string" },
  },
  lyrashield_get_scan_quality: {
    required: ["workspaceId", "scanId"],
    properties: { workspaceId: "string", scanId: "string" },
  },
  lyrashield_get_findings: {
    required: ["workspaceId"],
    properties: { workspaceId: "string", cursor: "string", limit: "integer" },
  },
  lyrashield_get_launch_readiness: {
    required: ["workspaceId", "targetId"],
    properties: { workspaceId: "string", targetId: "string" },
  },
  lyrashield_check_diff: { required: ["diff"], properties: { diff: "string" } },
  lyrashield_explain_finding: {
    required: ["workspaceId", "findingId"],
    properties: { workspaceId: "string", findingId: "string" },
  },
  lyrashield_generate_fix_plan: {
    required: ["workspaceId", "findingId"],
    properties: { workspaceId: "string", findingId: "string" },
  },
  lyrashield_create_pr_security_recap: {
    required: ["workspaceId", "targetId"],
    properties: { workspaceId: "string", targetId: "string" },
  },
  lyrashield_scan_target: {
    required: ["workspaceId"],
    properties: {
      workspaceId: "string",
      targetId: "string",
      repo: "string",
      auto: "boolean",
      idempotencyKey: "string",
    },
  },
})

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

export function validateCatalog(tools) {
  if (!Array.isArray(tools)) throw new Error("published MCP tool catalog is incomplete")
  const catalog = new Map()
  for (const tool of tools) {
    if (
      !object(tool) ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
      catalog.has(tool.name)
    ) {
      throw new Error("published MCP tool catalog has invalid or duplicate names")
    }
    const schema = tool.inputSchema
    if (
      !object(schema) ||
      schema.type !== "object" ||
      !object(schema.properties) ||
      (schema.required !== undefined &&
        (!Array.isArray(schema.required) ||
          schema.required.some(
            (key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key)
          )))
    ) {
      throw new Error(`published MCP tool schema is invalid: ${tool.name}`)
    }
    catalog.set(tool.name, schema)
  }
  for (const [name, contract] of Object.entries(REQUIRED_TOOLS)) {
    const schema = catalog.get(name)
    if (!schema) throw new Error(`published MCP tool catalog is missing ${name}`)
    const required = schema.required ?? []
    if (
      contract.required.some((key) => !required.includes(key)) ||
      required.some((key) => !contract.required.includes(key)) ||
      Object.entries(contract.properties).some(
        ([key, type]) => schema.properties[key]?.type !== type
      )
    ) {
      throw new Error(`published MCP tool schema is incompatible: ${name}`)
    }
  }
}

export async function isolatedEnvironment(directory) {
  const locations = ["home", "config", "cache", "tmp", "install"]
  await Promise.all(
    locations.map((name) => mkdir(path.join(directory, name), { recursive: true, mode: 0o700 }))
  )
  const userconfig = path.join(directory, "user.npmrc")
  const globalconfig = path.join(directory, "global.npmrc")
  await Promise.all([userconfig, globalconfig].map((file) => writeFile(file, "", { mode: 0o600 })))
  return {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: path.join(directory, "home"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    TMPDIR: path.join(directory, "tmp"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: path.join(directory, "cache", "npm"),
    npm_config_prefix: path.join(directory, "install"),
    npm_config_registry: REGISTRY,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    LYRASHIELD_API_KEY: SYNTHETIC_KEY,
    LYRASHIELD_API_URL: "http://127.0.0.1:9",
  }
}

export function redactDiagnostic(value) {
  return value
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(?:lsk_|sk-|gh[pousr]_|npm_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(token|secret|password|authorization|api[_-]?key)\s*[=:]\s*[^\s]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
}

// The deadline settles independently of 'close': descendants can retain pipes.
// Every process gets its own POSIX group; signals never target another task.
export function runOwnedProcess(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs = LIMITS.processMs,
    terminateMs = LIMITS.terminateMs,
    outputBytes = LIMITS.outputBytes,
    stderrBytes = LIMITS.stderrBytes,
    onStart,
    onStdout,
    label = "MCP process",
  } = {}
) {
  if (process.platform === "win32")
    throw new Error("MCP verification requires POSIX process groups")
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let finished = false
    let settled = false
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let stderrTotal = 0
    let stdoutTotal = 0
    let escalation
    const deadline = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs)
    const signalGroup = (signal) => {
      if (!child.pid) return false
      try {
        process.kill(-child.pid, signal)
        return true
      } catch (error) {
        if (error.code !== "ESRCH") return true
        return false
      }
    }
    const settle = (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(escalation)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      const diagnostic = redactDiagnostic(stderr.toString("utf8"))
      if (error)
        reject(
          new Error(
            `${redactDiagnostic(error.message)}${diagnostic ? `; stderr: ${diagnostic}` : ""}`
          )
        )
      else resolve({ stdout: stdout.toString("utf8"), stderr: diagnostic })
    }
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      child.stdin.end()
      if (!signalGroup("SIGTERM")) {
        settle(error)
        return
      }
      escalation = setTimeout(() => {
        signalGroup("SIGKILL")
        settle(error)
      }, terminateMs)
      child.once("exit", () => {
        if (!signalGroup(0)) settle(error)
      })
    }
    const complete = () => finish()
    child.stdin.on("error", () => finish(new Error(`${label} stdin failed`)))
    child.stdout.on("error", () => finish(new Error(`${label} stdout failed`)))
    child.stderr.on("error", () => finish(new Error(`${label} stderr failed`)))
    child.on("error", () => finish(new Error(`${label} could not start`)))
    child.on("exit", (code, signal) => {
      if (!finished)
        finish(
          code === 0 && !onStdout
            ? undefined
            : new Error(`${label} exited before completion (${code ?? signal})`)
        )
    })
    child.stderr.on("data", (chunk) => {
      stderrTotal += chunk.length
      stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, stderrBytes - stderr.length))])
      if (stderrTotal > outputBytes) finish(new Error(`${label} stderr exceeded output limit`))
    })
    child.stdout.on("data", (chunk) => {
      if (finished) return
      stdoutTotal += chunk.length
      if (stdoutTotal > outputBytes) {
        finish(new Error(`${label} stdout exceeded output limit`))
        return
      }
      try {
        if (onStdout) onStdout(chunk, child, complete)
        else stdout = Buffer.concat([stdout, chunk])
      } catch (error) {
        finish(new Error(error.message))
      }
    })
    try {
      onStart?.(child)
    } catch {
      finish(new Error(`${label} stdin failed`))
    }
  })
}

export async function boundedFetch(url, { maxBytes, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController()
  let timer
  let reader
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("registry acquisition timed out"))
      controller.abort()
    }, timeoutMs)
  })
  const acquire = async () => {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "error" })
    if (!response.ok) throw new Error(`pinned MCP package is unavailable: HTTP ${response.status}`)
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new Error("registry response exceeded byte limit")
    reader = response.body?.getReader()
    if (!reader) throw new Error("registry response has no body")
    const chunks = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error("registry response exceeded byte limit")
      chunks.push(value)
    }
    return Buffer.concat(chunks, length)
  }
  try {
    return await Promise.race([acquire(), deadline])
  } finally {
    clearTimeout(timer)
    controller.abort()
    // Cancellation may itself stall; it must never hold the deadline open.
    if (reader) void reader.cancel().catch(() => {})
  }
}

export function verifyIntegrity(archive, expected) {
  if (
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected ?? "") ||
    `sha512-${createHash("sha512").update(archive).digest("base64")}` !== expected
  ) {
    throw new Error("published MCP package integrity differs")
  }
}

export function ownedArchivePath(directory, filename) {
  if (
    typeof filename !== "string" ||
    !/^[A-Za-z0-9._-]+\.tgz$/.test(filename) ||
    path.basename(filename) !== filename
  ) {
    throw new Error("packed MCP archive path is outside staging directory")
  }
  return path.join(directory, filename)
}

export async function verifyStdio(command, args, options) {
  let buffer = Buffer.alloc(0)
  let phase = 1
  const send = (child, message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  await runOwnedProcess(command, args, {
    ...options,
    timeoutMs: options?.timeoutMs ?? LIMITS.handshakeMs,
    label: "published MCP handshake",
    onStart: (child) =>
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "marketplace-release-check", version: "1" },
        },
      }),
    onStdout: (chunk, child, complete) => {
      buffer = Buffer.concat([buffer, chunk])
      let end
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > (options?.frameBytes ?? LIMITS.frameBytes))
          throw new Error("published MCP frame exceeded byte limit")
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        let message
        try {
          message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))
        } catch {
          throw new Error("published MCP wrote non-JSON-RPC stdout")
        }
        if (
          !object(message) ||
          message.jsonrpc !== "2.0" ||
          message.id !== phase ||
          !Object.hasOwn(message, "result") ||
          Object.hasOwn(message, "error") ||
          Object.hasOwn(message, "method") ||
          !object(message.result)
        ) {
          throw new Error("published MCP returned invalid JSON-RPC response")
        }
        if (phase === 1) {
          const result = message.result
          if (
            result.protocolVersion !== "2025-06-18" ||
            !object(result.serverInfo) ||
            typeof result.serverInfo.name !== "string" ||
            !result.serverInfo.name ||
            typeof result.serverInfo.version !== "string" ||
            !result.serverInfo.version ||
            !object(result.capabilities) ||
            !object(result.capabilities.tools)
          ) {
            throw new Error("published MCP initialization failed")
          }
          phase = 2
          send(child, { jsonrpc: "2.0", method: "notifications/initialized" })
          send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        } else if (phase === 2) {
          if (message.result.nextCursor !== undefined)
            throw new Error("published MCP tool catalog is paginated")
          validateCatalog(message.result.tools)
          phase = 3
        } else throw new Error("published MCP returned unexpected response")
      }
      if (buffer.length > (options?.frameBytes ?? LIMITS.frameBytes))
        throw new Error("published MCP frame exceeded byte limit")
      if (phase === 3) {
        if (buffer.length) throw new Error("published MCP wrote a trailing incomplete frame")
        complete()
      }
    },
  })
}

export async function verifyPublishedMcp({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  fetchImpl = fetch,
  npmCommand = "npm",
  limits = LIMITS,
} = {}) {
  const kiro = JSON.parse(await readFile(path.join(root, ".mcp.kiro.json"), "utf8"))
  const spec = kiro.mcpServers?.lyrashield?.args?.[1]
  if (!/^@lyrashield\/mcp@\d+\.\d+\.\d+$/.test(spec ?? ""))
    throw new Error("Kiro must pin an immutable LyraShield MCP package")
  const version = spec.slice(`${PACKAGE}@`.length)
  const metadata = JSON.parse(
    (
      await boundedFetch(`${REGISTRY}/@lyrashield%2fmcp/${version}`, {
        maxBytes: limits.metadataBytes,
        timeoutMs: limits.registryMs,
        fetchImpl,
      })
    ).toString("utf8")
  )
  if (metadata.name !== PACKAGE || metadata.version !== version)
    throw new Error("published MCP package identity differs from the client pin")
  const tarball = new URL(metadata.dist?.tarball)
  if (
    tarball.origin !== REGISTRY ||
    tarball.username ||
    tarball.password ||
    tarball.search ||
    tarball.hash ||
    tarball.pathname !== `/@lyrashield/mcp/-/mcp-${version}.tgz`
  )
    throw new Error("published MCP archive must use the controlled registry")
  const archive = await boundedFetch(tarball.href, {
    maxBytes: limits.archiveBytes,
    timeoutMs: limits.archiveMs,
    fetchImpl,
  })
  verifyIntegrity(archive, metadata.dist?.integrity)
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lyrashield-mcp-release-")))
  try {
    const env = await isolatedEnvironment(directory)
    const acquired = path.join(directory, "verified.tgz")
    await writeFile(acquired, archive, { mode: 0o600 })
    const processOptions = {
      cwd: directory,
      env,
      timeoutMs: limits.processMs,
      terminateMs: limits.terminateMs,
      outputBytes: limits.outputBytes,
      stderrBytes: limits.stderrBytes,
    }
    const { stdout } = await runOwnedProcess(
      npmCommand,
      [
        "pack",
        acquired,
        "--ignore-scripts",
        "--json",
        `--registry=${REGISTRY}`,
        "--pack-destination",
        directory,
      ],
      { ...processOptions, label: "npm pack" }
    )
    let packed
    try {
      const entries = JSON.parse(stdout)
      if (Array.isArray(entries) && entries.length === 1) [packed] = entries
    } catch {}
    if (packed?.name !== PACKAGE || packed?.version !== version || !Array.isArray(packed.files))
      throw new Error("packed MCP package identity differs from the client pin")
    const files = new Set(packed.files.map((file) => file.path))
    for (const required of ["package.json", "dist/stdio-transport.js", "bin/lyrashield-mcp.mjs"]) {
      if (!files.has(required)) throw new Error(`packed MCP package is missing ${required}`)
    }
    const packedPath = ownedArchivePath(directory, packed.filename)
    if (
      (await stat(packedPath)).size > limits.archiveBytes ||
      (await realpath(packedPath)) !== packedPath
    )
      throw new Error("packed MCP archive is outside byte/path limits")
    verifyIntegrity(await readFile(packedPath), metadata.dist.integrity)
    const install = path.join(directory, "install")
    await runOwnedProcess(
      npmCommand,
      [
        "install",
        packedPath,
        "--prefix",
        install,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        `--registry=${REGISTRY}`,
      ],
      { ...processOptions, label: "npm install" }
    )
    const packageRoot = path.join(install, "node_modules", "@lyrashield", "mcp")
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
    if (
      packageJson.name !== PACKAGE ||
      packageJson.version !== version ||
      packageJson.bin?.["lyrashield-mcp"] !== "bin/lyrashield-mcp.mjs"
    )
      throw new Error("installed MCP package identity or entrypoint differs")
    const entrypoint = path.join(packageRoot, "bin", "lyrashield-mcp.mjs")
    if ((await realpath(entrypoint)) !== entrypoint)
      throw new Error("installed MCP entrypoint escapes staging directory")
    await verifyStdio(process.execPath, [entrypoint], {
      cwd: install,
      env,
      timeoutMs: limits.handshakeMs,
      terminateMs: limits.terminateMs,
      outputBytes: limits.outputBytes,
      stderrBytes: limits.stderrBytes,
      frameBytes: limits.frameBytes,
    })
    return spec
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const spec = await verifyPublishedMcp()
  console.log(
    `Verified published ${spec}: integrity, local entrypoint and marketplace-stdio/1 tools`
  )
}
